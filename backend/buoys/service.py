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
    resolution = trend_resolution(hours)
    if resolution == "day":
        # The view's _stats rows carry count and mean per hour, so sum = mean *
        # count is exact and a day's mean is sum(sum) / sum(count) -- precisely
        # the weight-by-n rule, over every reading. Served from the view rather
        # than daily: because the view already spans all raw history (back to
        # 2026-04-26) while daily: only holds what Flink has replayed.
        points = _hours_to_days(points)
    result = {"stream": stream, "field": field, "hours": hours, "points": points,
              "resolution": resolution}
    cache.set(key, result)
    return result


# Cap on how many in-region buoys we fetch series for, to bound the per-request
# cost of a large drawn selection.
MAX_REGION_STATIONS = 80

# Research trend windows longer than this are served at DAILY resolution and
# plot a daily MEAN rather than the newest-per-hour value. Decided 2026-10-13:
# the change of quantity at this boundary is deliberate, and the response says
# so via `resolution` so the UI can label it rather than let it be discovered.
LONG_WINDOW_HOURS = 720
DAY = 86400


def trend_resolution(hours: int) -> str:
    return "day" if hours > LONG_WINDOW_HOURS else "hour"

# The (stream, field) pairs phase 2's Flink job materialises as hourly: docs --
# exactly Research.jsx's METRICS. Anything outside this set still works: the
# trend falls back to raw obs: series, just slower and subject to the point cap.
# Adding a metric to the UI therefore does not require a Flink change first.
HOURLY_PAIRS = {
    ("standard", "waterTemperature"), ("standard", "airTemperature"),
    ("standard", "windSpeed"), ("standard", "gustSpeed"),
    ("standard", "waveHeight"), ("standard", "pressure"),
    ("spec", "waveHeight"), ("spec", "swellHeight"),
    ("srad", "solarRadiation"), ("ocean", "waterTemperature"),
}


def _hours_to_days(points: list) -> list:
    """Collapse hourly {ts, mean, min, max, count} rows into UTC days, weighted by count."""
    days: dict = {}
    for p in points:
        ts, cnt = p.get("ts"), p.get("count") or 0
        if ts is None or not cnt:
            continue
        d = days.setdefault(ts - ts % DAY, {"sum": 0.0, "count": 0, "min": None, "max": None})
        d["sum"] += p["mean"] * cnt
        d["count"] += cnt
        d["min"] = p["min"] if d["min"] is None else min(d["min"], p["min"])
        d["max"] = p["max"] if d["max"] is None else max(d["max"], p["max"])
    return [{"ts": day, "mean": v["sum"] / v["count"], "min": v["min"], "max": v["max"],
             "count": v["count"]} for day, v in sorted(days.items())]


