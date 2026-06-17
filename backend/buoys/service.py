import asyncio
import math
import logging
import time
from datetime import datetime, timezone

from buoys.couch import CouchClient
from buoys.cache import TTLCache
from buoys.config import CFG

log = logging.getLogger(__name__)


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    )
    return R * 2 * math.asin(math.sqrt(a))


def _doc_to_snapshot_item(doc: dict) -> dict:
    streams = doc.get("streams", {})
    std = streams.get("standard", {}).get("values", {}) or {}
    # The stream keys with stored observations are the authoritative "available"
    # set — the probed `available` field on station docs is often empty.
    available = list(streams.keys()) or doc.get("available", [])
    return {
        "id": doc.get("stationId", ""),
        "name": doc.get("name", ""),
        "lat": doc.get("lat"),
        "lon": doc.get("lon"),
        "owner": doc.get("owner"),
        "type": doc.get("ttype"),
        "available": available,
        "latest": {
            "waterTempC": doc.get("waterTempC"),
            "observedAt": doc.get("observedAt"),
            "windSpeed": std.get("windSpeed"),
            "gustSpeed": std.get("gustSpeed"),
            "waveHeight": std.get("waveHeight"),
            "pressure": std.get("pressure"),
            "airTemperature": std.get("airTemperature"),
        },
    }


async def get_snapshot(couch: CouchClient, cache: TTLCache, located_only: bool = True) -> list:
    cached = cache.get("snapshot")
    if cached is not None:
        items = cached
    else:
        docs = await couch.get_all_latest()
        items = [_doc_to_snapshot_item(d) for d in docs]
        cache.set("snapshot", items)

    if located_only:
        return [item for item in items if item.get("lat") is not None and item.get("lon") is not None]
    return items


async def get_buoy_detail(couch: CouchClient, station_id: str):
    latest = await couch.get(f"latest:{station_id}")
    if not latest:
        return None
    station = await couch.get_station(station_id)

    detail = _doc_to_snapshot_item(latest)
    detail["streams"] = latest.get("streams", {})
    if station:
        detail["payload"] = station.get("payload")
        detail["hull"] = station.get("hull")
        detail["ttype"] = station.get("ttype")
    return detail


async def get_series(couch: CouchClient, station_id: str, stream: str, field: str, limit: int) -> list:
    return await couch.get_series(station_id, stream, field, limit)


async def get_nearby(
    couch: CouchClient,
    cache: TTLCache,
    lat: float,
    lon: float,
    radius_km: float,
    limit: int,
) -> list:
    snapshot = await get_snapshot(couch, cache, located_only=True)
    with_dist = []
    for item in snapshot:
        ilat, ilon = item.get("lat"), item.get("lon")
        if ilat is None or ilon is None:
            continue
        dist = haversine_km(lat, lon, ilat, ilon)
        if dist <= radius_km:
            with_dist.append({**item, "distanceKm": round(dist, 2)})
    with_dist.sort(key=lambda x: x["distanceKm"])
    return with_dist[:limit]


async def get_trend(
    couch: CouchClient, cache: TTLCache, stream: str, field: str, hours: int
) -> dict:
    """Network-wide hourly trend (mean + min/max band) for one metric."""
    key = f"trend:{stream}:{field}:{hours}"
    cached = cache.get(key)
    if cached is not None:
        return cached

    t1 = int(time.time())
    t0 = t1 - hours * 3600
    points = await couch.get_trend(stream, field, t0, t1)
    result = {"stream": stream, "field": field, "hours": hours, "points": points}
    cache.set(key, result)
    return result


# Cap on how many in-region buoys we fetch series for, to bound the per-request
# cost of a large drawn selection.
MAX_REGION_STATIONS = 80


