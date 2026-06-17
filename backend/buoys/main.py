import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from buoys.config import CFG
from buoys.couch import CouchClient, get_couch_client
from buoys.cache import TTLCache, snapshot_cache
from buoys import service

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

# Module-level state set during lifespan
_couch: CouchClient = None
_cache: TTLCache = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _couch, _cache

    _cache = TTLCache(ttl_seconds=CFG.SNAPSHOT_TTL_SECONDS)
    _couch = CouchClient(
        url=CFG.COUCHDB_URL,
        database=CFG.COUCHDB_DATABASE,
        user=CFG.COUCHDB_USER,
        password=CFG.COUCHDB_PASSWORD,
    )
    await _couch.__aenter__()

    try:
        await _couch.ensure_db_and_views()
        log.info("CouchDB views ensured")
    except Exception as e:
        log.warning("Could not ensure CouchDB views on startup: %s", e)

    yield

    await _couch.__aexit__(None, None, None)


app = FastAPI(title="World of Buoys", lifespan=lifespan)

if CFG.CORS_ALLOW_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CFG.CORS_ALLOW_ORIGINS,
        allow_methods=["GET"],
        allow_headers=["*"],
    )


def _get_couch() -> CouchClient:
    if _couch is None:
        raise HTTPException(status_code=503, detail="CouchDB client not ready")
    return _couch


def _get_cache() -> TTLCache:
    if _cache is None:
        raise HTTPException(status_code=503, detail="Cache not ready")
    return _cache


@app.get("/api/health")
async def health():
    couch = _get_couch()
    cache = _get_cache()
    try:
        ok = await couch.health_check()
        snapshot = await service.get_snapshot(couch, cache, located_only=False)
        return {"status": "ok", "couchdb": ok, "stationCount": len(snapshot), "ts": int(time.time())}
    except Exception as e:
        log.error("Health check error: %s", e)
        return {"status": "degraded", "couchdb": False, "stationCount": 0, "ts": int(time.time())}


@app.get("/api/buoys")
async def get_buoys(located_only: bool = Query(default=True)):
    couch = _get_couch()
    cache = _get_cache()
    return await service.get_snapshot(couch, cache, located_only=located_only)


@app.get("/api/buoys/{station_id}")
async def get_buoy(station_id: str):
    couch = _get_couch()
    detail = await service.get_buoy_detail(couch, station_id)
    if detail is None:
        raise HTTPException(status_code=404, detail=f"Station {station_id!r} not found")
    return detail


@app.get("/api/buoys/{station_id}/series")
async def get_series(
    station_id: str,
    stream: str = Query(...),
    field: str = Query(...),
    limit: int = Query(default=200, ge=1, le=1000),
):
    couch = _get_couch()
    data = await service.get_series(couch, station_id, stream, field, limit)
    return {"stationId": station_id, "stream": stream, "field": field, "data": data}


@app.get("/api/buoys/{station_id}/nearby")
async def get_nearby_to_station(
    station_id: str,
    radius_km: float = Query(default=200, le=5000),
    limit: int = Query(default=10, ge=1, le=100),
):
    couch = _get_couch()
    cache = _get_cache()
    detail = await service.get_buoy_detail(couch, station_id)
    if detail is None:
        raise HTTPException(status_code=404, detail=f"Station {station_id!r} not found")
    lat, lon = detail.get("lat"), detail.get("lon")
    if lat is None or lon is None:
        raise HTTPException(status_code=422, detail="Station has no location data")
    return await service.get_nearby(couch, cache, lat, lon, radius_km, limit)


@app.get("/api/nearby")
async def get_nearby(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    radius_km: float = Query(default=200, le=5000),
    limit: int = Query(default=10, ge=1, le=100),
):
    couch = _get_couch()
    cache = _get_cache()
    return await service.get_nearby(couch, cache, lat, lon, radius_km, limit)


@app.get("/api/stats")
async def get_stats():
    couch = _get_couch()
    cache = _get_cache()
    return await service.get_stats(couch, cache)


@app.get("/api/research/trend")
async def research_trend(
    stream: str = Query(...),
    field: str = Query(...),
    hours: int = Query(default=120, ge=6, le=720),
):
    couch = _get_couch()
    cache = _get_cache()
    return await service.get_trend(couch, cache, stream, field, hours)


@app.get("/api/research/trend_region")
async def research_trend_region(
    stream: str = Query(...),
    field: str = Query(...),
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    radius_km: float = Query(..., gt=0, le=5000),
    hours: int = Query(default=120, ge=6, le=720),
):
    couch = _get_couch()
    cache = _get_cache()
    return await service.get_regional_trend(couch, cache, stream, field, lat, lon, radius_km, hours)


@app.get("/api/research/trend_stations")
async def research_trend_stations(
    stream: str = Query(...),
    field: str = Query(...),
    stations: str = Query(..., description="Comma-separated station IDs (e.g. buoys inside a drawn shape)"),
    hours: int = Query(default=120, ge=6, le=720),
):
    couch = _get_couch()
    cache = _get_cache()
    station_ids = [s.strip() for s in stations.split(",") if s.strip()]
    if not station_ids:
        raise HTTPException(status_code=422, detail="No station IDs provided")
    return await service.get_trend_by_stations(couch, cache, stream, field, station_ids, hours)


@app.get("/api/research/correlate")
async def research_correlate(
    stream: str = Query(...),
    field: str = Query(...),
    stations: str = Query(..., description="Comma-separated station IDs"),
    hours: int = Query(default=120, ge=6, le=720),
):
    couch = _get_couch()
    station_ids = [s.strip() for s in stations.split(",") if s.strip()][:16]
    if len(station_ids) < 2:
        raise HTTPException(status_code=422, detail="Provide at least 2 station IDs")
    return await service.get_correlation(couch, stream, field, station_ids, hours)