async def _trend_from_stations(
    couch: CouchClient, station_ids: list, stream: str, field: str, hours: int
) -> tuple:
    """Aggregate one metric across the given stations into hourly mean/min/max.

    Returns (points, contributing) where contributing is the number of stations
    that actually had at least one reading in the window.
    """
    t1 = int(time.time())
    t0 = t1 - hours * 3600
    use_hourly = (stream, field) in HOURLY_PAIRS
    lo, hi = SANE_RANGES.get(field, (float("-inf"), float("inf")))
    # Only the fallback needs a point cap; hourly: has none, which is the point.
    limit = min(1000, max(48, hours + 12))

    daily = trend_resolution(hours) == "day"

    async def _station_buckets(sid: str) -> dict:
        if daily and use_hourly:  # the daily tier covers the same ten pairs
            # One value per station per day: its meanInDay. Stations then count
            # equally across the region, exactly as they do per hour.
            got = await couch.get_daily_series(sid, stream, field,
                                               t0 - t0 % DAY, t1 - t1 % DAY)
            return {day: mean for day, (n, mean) in got.items()}
        if use_hourly:
            # Already newest-per-hour and already SANE_RANGES-filtered in the
            # Flink job, and with no point cap -- so a long window is not
            # silently truncated the way the raw path truncates it.
            return await couch.get_hourly_series(sid, stream, field, t0, t1)
        raw = await couch.get_series(sid, stream, field, limit)
        seen: dict = {}
        for pt in raw:
            ts, val = pt.get("ts"), pt.get("value")
            if ts is None or val is None:
                continue
            try:
                val = float(val)
            except (TypeError, ValueError):
                continue
            if not (lo <= val <= hi):
                continue
            size = DAY if daily else 3600
            b = (ts // size) * size
            # Daily includes the (partial) day containing t0, matching the
            # daily: path's d0; hourly keeps its original t0 <= b bound.
            lo_b = t0 - t0 % DAY if daily else t0
            if lo_b <= b <= t1 and b not in seen:  # newest per bucket per station
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
        "resolution": trend_resolution(hours),
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
    lo, hi = SANE_RANGES.get(field, (float("-inf"), float("inf")))
    fresh_cutoff = time.time() - CFG.FRESH_WINDOW_HOURS * 3600
    points = []
    stale = 0
    out_of_range = 0
    for doc in docs:
        sid = doc.get("stationId")
        if scope == "region" and sid not in region_set:
            continue
        entry = (doc.get("streams") or {}).get(stream) or {}
        values = entry.get("values") or {}
        val = values.get(field)
        if val is None:
            continue
        # A "current" network mean needs current readings. Use the STREAM's ts,
        # not the doc's: doc.ts is the newest across all streams, so a station
        # with a live standard feed would otherwise drag a months-stale ocean
        # reading in alongside it.
        ts = entry.get("ts")
        if ts is None or ts < fresh_cutoff:
            stale += 1
            continue
        try:
            val = float(val)
        except (TypeError, ValueError):
            continue
        # Sensor faults (999 °C and friends) inflate std, which compresses every
        # z-score toward zero -- so the faults rank as the top anomalies while
        # real ones are buried. Same filter the Trends digest already applies
        # as the Flink job applies when building hourly: docs, so the two
        # consumers of that rule stay consistent.
        if not (lo <= val <= hi):
            out_of_range += 1
            continue
        points.append((sid, doc.get("name", sid), val))

    n = len(points)
    if n < 3:
        result = {"stream": stream, "field": field, "scope": scope, "n": n,
                  "mean": None, "std": None, "anomalies": [],
                  "excludedStale": stale, "excludedOutOfRange": out_of_range}
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
        # Reported so the filtering is auditable rather than invisible.
        "excludedStale": stale, "excludedOutOfRange": out_of_range,
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



# ── Trends digest ("interesting trends") ──────────────────────────────────────
#
# Scans every located station's recent series for a handful of fields and
# ranks what's notable right now: fastest warming/cooling water, falling
# pressure, building seas, strongest wind, the largest air–sea gap, and
# stations that just went quiet. Everything is computed on hourly buckets so
# buoys on different cadences are comparable.
#
# A full scan is ~1,100 stations × up to 1,000 rows and takes tens of seconds,
# so it runs ONCE for the longest window and every shorter window is derived
# from the same data. `highlights_refresher` (started from the app lifespan)
# keeps all windows warm in the cache; requests never wait on a scan except
# right after startup.

HIGHLIGHT_WINDOWS = (24, 72, 168)
HIGHLIGHT_DEFAULT_HOURS = 72

# Fields scanned per stream. spec.waveHeight is only used as a fallback for
# stations that don't report standard.waveHeight (gotcha 5).
HIGHLIGHT_FIELDS = {
    "standard": ["waterTemperature", "airTemperature", "windSpeed", "gustSpeed", "waveHeight", "pressure"],
    "spec": ["waveHeight"],
}

# Physically plausible ranges; anything outside is a sensor fault, not a trend.
SANE_RANGES = {
    "waterTemperature": (-5.0, 45.0),
    "airTemperature": (-60.0, 60.0),
    "windSpeed": (0.0, 90.0),
    "gustSpeed": (0.0, 110.0),
    "waveHeight": (0.0, 30.0),
    "pressure": (850.0, 1100.0),
}

HIGHLIGHT_TOP_N = 6
# A station's newest bucket must be at most this old to count as "now".
HIGHLIGHT_NOW_MAX_AGE_H = 6
# A trend needs at least this many hourly buckets spanning at least this
# fraction of the window; many international stations have only a few points.
HIGHLIGHT_MIN_BUCKETS = 6
HIGHLIGHT_MIN_SPAN_FRAC = 0.5

_highlight_lock = asyncio.Lock()


def _series_stats(buckets: dict, hours: int, now_bucket: int):
    """Summarise one station's hourly series. Returns None if there is nothing usable.

    `latest` is only set when the newest bucket is recent enough to be "now";
    `slope` (units/hour, least squares) only when the series is dense enough
    to call a trend.
    """
    if not buckets:
        return None
    keys = sorted(buckets)
    newest, oldest = keys[-1], keys[0]
    n = len(keys)
    span_h = (newest - oldest) / 3600
    vals = [buckets[k] for k in keys]
    mean = sum(vals) / n
    std = (sum((v - mean) ** 2 for v in vals) / n) ** 0.5 if n > 1 else 0.0

    latest = buckets[newest] if (now_bucket - newest) <= HIGHLIGHT_NOW_MAX_AGE_H * 3600 else None

    slope = None
    if n >= HIGHLIGHT_MIN_BUCKETS and span_h >= HIGHLIGHT_MIN_SPAN_FRAC * hours and latest is not None:
        xs = [(k - oldest) / 3600 for k in keys]
        mx = sum(xs) / n
        vx = sum((x - mx) ** 2 for x in xs)
        if vx > 0:
            slope = sum((x - mx) * (v - mean) for x, v in zip(xs, vals)) / vx

    return {
        "n": n, "spanHours": round(span_h, 1), "latest": latest,
        "mean": mean, "std": std, "slope": slope,
        "max": max(vals), "min": min(vals),
        "series": [[k, round(buckets[k], 3)] for k in keys],
    }


def _highlight_item(meta: dict, st: dict, value: float, **extra) -> dict:
    return {
        "id": meta.get("id"), "name": meta.get("name") or meta.get("id"),
        "lat": meta.get("lat"), "lon": meta.get("lon"),
        "value": round(value, 3),
        "latest": round(st["latest"], 3) if st.get("latest") is not None else None,
        "n": st["n"], "spanHours": st["spanHours"], "series": st["series"],
        **extra,
    }


def _rank(rows: list, key, reverse: bool = True, top_n: int = HIGHLIGHT_TOP_N) -> list:
    return sorted(rows, key=key, reverse=reverse)[:top_n]


async def _scan_network(couch: CouchClient, snapshot: list, t0: int, t1: int) -> list:
    """Hourly buckets for every field of every station: [(meta, {field: {hour: value}})].

    Reads phase 2's hourly: documents, which arrive already bucketed
    newest-per-hour and already SANE_RANGES-filtered by the Flink job. So there
    is no series fetch, no Python bucketing and no 1000-point cap -- the last of
    which mattered, because at a 10-minute cadence 1000 points is barely the
    168h window this scan needs.

    Concurrency is per station but each station fans out one query per field, so
    the in-flight request count is the semaphore times len(HIGHLIGHT_FIELDS).
    Kept at 8 to stay well inside httpx's default 100-connection pool.
    """
    sem = asyncio.Semaphore(8)

    async def _one(item: dict):
        available = item.get("available") or []
        sid = item["id"]
        buckets: dict = {}
        async with sem:
            if "standard" in available:
                got = await couch.get_hourly_multi(
                    sid, "standard", HIGHLIGHT_FIELDS["standard"], t0, t1)
                buckets = {f: b for f, b in got.items() if b}
            # Wave height precedence: standard first, then spec (gotcha 5).
            if "spec" in available and not buckets.get("waveHeight"):
                spec = await couch.get_hourly_multi(
                    sid, "spec", HIGHLIGHT_FIELDS["spec"], t0, t1)
                if spec.get("waveHeight"):
                    buckets["waveHeight"] = spec["waveHeight"]
        return item, buckets

    return await asyncio.gather(*[_one(s) for s in snapshot]) if snapshot else []


async def _network_pulse(couch: CouchClient, t0: int, t1: int) -> list:
    """Network-mean now vs. start of window for the headline fields (via the trend view)."""
    fields = [("standard", "waterTemperature"), ("standard", "airTemperature"),
              ("standard", "windSpeed"), ("standard", "waveHeight"), ("standard", "pressure")]
    trends = await asyncio.gather(*[couch.get_trend(s, f, t0, t1) for s, f in fields])
    pulse = []
    for (stream, field), pts in zip(fields, trends):
        pts = [p for p in pts if p.get("ts") is not None and p.get("count")]
        if len(pts) < 6:
            pulse.append({"stream": stream, "field": field, "now": None, "then": None, "delta": None, "buoys": 0})
            continue
        # Compare the mean of the first and last 3 hourly buckets so a single
        # thin bucket (e.g. the current partial hour) can't swing the headline.
        head, tail = pts[:3], pts[-3:]
        then = sum(p["mean"] for p in head) / len(head)
        now = sum(p["mean"] for p in tail) / len(tail)
        pulse.append({
            "stream": stream, "field": field,
            "now": round(now, 2), "then": round(then, 2), "delta": round(now - then, 2),
            "buoys": max(p["count"] for p in tail),
        })
    return pulse


def _digest(scanned: list, snapshot: list, hours: int, t1: int) -> dict:
    """Rank one window's highlights from the scanned buckets (no I/O)."""
    t0 = t1 - hours * 3600
    now_bucket = (t1 // 3600) * 3600

    warming, pressure_rows, seas_building, biggest_seas = [], [], [], []
    windiest, volatile, air_sea = [], [], []
    with_trend = 0
    for meta, buckets in scanned:
        stats = {}
        for field, b in buckets.items():
            st = _series_stats({k: v for k, v in b.items() if k >= t0}, hours, now_bucket)
            if st:
                stats[field] = st
        if any(st["slope"] is not None for st in stats.values()):
            with_trend += 1

        wt = stats.get("waterTemperature")
        if wt and wt["slope"] is not None:
            warming.append(_highlight_item(meta, wt, wt["slope"] * hours, slopePerDay=round(wt["slope"] * 24, 3)))
        if wt and wt["n"] >= HIGHLIGHT_MIN_BUCKETS and wt["latest"] is not None:
            volatile.append(_highlight_item(meta, wt, wt["std"], range=round(wt["max"] - wt["min"], 3)))
        pr = stats.get("pressure")
        if pr and pr["slope"] is not None:
            pressure_rows.append(_highlight_item(meta, pr, pr["slope"] * hours, slopePerDay=round(pr["slope"] * 24, 3)))
        wv = stats.get("waveHeight")
        if wv and wv["slope"] is not None:
            seas_building.append(_highlight_item(meta, wv, wv["slope"] * hours, slopePerDay=round(wv["slope"] * 24, 3)))
        if wv and wv["latest"] is not None:
            biggest_seas.append(_highlight_item(meta, wv, wv["latest"], peak=round(wv["max"], 3)))
        ws = stats.get("windSpeed")
        if ws and ws["latest"] is not None:
            gs = stats.get("gustSpeed")
            gust = gs["latest"] if gs and gs["latest"] is not None else None
            windiest.append(_highlight_item(meta, ws, ws["latest"], gust=round(gust, 3) if gust is not None else None))
        at = stats.get("airTemperature")
        if wt and at and wt["latest"] is not None and at["latest"] is not None:
            gap = at["latest"] - wt["latest"]
            air_sea.append(_highlight_item(meta, at, gap, air=round(at["latest"], 3), water=round(wt["latest"], 3)))

    # Stations that stopped reporting inside the window: last observation is
    # older than the fresh window but not older than window + fresh window.
    fresh_s = CFG.FRESH_WINDOW_HOURS * 3600
    quiet = []
    for item in snapshot:
        obs_at = item.get("latest", {}).get("observedAt")
        if not obs_at:
            continue
        try:
            last = datetime.strptime(obs_at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
        except ValueError:
            continue
        age = t1 - last
        if fresh_s < age <= fresh_s + hours * 3600:
            quiet.append({
                "id": item["id"], "name": item.get("name") or item["id"],
                "lat": item.get("lat"), "lon": item.get("lon"),
                "lastSeen": int(last), "silentHours": round(age / 3600, 1),
            })
    quiet.sort(key=lambda q: q["silentHours"])

    return {
        "hours": hours,
        "generatedAt": t1,
        "stationsScanned": len(scanned),
        "stationsWithTrend": with_trend,
        "sections": {
            "warming": _rank([r for r in warming if r["value"] > 0], key=lambda r: r["value"]),
            "cooling": _rank([r for r in warming if r["value"] < 0], key=lambda r: r["value"], reverse=False),
            "pressureFalling": _rank([r for r in pressure_rows if r["value"] < 0], key=lambda r: r["value"], reverse=False),
            "pressureRising": _rank([r for r in pressure_rows if r["value"] > 0], key=lambda r: r["value"]),
            "seasBuilding": _rank([r for r in seas_building if r["value"] > 0], key=lambda r: r["value"]),
            "biggestSeas": _rank(biggest_seas, key=lambda r: r["value"]),
            "windiest": _rank(windiest, key=lambda r: r["value"]),
            "volatileWater": _rank(volatile, key=lambda r: r["value"]),
            "airSeaGap": _rank(air_sea, key=lambda r: abs(r["value"])),
            "wentQuiet": quiet[:HIGHLIGHT_TOP_N * 2],
        },
    }


async def refresh_highlights(couch: CouchClient, cache: TTLCache) -> dict:
    """Scan the network once and cache a digest for every window. Returns {hours: digest}."""
    async with _highlight_lock:
        started = time.monotonic()
        t1 = int(time.time())
        max_hours = max(HIGHLIGHT_WINDOWS)
        snapshot = await get_snapshot(couch, cache, located_only=True)
        scanned = await _scan_network(couch, snapshot, t1 - max_hours * 3600, t1)
        pulses = await asyncio.gather(*[_network_pulse(couch, t1 - h * 3600, t1) for h in HIGHLIGHT_WINDOWS])
        out = {}
        for hours, pulse in zip(HIGHLIGHT_WINDOWS, pulses):
            digest = {**_digest(scanned, snapshot, hours, t1), "pulse": pulse}
            # Entries outlive the refresh interval so a slow scan never leaves a gap.
            cache.set(f"highlights:{hours}", digest, ttl=CFG.HIGHLIGHTS_TTL_SECONDS * 3)
            out[hours] = digest
        log.info("highlights: scanned %d stations for %s in %.1fs",
                 len(scanned), HIGHLIGHT_WINDOWS, time.monotonic() - started)
        return out


async def get_highlights(couch: CouchClient, cache: TTLCache, hours: int) -> dict:
    """The Trends digest for one window; falls back to a full refresh if the cache is cold."""
    if hours not in HIGHLIGHT_WINDOWS:
        raise ValueError(f"hours must be one of {HIGHLIGHT_WINDOWS}")
    cached = cache.get(f"highlights:{hours}")
    if cached is not None:
        return cached
    if _highlight_lock.locked():
        # A refresh is already running — wait for it rather than starting another.
        async with _highlight_lock:
            cached = cache.get(f"highlights:{hours}")
            if cached is not None:
                return cached
    return (await refresh_highlights(couch, cache))[hours]


async def highlights_refresher(couch: CouchClient, cache: TTLCache) -> None:
    """Background loop: keep every Trends window warm. Run as an asyncio task from the app lifespan."""
    while True:
        try:
            await refresh_highlights(couch, cache)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — never let the refresher die
            log.warning("highlights refresh failed: %r", e)
        await asyncio.sleep(CFG.HIGHLIGHTS_TTL_SECONDS)
