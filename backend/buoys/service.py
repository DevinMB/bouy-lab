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
    spec = streams.get("spec", {}).get("values", {}) or {}
    # The stream keys with stored observations are the authoritative "available"
    # set — the probed `available` field on station docs is often empty.
    available = list(streams.keys()) or doc.get("available", [])
    # Wave height precedence: standard first, then spec (mirrors waterTemp's
    # standard→ocean fallback). Many buoys report waves only via the spec stream.
    wave_height = std.get("waveHeight")
    if wave_height is None:
        wave_height = spec.get("waveHeight")
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
            "waveHeight": wave_height,
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


async def _series_map(
    couch: CouchClient, ids: list, stream: str, field: str, hours: int, sem_limit: int = 24
) -> dict:
    """Concurrently fetch + bucket the series for many stations: {id: {bucket: value}}.

    Bounded by a semaphore since callers (teleconnections) may scan hundreds of buoys.
    """
    limit = min(1000, max(48, hours + 12))
    sem = asyncio.Semaphore(sem_limit)

    async def _one(sid: str):
        async with sem:
            raw = await couch.get_series(sid, stream, field, limit)
            return sid, _bucketed_series(raw)

    pairs = await asyncio.gather(*[_one(sid) for sid in ids]) if ids else []
    return dict(pairs)


def _leadlag(a: dict, b: dict, max_lag_hours: int):
    """Lead/lag correlation between two hourly series.

    Positive lag L ⇒ `a` leads `b` by L hours (a(t) predicts b(t+L)). Returns
    (best_lag, best_r, best_overlap, curve) where curve = [{lagHours, r}].
    """
    best_lag, best_r, best_overlap = 0, None, 0
    curve = []
    for lag in range(-max_lag_hours, max_lag_hours + 1):
        shift = lag * 3600
        shifted = {k - shift: v for k, v in b.items()}
        overlap = len(a.keys() & shifted.keys())
        r = _pearson(a, shifted) if overlap >= 3 else None
        curve.append({"lagHours": lag, "r": r})
        if r is not None and (best_r is None or r > best_r):
            best_lag, best_r, best_overlap = lag, r, overlap
    return best_lag, best_r, best_overlap, curve


