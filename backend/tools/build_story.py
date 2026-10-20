"""Build a precomputed storm "story" for the Stories tab.

    python -m tools.build_story bering-2026-10

Produces frontend/public/stories/<id>.json: hourly frames of every buoy's
deviation from its OWN normal, an estimated track, an event log for on-map
annotations, and the cold-wake statistics. Playback never queries CouchDB.

Three choices worth knowing before trusting the output:

1. Anomalies, not raw values. Raw pressure differs by location and a broken
   barometer reads a plausible-but-wrong number (WHOTS sat at a 989 hPa median
   for months). Each buoy is compared with its own pre-storm median, and a buoy
   whose median disagrees with its neighbours' is excluded as offset.

2. Sea temperature is measured against the SEASONAL TREND, not a flat baseline.
   Northern water cools through autumn on its own; a flat baseline would credit
   the storm with ordinary seasonal cooling. Each buoy's trend is fitted from the
   two weeks before the storm and extended through the window, and the cold wake
   is the cooling beyond that line.

3. The track is "where the network felt the storm most", not the storm centre.
   It is a weighted centroid of the deepest few buoys each hour, so by
   construction it lies within the network -- if the true low passes over open
   water between buoys, this shows the nearest edge of it. The uncertainty radius
   is drawn so the UI does not overstate it.
"""
import asyncio
import json
import re
import math
import os
import statistics
import sys
import time

from buoys import service
from buoys.cache import TTLCache
from buoys.couch import get_couch_client

HOUR, DAY = 3600, 86400
VARS = {"p": "pressure", "w": "windSpeed", "g": "gustSpeed", "t": "waterTemperature", "h": "waveHeight"}

STORIES = {
    "bering-2026-10": {
        "title": "960 hPa in the Bering Sea",
        "subtitle": "The deepest storm on the network this season · 6–16 October 2026",
        "lat": (48, 67), "lon360": (160, 207),
        "t0": 1791244800,          # 2026-10-06 00Z
        "t1": 1792108800,          # 2026-10-16 00Z -- long enough to watch the cold wake persist
        "baseline_from": 1790035200,  # 2026-09-22 00Z, start of hourly: history
        "view": {"center": [57.5, 186.0], "zoom": 4},
        "intro": ("On 8 October a buoy 142 nautical miles north-northeast of Attu recorded the "
                  "lowest pressure anywhere on the network in six months. Watch the low sweep "
                  "across the Bering Sea, the wind follow it, and the cold wake it leaves in "
                  "the ocean behind it."),
    },
}

# Fault thresholds. Spikes: QARTOD spike-test limit (see despike).
SPIKE = {"p": 15.0, "t": 2.0}
# Offset: a buoy whose baseline pressure differs from its nearest neighbours'
# median by more than this is excluded (a WHOTS-type miscalibration).
OFFSET_HPA = 12.0
TRACK_THRESHOLD = -8.0   # hPa anomaly before the network is considered to "feel" a low
TRACK_SEARCH_KM = 700    # how far the low may be from its previous position per step
TRACK_GAP_HOURS = 6      # hours with no qualifying buoy before the track is ended
WAKE_REACH_KM = 800      # buoys farther than this from the track are not attributed a wake
WAKE_HOURS = 96          # how long after closest approach the cooling is attributed

def is_buoy(station_id):
    """Moored NDBC buoys have 5-character numeric-ish ids (46070); C-MAN and tide
    stations are letter codes (nkla2). Land sites can sit on hilltops -- Nikolski
    'White Alice' gusted ~2x its sea-level neighbour -- so marine peaks use buoys."""
    return len(station_id) == 5 and station_id[:2].isdigit()
WAKE_RECOVERED = -0.3    # degC: anomaly back above this counts as recovered


def tok(kind, v):
    """A unit token the frontend formats in the viewer's chosen units.
    kinds: hPa (absolute pressure), dhPa (pressure difference), ms (wind),
    m (wave height), dC (temperature difference)."""
    return "{" + f"{kind}:{v}" + "}"


def lon360(x):
    return x % 360


def km(a_lat, a_lon, b_lat, b_lon):
    r = math.radians
    dp, dl = r(b_lat - a_lat), r(b_lon - a_lon)
    x = math.sin(dp / 2) ** 2 + math.cos(r(a_lat)) * math.cos(r(b_lat)) * math.sin(dl / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(x))


