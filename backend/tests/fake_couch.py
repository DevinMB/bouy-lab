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

    async def health_check(self) -> bool:
        return True

    def seed(self, docs: list) -> None:
        """Directly insert docs into the fake store."""
        for doc in docs:
            self._docs[doc["_id"]] = copy.deepcopy(doc)
