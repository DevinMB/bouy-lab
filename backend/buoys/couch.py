import httpx
import logging
from buoys.config import CFG

log = logging.getLogger(__name__)

HIGH_SENTINEL = "\ufff0"  # sorts above any printable _id

DESIGN_DOC = {
    "_id": "_design/buoys",
    "views": {
        "series": {
            "map": (
                "function (doc) {"
                "  if (doc.type === 'observation') {"
                "    emit([doc.stationId, doc.stream, doc.ts], doc.values);"
                "  }"
                "}"
            )
        },
        "latest": {
            "map": (
                "function (doc) {"
                "  if (doc.type === 'latest') emit(doc.stationId, null);"
                "}"
            )
        },
        # Time-bucketed stats per (stream, field). Emits each numeric field into
        # an hourly bucket; _stats reduce gives sum/count/min/max per bucket for
        # fast network-wide trend queries via group=true.
        "trend": {
            "map": (
                "function (doc) {"
                "  if (doc.type === 'observation' && doc.values) {"
                "    var b = Math.floor(doc.ts / 3600) * 3600;"
                "    for (var f in doc.values) {"
                "      var v = doc.values[f];"
                "      if (typeof v === 'number') emit([doc.stream, f, b], v);"
                "    }"
                "  }"
                "}"
            ),
            "reduce": "_stats",
        },
    },
}


def _obs_prefix(station_id: str, stream: str) -> str:
    """The _id prefix shared by every observation of one station's stream."""
    return f"obs:{station_id}:{stream}:"