def despike(series: dict, limit: float) -> tuple:
    """Drop isolated spikes with the QARTOD spike test (US IOOS QC standard).

    A sample is a spike only when it jumps away from BOTH neighbours and comes
    straight back: |v - (prev+next)/2| - |(next-prev)/2| > limit. A genuine steep
    fall has one neighbour close by, so it survives; a lone bad reading in a calm
    series does not.

    This replaced a "deviation from the +-3 sample median" rule, which a test
    caught deleting 46070's real 960 hPa minimum when fed 3-hourly data: the
    window was counted in samples, not hours, so sparse reporters had their
    storm minima thrown out as faults.
    """
    hrs = sorted(series)
    out, dropped = {}, 0
    for i, h in enumerate(hrs):
        v = series[h]
        if 0 < i < len(hrs) - 1:
            p, n = series[hrs[i - 1]], series[hrs[i + 1]]
            if abs(v - (p + n) / 2) - abs((n - p) / 2) > limit:
                dropped += 1
                continue
        out[h] = v
    return out, dropped


def fit_trend(series: dict):
    """Least-squares line through DAILY medians -- robust to single bad hours and
    to a short weather event inside the fitting window."""
    days = {}
    for h, v in series.items():
        days.setdefault(h - h % DAY, []).append(v)
    pts = [(d + DAY / 2, statistics.median(v)) for d, v in days.items() if len(v) >= 6]
    if len(pts) < 5:
        return None
    n = len(pts)
    mx = sum(x for x, _ in pts) / n
    my = sum(y for _, y in pts) / n
    sxx = sum((x - mx) ** 2 for x, _ in pts)
    if sxx == 0:
        return None
    b = sum((x - mx) * (y - my) for x, y in pts) / sxx
    return lambda x: my + b * (x - mx), b * DAY  # value fn, slope in degC/day


