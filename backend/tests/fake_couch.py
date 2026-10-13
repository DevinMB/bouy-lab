from __future__ import annotations
import copy


class FakeCouchClient:
    """In-memory CouchDB substitute for tests. No network needed."""

    def __init__(self):
        self._docs: dict[str, dict] = {}
        self._rev_counter = 0

    def _next_rev(self) -> str:
        self._rev_counter += 1
        return f"{self._rev_counter}-fake"

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def ensure_db_and_views(self):
        pass

    async def get(self, doc_id: str):
        doc = self._docs.get(doc_id)
        return copy.deepcopy(doc) if doc else None

    async def put(self, doc: dict) -> dict:
        doc = copy.deepcopy(doc)
        doc["_rev"] = self._next_rev()
        self._docs[doc["_id"]] = doc
        return {"ok": True, "id": doc["_id"], "rev": doc["_rev"]}

    async def upsert(self, doc: dict) -> dict:
        existing = await self.get(doc["_id"])
        if existing:
            doc = {**doc, "_rev": existing["_rev"]}
        return await self.put(doc)

    async def upsert_observation(self, obs: dict) -> None:
        doc_id = f"obs:{obs['stationId']}:{obs['stream']}:{obs['ts']}"
        if doc_id not in self._docs:
            await self.put({**obs, "_id": doc_id, "type": "observation"})

    async def upsert_station(self, station: dict) -> None:
        doc_id = f"station:{station['stationId']}"
        await self.upsert({**station, "_id": doc_id, "type": "station"})

    async def upsert_latest_if_newer(
        self, station_id: str, stream: str, obs: dict, station_meta: dict
    ) -> None:
        doc_id = f"latest:{station_id}"
        existing = await self.get(doc_id)
        if existing and existing.get("ts", 0) >= obs.get("ts", 0):
            return
        values = obs.get("values", {})
        doc = {
            "_id": doc_id,
            "type": "latest",
            "stationId": station_id,
            "stream": stream,
            "ts": obs.get("ts"),
            "observedAt": obs.get("observedAt"),
            "waterTempC": values.get("waterTemperature"),
            "lat": station_meta.get("lat"),
            "lon": station_meta.get("lon"),
            "name": station_meta.get("name", station_id),
            "owner": station_meta.get("owner"),
            "available": station_meta.get("available", []),
            "streams": {stream: {"ts": obs.get("ts"), "values": values}},
        }
        await self.upsert(doc)

    async def get_all_latest(self) -> list:
        return [copy.deepcopy(d) for d in self._docs.values() if d.get("type") == "latest"]

    async def get_station(self, station_id: str):
        return await self.get(f"station:{station_id}")

    async def get_series(self, station_id: str, stream: str, field: str, limit: int = 200) -> list:
        prefix = f"obs:{station_id}:{stream}:"
        obs = [d for _id, d in self._docs.items() if _id.startswith(prefix)]
        obs.sort(key=lambda d: d.get("ts", 0), reverse=True)
        result = []
        for o in obs[:limit]:
            val = o.get("values", {}).get(field)
            if val is not None:
                result.append({"ts": o["ts"], "observedAt": o.get("observedAt"), "value": val})
        return result

    async def get_series_multi(self, station_id: str, stream: str, fields: list, limit: int = 200) -> dict:
        prefix = f"obs:{station_id}:{stream}:"
        obs = [d for _id, d in self._docs.items() if _id.startswith(prefix)]
        obs.sort(key=lambda d: d.get("ts", 0), reverse=True)
        out = {f: [] for f in fields}
        for o in obs[:limit]:
            for f in fields:
                val = o.get("values", {}).get(f)
                if val is not None:
                    out[f].append({"ts": o["ts"], "value": val})
        return out

    async def get_hourly_series(self, station_id, stream, field, t0, t1) -> dict:
        """{hour: last} derived from seeded obs docs the way the Flink job does.

        Newest reading per hour, with SANE_RANGES applied first -- so a seeded
        sensor fault is dropped here exactly as the real job drops it, and the
        digest tests keep testing that behaviour rather than bypassing it.
        """
        from buoys.service import SANE_RANGES
        lo, hi = SANE_RANGES.get(field, (float("-inf"), float("inf")))
        prefix = f"obs:{station_id}:{stream}:"
        obs = [d for _id, d in self._docs.items() if _id.startswith(prefix)]
        obs.sort(key=lambda d: d.get("ts", 0), reverse=True)  # newest first
        out = {}
        for o in obs:
            val = (o.get("values") or {}).get(field)
            ts = o.get("ts")
            if val is None or ts is None:
                continue
            try:
                val = float(val)
            except (TypeError, ValueError):
                continue
            if not (lo <= val <= hi):
                continue
            hour = (ts // 3600) * 3600
            if t0 <= hour <= t1 and hour not in out:
                out[hour] = val
        return out

    async def get_daily_series(self, station_id, stream, field, d0, d1) -> dict:
        """{day: (n, meanInDay)} from seeded obs, the way buoys_daily builds it:
        a true mean over every in-range reading of the UTC day."""
        from buoys.service import SANE_RANGES
        lo, hi = SANE_RANGES.get(field, (float("-inf"), float("inf")))
        prefix = f"obs:{station_id}:{stream}:"
        acc = {}
        for _id, o in self._docs.items():
            if not _id.startswith(prefix):
                continue
            val, ts = (o.get("values") or {}).get(field), o.get("ts")
            if val is None or ts is None or not (lo <= float(val) <= hi):
                continue
            day = ts - ts % 86400
            if d0 <= day <= d1:
                n, total = acc.get(day, (0, 0.0))
                acc[day] = (n + 1, total + float(val))
        return {day: (n, total / n) for day, (n, total) in acc.items()}

    async def get_hourly_multi(self, station_id, stream, fields, t0, t1) -> dict:
        return {f: await self.get_hourly_series(station_id, stream, f, t0, t1)
                for f in fields}

    async def get_trend(self, stream: str, field: str, t0: int, t1: int) -> list:
        """Hourly mean/min/max across all stations, mirroring the `trend` reduce view."""
        buckets: dict = {}
        for _id, d in self._docs.items():
            if d.get("type") != "observation" or d.get("stream") != stream:
                continue
            val = d.get("values", {}).get(f"{field}")
            ts = d.get("ts")
            if val is None or ts is None:
                continue
            b = (ts // 3600) * 3600
            if t0 <= b <= t1:
                buckets.setdefault(b, []).append(val)
        return [{"ts": b, "mean": sum(v) / len(v), "min": min(v), "max": max(v), "count": len(v)}
                for b, v in sorted(buckets.items())]

    async def health_check(self) -> bool:
        return True

    def seed(self, docs: list) -> None:
        """Directly insert docs into the fake store."""
        for doc in docs:
            self._docs[doc["_id"]] = copy.deepcopy(doc)