class CouchClient:
    def __init__(self, url: str, database: str, user: str, password: str):
        self._base = url.rstrip("/")
        self._db = database
        self._auth = (user, password)
        self._client: httpx.AsyncClient = None

    async def __aenter__(self):
        self._client = httpx.AsyncClient(
            auth=self._auth,
            timeout=30.0,
        )
        return self

    async def __aexit__(self, *args):
        if self._client:
            await self._client.aclose()

    def _url(self, path: str = "") -> str:
        return self._url_in(self._db, path)

    def _url_in(self, database: str, path: str = "") -> str:
        """Same server and credentials, a different database.

        hourly: documents live in their own database so retention can be "drop
        the database" rather than pruning millions of docs. Rather than thread a
        second client through every call site, one client addresses the sibling
        db -- same connection pool, same auth.
        """
        return f"{self._base}/{database}{path}"

    async def ensure_db_and_views(self) -> None:
        # Create database (ignore 412 = already exists)
        resp = await self._client.put(f"{self._base}/{self._db}")
        if resp.status_code not in (201, 202, 412):
            log.warning("Unexpected status creating db: %s", resp.status_code)

        # Only write design doc when content has actually changed — each unnecessary
        # write invalidates the view index and triggers a full rebuild.
        existing = await self._client.get(self._url("/_design/buoys"))
        doc = dict(DESIGN_DOC)
        if existing.status_code == 200:
            existing_doc = existing.json()
            existing_views = existing_doc.get("views", {})
            if existing_views == doc.get("views", {}):
                return  # Unchanged — leave the view index alone
            doc["_rev"] = existing_doc.get("_rev")

        resp = await self._client.put(
            self._url("/_design/buoys"),
            json=doc,
        )
        if resp.status_code not in (201, 202, 409):
            log.warning("Unexpected status writing design doc: %s %s", resp.status_code, resp.text)

    async def get(self, doc_id: str):
        resp = await self._client.get(self._url(f"/{doc_id}"))
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()

    async def put(self, doc: dict) -> dict:
        doc_id = doc["_id"]
        resp = await self._client.put(self._url(f"/{doc_id}"), json=doc)
        resp.raise_for_status()
        return resp.json()

    async def upsert(self, doc: dict) -> dict:
        existing = await self.get(doc["_id"])
        if existing:
            doc = {**doc, "_rev": existing["_rev"]}
        try:
            return await self.put(doc)
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 409:
                # Race — re-fetch rev and retry once
                existing = await self.get(doc["_id"])
                if existing:
                    doc = {**doc, "_rev": existing["_rev"]}
                return await self.put(doc)
            raise

    async def upsert_observation(self, obs: dict) -> None:
        doc_id = f"obs:{obs['stationId']}:{obs['stream']}:{obs['ts']}"
        try:
            await self.put({**obs, "_id": doc_id, "type": "observation"})
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 409:
                pass  # Already exists — idempotent
            else:
                raise

    async def upsert_station(self, station: dict) -> None:
        doc_id = f"station:{station['stationId']}"
        await self.upsert({**station, "_id": doc_id, "type": "station"})

    async def upsert_latest_if_newer(
        self, station_id: str, stream: str, obs: dict, station_meta: dict
    ) -> None:
        doc_id = f"latest:{station_id}"
        incoming_ts = obs.get("ts", 0)
        values = obs.get("values", {})

        for attempt in range(2):
            existing = await self.get(doc_id)
            if existing and existing.get("ts", 0) >= incoming_ts:
                return

            # Build or update the latest doc
            if existing:
                doc = dict(existing)
                streams = doc.get("streams", {})
            else:
                doc = {
                    "_id": doc_id,
                    "type": "latest",
                    "stationId": station_id,
                    "name": station_meta.get("name", station_id),
                    "lat": station_meta.get("lat"),
                    "lon": station_meta.get("lon"),
                    "owner": station_meta.get("owner"),
                    "ttype": station_meta.get("ttype"),
                    "available": station_meta.get("available", []),
                    "streams": {},
                }
                streams = {}

            streams[stream] = {"ts": incoming_ts, "values": values}
            doc["streams"] = streams
            doc["ts"] = incoming_ts
            doc["observedAt"] = obs.get("observedAt")

            # Water temp precedence: standard first, then ocean
            std_temp = streams.get("standard", {}).get("values", {}).get("waterTemperature")
            ocean_temp = streams.get("ocean", {}).get("values", {}).get("waterTemperature")
            doc["waterTempC"] = std_temp if std_temp is not None else ocean_temp

            # Update location/meta from station if available
            if station_meta.get("lat") is not None:
                doc["lat"] = station_meta["lat"]
                doc["lon"] = station_meta["lon"]
            if station_meta.get("name"):
                doc["name"] = station_meta["name"]
            if station_meta.get("owner"):
                doc["owner"] = station_meta["owner"]
            if station_meta.get("ttype"):
                doc["ttype"] = station_meta["ttype"]
            if station_meta.get("available"):
                doc["available"] = station_meta["available"]

            try:
                await self.put(doc)
                return
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 409 and attempt == 0:
                    continue
                raise

    async def _all_docs_range(
        self, prefix: str, descending: bool = False, limit: int = None
    ) -> list:
        """Fetch every doc whose _id starts with `prefix`, off the primary index.

        The map-reduce views live in a separate index that can lag or corrupt
        (see get_trend). Document ids are prefix-ordered, so wherever a view
        existed only to order documents by their id components, an _id range
        over the always-current primary index does the same job and is faster.
        """
        return await self._all_docs_between(prefix, prefix + HIGH_SENTINEL,
                                            descending, limit)

    async def _all_docs_between(
        self, lo: str, hi: str, descending: bool = False,
        limit: int = None, database: str = None,
    ) -> list:
        """Fetch docs with lo <= _id <= hi off the primary index of `database`."""
        import json as _json
        params = {
            "startkey": _json.dumps(hi if descending else lo),
            "endkey": _json.dumps(lo if descending else hi),
            "include_docs": "true",
        }
        if descending:
            params["descending"] = "true"
        if limit is not None:
            params["limit"] = limit
        url = self._url_in(database, "/_all_docs") if database else self._url("/_all_docs")
        resp = await self._client.get(url, params=params)
        if resp.status_code == 404:
            return []
        resp.raise_for_status()
        return [row["doc"] for row in resp.json().get("rows", []) if row.get("doc")]

    async def get_hourly_series(
        self, station_id: str, stream: str, field: str, t0: int, t1: int
    ) -> dict:
        """{hour: last} for one (station, stream, field) over [t0, t1].

        `last` is the newest reading in the hour, which is exactly what the
        trend code has always used ("newest per hour per station"). The hour is
        the final _id segment and a fixed-width 10-digit epoch, so an _id range
        IS an hour range -- the same invariant the obs: scans rest on.

        Unlike get_series this has no point cap, so it does not silently
        truncate long windows the way `min(1000, max(48, hours + 12))` does.
        """
        docs = await self._all_docs_between(
            f"hourly:{station_id}:{stream}:{field}:{t0}",
            f"hourly:{station_id}:{stream}:{field}:{t1}",
            database=CFG.COUCHDB_HOURLY_DATABASE,
        )
        out = {}
        for d in docs:
            hour, last = d.get("hour"), d.get("last")
            if hour is None or last is None:
                continue
            try:
                out[hour] = float(last)
            except (TypeError, ValueError):
                continue
        return out

    async def all_docs_rows(
        self, startkey: str, endkey: str, database: str,
        limit: int = None, inclusive_end: bool = True,
    ) -> list:
        """Raw _all_docs rows ({id, key, value: {rev}}) WITHOUT doc bodies.

        For retention work: the id and current rev are all `_purge` needs, so
        fetching bodies would multiply the transfer for nothing.
        """
        import json as _json
        params = {"startkey": _json.dumps(startkey), "endkey": _json.dumps(endkey)}
        if limit is not None:
            params["limit"] = limit
        if not inclusive_end:
            params["inclusive_end"] = "false"
        resp = await self._client.get(self._url_in(database, "/_all_docs"), params=params)
        resp.raise_for_status()
        return resp.json().get("rows", [])

    async def purge(self, revs_by_id: dict, database: str) -> dict:
        """POST /{db}/_purge -- removes documents outright, leaving no tombstone.

        Callers must batch to the server's [purge] max_document_id_number
        (default 100 ids per request).
        """
        resp = await self._client.post(self._url_in(database, "/_purge"), json=revs_by_id)
        resp.raise_for_status()
        return resp.json()

    async def get_daily_series(
        self, station_id: str, stream: str, field: str, d0: int, d1: int
    ) -> dict:
        """{day: (nInDay, meanInDay)} for one (station, stream, field) over [d0, d1].

        `day` is UTC midnight in epoch seconds and the final _id segment, so the
        _id range is a day range. meanInDay is a true mean over every reading
        that day (Flink builds it from raw readings, not from hourly means);
        nInDay is returned alongside so callers can combine days weighted by n.
        """
        docs = await self._all_docs_between(
            f"daily:{station_id}:{stream}:{field}:{d0}",
            f"daily:{station_id}:{stream}:{field}:{d1}",
            database=CFG.COUCHDB_DAILY_DATABASE,
        )
        out = {}
        for d in docs:
            day, mean, n = d.get("day"), d.get("meanInDay"), d.get("nInDay")
            if day is None or mean is None or not n:
                continue
            try:
                out[day] = (int(n), float(mean))
            except (TypeError, ValueError):
                continue
        return out

    async def get_hourly_multi(
        self, station_id: str, stream: str, fields: list, t0: int, t1: int
    ) -> dict:
        """{field: {hour: last}} -- one range query per field, run concurrently."""
        import asyncio as _asyncio
        results = await _asyncio.gather(*[
            self.get_hourly_series(station_id, stream, f, t0, t1) for f in fields
        ])
        return dict(zip(fields, results))


    async def get_all_latest(self) -> list:
        # Range scan rather than the `latest` view: the same documents, always
        # current, and unaffected by the state of the view index.
        return await self._all_docs_range("latest:")

    async def get_station(self, station_id: str):
        return await self.get(f"station:{station_id}")

    async def get_series(self, station_id: str, stream: str, field: str, limit: int = 200) -> list:
        # Newest-first off the primary index. An obs id embeds a fixed-width
        # 10-digit epoch (so through 2286), which makes descending id order
        # identical to descending ts order -- see test_obs_id_order_matches_ts.
        docs = await self._all_docs_range(
            _obs_prefix(station_id, stream), descending=True, limit=limit
        )
        result = []
        for doc in docs:
            val = (doc.get("values") or {}).get(field)
            if val is not None:
                result.append({
                    "ts": doc.get("ts"),
                    "observedAt": doc.get("observedAt"),
                    "value": val,
                })
        return result

    async def get_series_multi(self, station_id: str, stream: str, fields: list, limit: int = 200) -> dict:
        """Newest-first series for several fields of one stream in a single view query.

        Returns {field: [{ts, value}]}; fields the station never reports come back
        as empty lists. Used by the Trends digest, which needs every standard
        field for every station and can't afford one query per field.
        """
        docs = await self._all_docs_range(
            _obs_prefix(station_id, stream), descending=True, limit=limit
        )
        out = {f: [] for f in fields}
        for doc in docs:
            ts = doc.get("ts")
            if ts is None:
                continue
            values = doc.get("values") or {}
            for f in fields:
                val = values.get(f)
                if val is not None:
                    out[f].append({"ts": ts, "value": val})
        return out

    async def get_trend(self, stream: str, field: str, t0: int, t1: int) -> list:
        """Network-wide hourly stats for one (stream, field) over [t0, t1].

        Returns [{ts, mean, min, max, count}] using the `trend` reduce view.
        """
        import json as _json
        params = {
            "startkey": _json.dumps([stream, field, t0]),
            "endkey": _json.dumps([stream, field, t1]),
            "group": "true",
            "reduce": "true",
            # No update= pin: the index is healthy again as of 2026-10-12 18:06
            # UTC, so this serves current data. If it ever has to be pinned
            # during an index rebuild again, use update=false and NOT
            # update=lazy -- lazy serves stale AND kicks off the build, which is
            # what re-entered the damaged shard last time.
        }
        # Fail soft, permanently. This is the only read left on a view, and a
        # damaged view index can 500 for some key ranges while serving others
        # (the reduce gathers from every shard) -- that is exactly what happened
        # on 2026-10-11, and it fired 14 times before the index was rebuilt. The
        # network trend feeds the Trends pulse cards and one research endpoint;
        # an empty result degrades those to "no data" -- _network_pulse already
        # renders nulls -- where raising takes down the whole digest and
        # /api/research/trend with it.
        try:
            resp = await self._client.get(
                self._url("/_design/buoys/_view/trend"),
                params=params,
            )
            if resp.status_code == 404:
                return []
            resp.raise_for_status()
            payload = resp.json()
        except (httpx.HTTPStatusError, httpx.RequestError) as e:
            log.warning("trend view unavailable for (%s, %s): %r", stream, field, e)
            return []
        out = []
        for row in payload.get("rows", []):
            key = row.get("key", [])
            stats = row.get("value", {}) or {}
            count = stats.get("count", 0)
            if not count:
                continue
            out.append({
                "ts": key[2] if len(key) > 2 else None,
                "mean": stats.get("sum", 0) / count,
                "min": stats.get("min"),
                "max": stats.get("max"),
                "count": count,
            })
        return out

    async def health_check(self) -> bool:
        try:
            resp = await self._client.get(f"{self._base}/")
            return resp.status_code == 200
        except Exception:
            return False


async def get_couch_client() -> CouchClient:
    return CouchClient(
        url=CFG.COUCHDB_URL,
        database=CFG.COUCHDB_DATABASE,
        user=CFG.COUCHDB_USER,
        password=CFG.COUCHDB_PASSWORD,
    )