async def build(story_id: str) -> dict:
    cfg = STORIES[story_id]
    t0, t1, b0 = cfg["t0"], cfg["t1"], cfg["baseline_from"]
    hours = list(range(t0, t1 + 1, HOUR))
    couch = await get_couch_client()
    async with couch:
        snap = await service.get_snapshot(couch, TTLCache(60), located_only=True)
        region = [s for s in snap
                  if cfg["lat"][0] <= s["lat"] <= cfg["lat"][1]
                  and cfg["lon360"][0] <= lon360(s["lon"]) <= cfg["lon360"][1]
                  and "standard" in (s.get("available") or [])]
        sem = asyncio.Semaphore(12)

        async def fetch(s):
            async with sem:
                got = await couch.get_hourly_multi(s["id"], "standard", list(VARS.values()), b0, t1)
            return s, {k: got[f] for k, f in VARS.items()}

        raw = await asyncio.gather(*[fetch(s) for s in region])

        stations, excluded = [], []
        for s, series in raw:
            if not any(series.values()):
                continue
            st = {"id": s["id"], "name": s["name"], "lat": round(s["lat"], 3),
                  "lon": round(lon360(s["lon"]), 3), "series": {}, "base": {}}
            for k in ("p", "t"):
                if series[k]:
                    clean, n = despike(series[k], SPIKE[k])
                    if n:
                        excluded.append({"station": s["id"], "var": k,
                                         "reason": f"{n} spike sample(s) dropped"})
                    series[k] = clean
            pre_p = [v for h, v in series["p"].items() if h < t0]
            if len(pre_p) >= 48:
                st["base"]["p"] = statistics.median(pre_p)
            pre_t = {h: v for h, v in series["t"].items() if h < t0}
            trend = fit_trend(pre_t) if pre_t else None
            if trend:
                st["trend_t"], st["base"]["t_slope_per_day"] = trend[0], round(trend[1], 3)
            st["series"] = series
            stations.append(st)

        # Offset check: compare each barometer's baseline with its nearest neighbours.
        with_p = [s for s in stations if "p" in s["base"]]
        for s in with_p:
            nbrs = sorted((km(s["lat"], s["lon"], o["lat"], o["lon"]), o["base"]["p"])
                          for o in with_p if o is not s)[:4]
            ref = statistics.median(v for _, v in nbrs) if nbrs else None
            if ref is not None and abs(s["base"]["p"] - ref) > OFFSET_HPA:
                excluded.append({"station": s["id"], "var": "p",
                                 "reason": f"baseline {s['base']['p']:.1f} hPa vs neighbours "
                                           f"{ref:.1f} -- offset barometer, excluded"})
                del s["base"]["p"]

        # Frames: station-major arrays, one value per hour, null where missing.
        def frame(s, k):
            ser = s["series"][k]
            out = []
            for h in hours:
                v = ser.get(h)
                if v is None:
                    out.append(None)
                elif k == "p":
                    out.append(round(v - s["base"]["p"], 1) if "p" in s["base"] else None)
                elif k == "t":
                    out.append(round(v - s["trend_t"](h + HOUR / 2), 2) if "trend_t" in s else None)
                else:
                    out.append(round(v, 1))
            return out

        for s in stations:
            s["frames"] = {k: frame(s, k) for k in VARS}

        # Track: ONE connected system. Start from the deepest anomaly and follow
        # it forward and backward in time, accepting only buoys within reach of
        # the previous position. A per-hour global minimum would hop between
        # unrelated lows (the window opens on the tail of the 4-5 Oct Alaska storm).
        def centre(i, lat, lon):
            cand = sorted(((s["frames"]["p"][i], s) for s in stations
                           if s["frames"]["p"][i] is not None
                           and s["frames"]["p"][i] < TRACK_THRESHOLD
                           and km(lat, lon, s["lat"], s["lon"]) <= TRACK_SEARCH_KM),
                          key=lambda x: x[0])[:3]
            if not cand:
                return None
            wsum = sum(-a for a, _ in cand)
            clat = sum(-a * s["lat"] for a, s in cand) / wsum
            clon = sum(-a * s["lon"] for a, s in cand) / wsum
            r = max([km(clat, clon, s["lat"], s["lon"]) for _, s in cand] + [50])
            return {"t": hours[i], "lat": round(clat, 3), "lon": round(clon, 3), "r_km": round(r),
                    "minAnom": cand[0][0], "station": cand[0][1]["id"]}

        seed = min(((s["frames"]["p"][i], i, s) for s in stations
                    for i in range(len(hours)) if s["frames"]["p"][i] is not None),
                   key=lambda x: x[0])
        found = {}
        for step in (1, -1):
            lat, lon, miss, i = seed[2]["lat"], seed[2]["lon"], 0, seed[1]
            while 0 <= i < len(hours):
                c = centre(i, lat, lon)
                if c:
                    found[i] = c
                    lat, lon, miss = c["lat"], c["lon"], 0
                else:
                    miss += 1
                    if miss > TRACK_GAP_HOURS:
                        break
                i += step
        track = [found[i] for i in sorted(found)]

        # Deepest absolute reading, refined against full-resolution obs.
        deepest = None
        for s in stations:
            if "p" not in s["base"]:
                continue
            for h, v in s["series"]["p"].items():
                if t0 <= h <= t1 and (deepest is None or v < deepest[0]):
                    deepest = (v, h, s)
        if deepest:
            v, h, s = deepest
            obs = await couch._all_docs_between(f"obs:{s['id']}:standard:{h - 3 * HOUR}",
                                                f"obs:{s['id']}:standard:{h + 3 * HOUR}")
            pts = [(d["values"]["pressure"], d["ts"]) for d in obs
                   if (d.get("values") or {}).get("pressure") is not None]
            if pts:
                v, h = min(pts)
            deepest = {"station": s["id"], "name": s["name"], "hPa": round(v, 1), "t": h,
                       "lat": s["lat"], "lon": s["lon"]}

    # Fastest 24h fall, peak gust, biggest waves -- absolute values.
    fall = gust = wave = land_gust = None
    for s in stations:
        if "p" in s["base"]:
            ser = s["series"]["p"]
            for h, v in ser.items():
                q = ser.get(h + DAY)
                if q is not None and t0 - DAY <= h <= t1 - DAY and (fall is None or v - q > fall["hPa"]):
                    fall = {"station": s["id"], "name": s["name"], "hPa": round(v - q, 1),
                            "from": h, "to": h + DAY, "fromHPa": round(v, 1), "toHPa": round(q, 1)}
        for k, best in (("g", "gust"), ("h", "wave")):
            if k == "g" and not is_buoy(s["id"]):
                for h, v in s["series"]["g"].items():
                    if t0 <= h <= t1 and (land_gust is None or v > land_gust["value"]):
                        land_gust = {"station": s["id"], "name": s["name"], "value": round(v, 1), "t": h}
                continue
            for h, v in s["series"][k].items():
                if not t0 <= h <= t1:
                    continue
                cur = gust if k == "g" else wave
                if cur is None or v > cur["value"]:
                    rec = {"station": s["id"], "name": s["name"], "value": round(v, 1), "t": h}
                    if k == "g":
                        gust = rec
                    else:
                        wave = rec

    # Cold wake, attributed only AFTER the tracked storm passed each buoy. Two
    # measures bracket the real effect: the raw drop (overstates it -- it includes
    # seasonal cooling) and the drop beyond the extrapolated seasonal trend
    # (depends on extrapolating a line fitted before the storm).
    hidx = {h: i for i, h in enumerate(hours)}
    wake = []
    for s in stations:
        raw = s["series"]["t"]
        tf = s["frames"]["t"]
        if "trend_t" not in s or not track:
            continue
        near = min(track, key=lambda c: km(c["lat"], c["lon"], s["lat"], s["lon"]))
        dist = km(near["lat"], near["lon"], s["lat"], s["lon"])
        if dist > WAKE_REACH_KM:
            continue
        ia = hidx[near["t"]]
        pre = [raw[h] for h in hours[max(0, ia - 24):ia] if h in raw]
        pre_a = [tf[i] for i in range(max(0, ia - 6), ia) if tf[i] is not None]
        after = [i for i in range(ia, min(len(hours), ia + WAKE_HOURS))
                 if tf[i] is not None and hours[i] in raw]
        if len(pre) < 6 or not pre_a or not after:
            continue
        i_min = min(after, key=lambda i: tf[i])
        trend_drop = tf[i_min] - statistics.mean(pre_a)
        raw_drop = raw[hours[i_min]] - statistics.mean(pre)
        end_anom = next((tf[i] for i in range(len(tf) - 1, -1, -1) if tf[i] is not None), None)
        base_a = statistics.mean(pre_a)
        recovered = next((hours[i] for i in range(i_min, len(tf))
                          if tf[i] is not None and tf[i] - base_a > WAKE_RECOVERED), None)
        wake.append({"station": s["id"], "name": s["name"], "approachKm": round(dist),
                     "approach": near["t"], "t": hours[i_min],
                     "coolingC": round(trend_drop, 2), "rawDropC": round(raw_drop, 2),
                     "endAnomC": None if end_anom is None else round(end_anom - base_a, 2),
                     "recovered": recovered,
                     "seasonalSlopePerDay": s["base"]["t_slope_per_day"]})
    wake.sort(key=lambda w: w["coolingC"])

    # Event log for the annotations.
    events = []
    if track:
        a = track[0]
        events.append({"t": a["t"], "station": a["station"], "kind": "onset",
                       "text": f"The low takes hold — {a['station']} is {tok('dhPa', round(abs(a['minAnom']), 1))} "
                               f"below its normal and still falling"})
    if fall:
        events.append({"t": fall["from"], "station": fall["station"], "kind": "fall",
                       "text": f"{fall['station']}'s barometer begins a {tok('dhPa', fall['hPa'])} fall in 24 hours "
                               f"({tok('hPa', fall['fromHPa'])} → {tok('hPa', fall['toHPa'])})"})
    if deepest:
        events.append({"t": deepest["t"], "station": deepest["station"], "kind": "deepest",
                       "text": f"{deepest['station']} bottoms out at {tok('hPa', deepest['hPa'])} — the lowest "
                               f"pressure anywhere on the network this season"})
    if gust:
        events.append({"t": gust["t"], "station": gust["station"], "kind": "gust",
                       "text": f"Strongest gust at sea: {tok('ms', gust['value'])} at {gust['station']}"})
    if land_gust and (not gust or land_gust["value"] > gust["value"]):
        events.append({"t": land_gust["t"], "station": land_gust["station"], "kind": "gust-land",
                       "text": f"On land, the exposed {land_gust['name'].split(',')[0]} site gusts to "
                               f"{tok('ms', land_gust['value'])} — hilltop exposure, about twice its neighbour"})
    if wave:
        events.append({"t": wave["t"], "station": wave["station"], "kind": "wave",
                       "text": f"Seas peak at {tok('m', wave['value'])} at {wave['station']}"})
    if wake:
        w = wake[0]
        events.append({"t": w["t"], "station": w["station"], "kind": "wake",
                       "text": f"Cold wake: {w['station']} has cooled {tok('dC', round(abs(w['rawDropC']), 2))} since the "
                               f"storm arrived — {tok('dC', round(abs(w['coolingC']), 2))} beyond the normal autumn cooling"})
        if w["recovered"]:
            events.append({"t": w["recovered"], "station": w["station"], "kind": "recover",
                           "text": f"{w['station']} is back on its seasonal trend, "
                                   f"{(w['recovered'] - w['t']) / DAY:.0f} days after its coldest point"})
    # The most persistent wake among buoys the storm actually crossed.
    lasting = [w for w in wake if w["endAnomC"] is not None and w["endAnomC"] < WAKE_RECOVERED
               and w["coolingC"] <= -0.5]
    if lasting:
        w = min(lasting, key=lambda w: w["endAnomC"])
        events.append({"t": t1, "station": w["station"], "kind": "persist",
                       "text": f"{(t1 - w['approach']) / DAY:.0f} days after the storm passed, {w['station']} "
                               f"is still {tok('dC', round(abs(w['endAnomC']), 2))} colder than its seasonal trend"})
    if track:
        z = track[-1]
        events.append({"t": z["t"], "station": z["station"], "kind": "exit",
                       "text": "The low fades from the network"})
    events.sort(key=lambda e: e["t"])

    return {
        "id": story_id, "title": cfg["title"], "subtitle": cfg["subtitle"], "intro": cfg["intro"],
        "generatedAt": int(time.time()), "view": cfg["view"],
        "hours": {"t0": t0, "t1": t1, "step": HOUR, "n": len(hours)},
        "vars": {"p": "pressure anomaly (hPa vs own median)",
                 "t": "sea temperature anomaly (°C vs seasonal trend)",
                 "w": "wind (m/s)", "g": "gust (m/s)", "h": "wave height (m)"},
        "stations": [{"id": s["id"], "name": s["name"], "lat": s["lat"], "lon": s["lon"],
                      "frames": s["frames"]} for s in stations],
        "track": track, "events": events,
        "stats": {"deepest": deepest, "fastestFall24h": fall, "peakGust": gust, "landGust": land_gust,
                  "peakWave": wave, "coldWake": wake[:10]},
        "excluded": excluded,
        "method": {"pressureBaseline": "median of hourly readings before the window",
                   "seaTempBaseline": "least-squares seasonal trend through daily medians before the window",
                   "track": "weighted centroid of the 3 deepest buoys each hour; lies inside the network by construction",
                   "spikeLimits": SPIKE, "offsetHPa": OFFSET_HPA},
    }


