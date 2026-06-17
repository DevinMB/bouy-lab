import httpx
import logging
from buoys.config import CFG

log = logging.getLogger(__name__)

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
        return f"{self._base}/{self._db}{path}"

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

    async def get_all_latest(self) -> list:
        resp = await self._client.get(
            self._url("/_design/buoys/_view/latest"),
            params={"include_docs": "true"},
        )
        if resp.status_code == 404:
            return []
        resp.raise_for_status()
        data = resp.json()
        return [row["doc"] for row in data.get("rows", []) if "doc" in row]

    async def get_station(self, station_id: str):
        return await self.get(f"station:{station_id}")

    async def get_series(self, station_id: str, stream: str, field: str, limit: int = 200) -> list:
        # Descending range query: newest first
        import json as _json
        params = {
            "startkey": _json.dumps([station_id, stream, {}]),
            "endkey": _json.dumps([station_id, stream, 0]),
            "descending": "true",
            "limit": limit,
        }
        resp = await self._client.get(
            self._url("/_design/buoys/_view/series"),
            params=params,
        )
        if resp.status_code == 404:
            return []
        resp.raise_for_status()
        rows = resp.json().get("rows", [])
        result = []
        for row in rows:
            values = row.get("value", {}) or {}
            val = values.get(field)
            if val is not None:
                key = row.get("key", [])
                result.append({
                    "ts": key[2] if len(key) > 2 else None,
                    "observedAt": None,  # not stored in view value
                    "value": val,
                })
        return result

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
        }
        resp = await self._client.get(
            self._url("/_design/buoys/_view/trend"),
            params=params,
        )
        if resp.status_code == 404:
            return []
        resp.raise_for_status()
        out = []
        for row in resp.json().get("rows", []):
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