async def _trend_from_stations(
    couch: CouchClient, station_ids: list, stream: str, field: str, hours: int
) -> tuple:
    """Aggregate one metric across the given stations into hourly mean/min/max.

    Returns (points, contributing) where contributing is the number of stations
    that actually had at least one reading in the window.
    """
    limit = min(1000, max(48, hours + 12))
    t1 = int(time.time())
    t0 = t1 - hours * 3600

    async def _station_buckets(sid: str) -> dict:
        raw = await couch.get_series(sid, stream, field, limit)
        seen: dict = {}
        for pt in raw:
            ts, val = pt.get("ts"), pt.get("value")
            if ts is None or val is None:
                continue
            b = (ts // 3600) * 3600
            if t0 <= b <= t1 and b not in seen:  # newest per hour per station
                seen[b] = val
        return seen

    per_station = await asyncio.gather(*[_station_buckets(s) for s in station_ids]) if station_ids else []
    contributing = sum(1 for seen in per_station if seen)
    buckets: dict = {}
    for seen in per_station:
        for b, v in seen.items():
            buckets.setdefault(b, []).append(v)

    points = []
    for b in sorted(buckets):
        vals = buckets[b]
        points.append({
            "ts": b,
            "mean": sum(vals) / len(vals),
            "min": min(vals),
            "max": max(vals),
            "count": len(vals),
        })
    return points, contributing


async def get_trend_by_stations(
    couch: CouchClient, cache: TTLCache, stream: str, field: str,
    station_ids: list, hours: int,
) -> dict:
    """Regional trend for an explicit station list (e.g. buoys inside a drawn shape)."""
    requested = len(station_ids)
    used = station_ids[:MAX_REGION_STATIONS]
    key = f"strend:{stream}:{field}:{hours}:{','.join(sorted(used))}"
    cached = cache.get(key)
    if cached is not None:
        return cached

    points, contributing = await _trend_from_stations(couch, used, stream, field, hours)
    result = {
        "stream": stream, "field": field, "hours": hours, "points": points,
        "stationCount": len(used),
        "contributing": contributing,
        "requested": requested,
        "capped": requested > len(used),
    }
    cache.set(key, result)
    return result


async def get_regional_trend(
    couch: CouchClient, cache: TTLCache, stream: str, field: str,
    lat: float, lon: float, radius_km: float, hours: int,
) -> dict:
    """Mean + min/max band for one metric across buoys within a drawn circle."""
    key = f"rtrend:{stream}:{field}:{hours}:{round(lat, 2)}:{round(lon, 2)}:{round(radius_km, 1)}"
    cached = cache.get(key)
    if cached is not None:
        return cached

    snapshot = await get_snapshot(couch, cache, located_only=True)
    in_region = []
    for item in snapshot:
        if stream not in (item.get("available") or []):
            continue
        ilat, ilon = item.get("lat"), item.get("lon")
        if ilat is None or ilon is None:
            continue
        dist = haversine_km(lat, lon, ilat, ilon)
        if dist <= radius_km:
            in_region.append((dist, item["id"]))
    in_region.sort(key=lambda x: x[0])
    station_ids = [sid for _, sid in in_region[:MAX_REGION_STATIONS]]

    points, contributing = await _trend_from_stations(couch, station_ids, stream, field, hours)
    result = {
        "stream": stream, "field": field, "hours": hours, "points": points,
        "stationCount": len(station_ids),
        "contributing": contributing,
        "matchedTotal": len(in_region),
        "capped": len(in_region) > len(station_ids),
        "radiusKm": radius_km, "lat": lat, "lon": lon,
    }
    cache.set(key, result)
    return result


def _bucketed_series(points: list, interval: int = 3600) -> dict:
    """Collapse a [{ts, value}] series into {bucket_ts: value} (newest per bucket)."""
    out = {}
    for pt in points:
        ts, val = pt.get("ts"), pt.get("value")
        if ts is None or val is None:
            continue
        bucket = (ts // interval) * interval
        out.setdefault(bucket, val)  # points are newest-first; keep newest in bucket
    return out


def _pearson(a: dict, b: dict):
    """Pearson correlation over the time buckets shared by both series."""
    common = a.keys() & b.keys()
    n = len(common)
    if n < 3:
        return None
    xs = [a[k] for k in common]
    ys = [b[k] for k in common]
    mx, my = sum(xs) / n, sum(ys) / n
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    vx = sum((x - mx) ** 2 for x in xs)
    vy = sum((y - my) ** 2 for y in ys)
    if vx == 0 or vy == 0:
        return None
    return round(cov / (vx ** 0.5 * vy ** 0.5), 3)


async def get_correlation(
    couch: CouchClient, stream: str, field: str, station_ids: list, hours: int
) -> dict:
    """Pairwise correlation matrix for a metric across the given stations."""
    limit = min(1000, max(48, hours + 12))
    series = {}
    for sid in station_ids:
        raw = await couch.get_series(sid, stream, field, limit)
        series[sid] = _bucketed_series(raw)

    matrix = []
    for a in station_ids:
        row = []
        for b in station_ids:
            row.append(1.0 if a == b else _pearson(series[a], series[b]))
        matrix.append(row)

    samples = {sid: len(series[sid]) for sid in station_ids}
    return {
        "stream": stream,
        "field": field,
        "hours": hours,
        "stations": station_ids,
        "matrix": matrix,
        "samples": samples,
    }


async def get_stats(couch: CouchClient, cache: TTLCache) -> dict:
    cached = cache.get("stats")
    if cached is not None:
        return cached

    snapshot = await get_snapshot(couch, cache, located_only=False)
    fresh_cutoff = time.time() - CFG.FRESH_WINDOW_HOURS * 3600

    total = len(snapshot)
    located = sum(1 for s in snapshot if s.get("lat") is not None)
    reporting = 0
    by_owner: dict = {}
    by_type: dict = {}
    coverage: dict = {}
    temp_buckets: dict = {}

    for item in snapshot:
        obs_at = item.get("latest", {}).get("observedAt")
        if obs_at:
            try:
                dt = datetime.strptime(obs_at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
                if dt.timestamp() >= fresh_cutoff:
                    reporting += 1
            except ValueError:
                pass

        owner = item.get("owner") or "Unknown"
        by_owner[owner] = by_owner.get(owner, 0) + 1

        ttype = item.get("type") or "Unknown"
        by_type[ttype] = by_type.get(ttype, 0) + 1

        for stream in item.get("available", []):
            coverage[stream] = coverage.get(stream, 0) + 1

        wtc = item.get("latest", {}).get("waterTempC")
        if wtc is not None:
            bucket = int(math.floor(wtc))
            temp_buckets[bucket] = temp_buckets.get(bucket, 0) + 1

    # Sort by_owner / by_type descending
    by_owner_sorted = dict(sorted(by_owner.items(), key=lambda x: -x[1])[:20])
    by_type_sorted = dict(sorted(by_type.items(), key=lambda x: -x[1])[:20])

    # Build histogram as sorted list of {temp, count}
    histogram = [{"tempC": k, "count": v} for k, v in sorted(temp_buckets.items())]

    stats = {
        "total": total,
        "located": located,
        "reporting": reporting,
        "byOwner": by_owner_sorted,
        "byType": by_type_sorted,
        "coverage": coverage,
        "waterTempHistogram": histogram,
    }
    cache.set("stats", stats)
    return stats