async def main():
    story_id = sys.argv[1] if len(sys.argv) > 1 else "bering-2026-10"
    out_dir = os.environ.get("STORY_OUT", "/out")
    story = await build(story_id)
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, f"{story_id}.json"), "w") as f:
        json.dump(story, f, separators=(",", ":"))
    index = [{"id": k, "title": v["title"], "subtitle": v["subtitle"]} for k, v in STORIES.items()]
    with open(os.path.join(out_dir, "index.json"), "w") as f:
        json.dump(index, f, separators=(",", ":"))
    s = story["stats"]
    print(f"{story_id}: {len(story['stations'])} stations x {story['hours']['n']} hours, "
          f"{len(story['track'])} track points, {len(story['events'])} events, "
          f"{len(story['excluded'])} exclusions")
    print(json.dumps({k: s[k] for k in ("deepest", "fastestFall24h", "peakGust", "landGust", "peakWave")}, indent=1))
    print("cold wake (top 6):")
    for w in s["coldWake"][:8]:
        print(f"  {w['station']:<7} passed {time.strftime('%m-%d %H:00', time.gmtime(w['approach']))} "
              f"at {w['approachKm']:>3} km | min {time.strftime('%m-%d %H:00', time.gmtime(w['t']))} "
              f"raw {w['rawDropC']:+.2f} C, beyond trend {w['coolingC']:+.2f} C | at end {w['endAnomC']} "
              f"| seasonal {w['seasonalSlopePerDay']:+.3f} C/day")
    tr = story["track"]
    if tr:
        print(f"track: {time.strftime('%m-%d %H:00', time.gmtime(tr[0]['t']))} .. "
              f"{time.strftime('%m-%d %H:00', time.gmtime(tr[-1]['t']))}, {len(tr)} points, "
              f"from ({tr[0]['lat']},{tr[0]['lon']}) to ({tr[-1]['lat']},{tr[-1]['lon']})")
    print("excluded:", json.dumps(story["excluded"], indent=1))
    print("events:")
    for e in story["events"]:
        print(f"  {time.strftime('%m-%d %H:%M', time.gmtime(e['t']))}  {e['text']}")
    leftovers = [e["text"] for e in story["events"] if re.search(r"\d\s*(hPa|m/s|°C)", e["text"])]
    assert not leftovers, f"event text still has baked-in units: {leftovers}"


if __name__ == "__main__":
    asyncio.run(main())