def _build_forecast(series: dict, target_series: dict, leaders: list, max_lag_hours: int):
    """Predict the target's near future by blending each leader's recent series,
    shifted forward by its lead time and weighted by correlation. Returns
    (forecast, observed) where each is a list of {ts, value, ...}."""
    if not target_series:
        return [], []
    now_bucket = (int(time.time()) // 3600) * 3600
    t_vals = list(target_series.values())
    mu_t = sum(t_vals) / len(t_vals)

    lstats = {}
    for ldr in leaders:
        s = series.get(ldr["id"], {})
        if s:
            lstats[ldr["id"]] = (s, sum(s.values()) / len(s.values()))

    cutoff = now_bucket - 2 * max_lag_hours * 3600
    observed = [{"ts": k, "value": round(v, 3)} for k, v in sorted(target_series.items()) if k >= cutoff]

    forecast = []
    for k in range(1, max_lag_hours + 1):
        future_ts = now_bucket + k * 3600
        num, den, n = 0.0, 0.0, 0
        for ldr in leaders:
            if ldr["lagHours"] < k:
                continue
            entry = lstats.get(ldr["id"])
            if not entry:
                continue
            s, mu_l = entry
            val = s.get(future_ts - ldr["lagHours"] * 3600)
            if val is None:
                continue
            num += ldr["r"] * (val - mu_l)
            den += ldr["r"]
            n += 1
        if n > 0 and den > 0:
            forecast.append({"ts": future_ts, "value": round(mu_t + num / den, 3), "nContributors": n})
    return forecast, observed


async def get_propagation(
    couch: CouchClient, cache: TTLCache, target_id: str, stream: str, field: str, hours: int,
    max_lag_hours: int = 48, top_n: int = 8, max_dist_km: float = 4000,
    min_r: float = 0.5, min_overlap: int = 12,
) -> dict:
    """Find a target buoy's strongest upstream leaders and forecast its near future."""
    key = f"prop:{target_id}:{stream}:{field}:{hours}:{max_lag_hours}:{top_n}:{int(max_dist_km)}"
    cached = cache.get(key)
    if cached is not None:
        return cached

    snapshot = await get_snapshot(couch, cache, located_only=True)
    meta = {s["id"]: s for s in snapshot}
    tgt = meta.get(target_id)
    empty = {
        "target": target_id, "targetName": meta.get(target_id, {}).get("name", target_id),
        "stream": stream, "field": field, "hours": hours, "maxLagHours": max_lag_hours,
        "leaders": [], "forecast": [], "observed": [],
    }
    if not tgt or tgt.get("lat") is None:
        cache.set(key, empty)
        return empty

    tlat, tlon = tgt["lat"], tgt["lon"]
    candidates = []
    for s in snapshot:
        if s["id"] == target_id or stream not in (s.get("available") or []) or s.get("lat") is None:
            continue
        d = haversine_km(tlat, tlon, s["lat"], s["lon"])
        if d <= max_dist_km:
            candidates.append((s["id"], d))

    series = await _series_map(couch, [target_id] + [c for c, _ in candidates], stream, field, hours)
    target_series = series.get(target_id, {})

    leaders = []
    if target_series:
        for cid, dist in candidates:
            cs = series.get(cid, {})
            if not cs:
                continue
            lag, r, overlap, _curve = _leadlag(cs, target_series, max_lag_hours)
            if lag > 0 and r is not None and r >= min_r and overlap >= min_overlap:
                m = meta.get(cid, {})
                leaders.append({
                    "id": cid, "name": m.get("name", cid), "lat": m.get("lat"), "lon": m.get("lon"),
                    "lagHours": lag, "r": r, "overlap": overlap,
                    "distanceKm": round(dist, 1),
                    "speedKmh": round(dist / lag, 1) if lag else None,
                })
    leaders.sort(key=lambda x: x["r"], reverse=True)
    leaders = leaders[:top_n]

    forecast, observed = _build_forecast(series, target_series, leaders, max_lag_hours)
    result = {**empty, "leaders": leaders, "forecast": forecast, "observed": observed}
    cache.set(key, result)
    return result


async def get_teleconnections(
    couch: CouchClient, cache: TTLCache, ref_id: str, stream: str, field: str,
    hours: int, min_overlap: int = 12,
) -> dict:
    """Rank every located buoy reporting the metric by correlation to a reference buoy."""
    key = f"teleconn:{ref_id}:{stream}:{field}:{hours}"
    cached = cache.get(key)
    if cached is not None:
        return cached

    snapshot = await get_snapshot(couch, cache, located_only=True)
    meta = {s["id"]: s for s in snapshot}
    candidates = [s["id"] for s in snapshot
                  if stream in (s.get("available") or []) and s["id"] != ref_id]

    ref_series_map = await _series_map(couch, [ref_id], stream, field, hours)
    ref_series = ref_series_map.get(ref_id, {})

    results = []
    if ref_series:
        series = await _series_map(couch, candidates, stream, field, hours)
        for sid, s in series.items():
            overlap = len(ref_series.keys() & s.keys())
            if overlap < min_overlap:
                continue
            r = _pearson(ref_series, s)
            if r is None:
                continue
            m = meta.get(sid, {})
            results.append({
                "id": sid, "name": m.get("name", sid),
                "lat": m.get("lat"), "lon": m.get("lon"),
                "r": r, "overlap": overlap,
            })
    results.sort(key=lambda x: x["r"], reverse=True)

    result = {
        "ref": ref_id, "stream": stream, "field": field, "hours": hours,
        "refName": meta.get(ref_id, {}).get("name", ref_id),
        "results": results,
    }
    cache.set(key, result)
    return result


async def get_anomalies(
    couch: CouchClient, cache: TTLCache, stream: str, field: str,
    scope: str = "network", station_ids: list = None, limit: int = 25,
) -> dict:
    """Buoys reading farthest from the current mean for a metric, by z-score."""
    region_set = set(station_ids or [])
    key = f"anom:{stream}:{field}:{scope}:{limit}:{','.join(sorted(region_set))}"
    cached = cache.get(key)
    if cached is not None:
        return cached

    docs = await couch.get_all_latest()
    points = []
    for doc in docs:
        sid = doc.get("stationId")
        if scope == "region" and sid not in region_set:
            continue
        values = (doc.get("streams", {}).get(stream, {}) or {}).get("values", {}) or {}
        val = values.get(field)
        if val is None:
            continue
        points.append((sid, doc.get("name", sid), float(val)))

    n = len(points)
    if n < 3:
        result = {"stream": stream, "field": field, "scope": scope, "n": n,
                  "mean": None, "std": None, "anomalies": []}
        cache.set(key, result)
        return result

    vals = [p[2] for p in points]
    mean = sum(vals) / n
    std = (sum((v - mean) ** 2 for v in vals) / n) ** 0.5

    anomalies = []
    if std > 0:
        for sid, name, val in points:
            z = (val - mean) / std
            anomalies.append({
                "id": sid, "name": name, "value": round(val, 2),
                "z": round(z, 2), "direction": "high" if z >= 0 else "low",
            })
        anomalies.sort(key=lambda x: abs(x["z"]), reverse=True)
        anomalies = anomalies[:limit]

    result = {
        "stream": stream, "field": field, "scope": scope, "n": n,
        "mean": round(mean, 2), "std": round(std, 2), "anomalies": anomalies,
    }
    cache.set(key, result)
    return result


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
