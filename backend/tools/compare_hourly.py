"""Compare the API's live trend computation against phase 2's hourly: documents.

Run before switching any read path onto `hourly:` (docs/flink-migration.md).

Three computations over the same stations and window:

    A  old        service._trend_from_stations -- the real code, unfiltered
    B  old+filter the same, with SANE_RANGES applied per reading
    C  new        aggregated from hourly: docs' `last` field

C should equal B exactly: Flink filters SANE_RANGES before aggregating, so the
new path is the sanitised one. C differing from A is therefore expected, and
the A-vs-B delta isolates exactly how much of it the filter explains -- which
matters because `_trend_from_stations` does NOT filter today, while the Trends
digest does. Switching the regional trend onto hourly: makes the two consistent
and changes regional trend output wherever a station reported out of range.

Usage, from the backend directory:

    python -m tools.compare_hourly --stream standard --field waterTemperature --hours 48
    python -m tools.compare_hourly --stations 41013,41029,bzst2 --hours 24
"""
import argparse
import asyncio
import json
import sys
import time

from buoys import service
from buoys.config import CFG
from buoys.couch import CouchClient, get_couch_client
from buoys.cache import TTLCache
from buoys.service import SANE_RANGES, MAX_REGION_STATIONS


async def hourly_buckets(couch, station_ids, stream, field, t0, t1):
    """The new path: one _id range per station over hourly: docs, keyed by hour.

    `couch` must be a client bound to the hourly database, which is separate
    from world_of_buoys -- hourly: is a rebuildable cache, so its retention is
    "drop the database" (see docs/flink-migration.md). Switching the API over
    means a second CouchClient, not a new prefix on the existing one.
    """
    prefix = lambda sid: f"hourly:{sid}:{stream}:{field}:"
    out = {}
    sem = asyncio.Semaphore(24)

    async def one(sid):
        async with sem:
            docs = await couch._all_docs_range(prefix(sid))
        seen = {}
        for d in docs:
            hr, last = d.get("hour"), d.get("last")
            if hr is None or last is None:
                continue
            if t0 <= hr <= t1:
                seen[hr] = float(last)
        return seen

    for seen in await asyncio.gather(*[one(s) for s in station_ids]):
        for hr, v in seen.items():
            out.setdefault(hr, []).append(v)
    return out


async def old_buckets(couch, station_ids, stream, field, t0, t1, limit, sane):
    """The old path, optionally with SANE_RANGES applied (B rather than A)."""
    lo, hi = SANE_RANGES.get(field, (float("-inf"), float("inf")))
    sem = asyncio.Semaphore(24)

    async def one(sid):
        async with sem:
            raw = await couch.get_series(sid, stream, field, limit)
        seen = {}
        for pt in raw:
            ts, val = pt.get("ts"), pt.get("value")
            if ts is None or val is None:
                continue
            val = float(val)
            if sane and not (lo <= val <= hi):
                continue
            b = (ts // 3600) * 3600
            if t0 <= b <= t1 and b not in seen:
                seen[b] = val
        return seen

    out = {}
    for seen in await asyncio.gather(*[one(s) for s in station_ids]):
        for b, v in seen.items():
            out.setdefault(b, []).append(v)
    return out


def summarise(buckets):
    return {b: {"mean": sum(v) / len(v), "min": min(v), "max": max(v), "count": len(v)}
            for b, v in buckets.items()}


def diff(label_a, a, label_b, b, tol=1e-6, show=6):
    keys = sorted(set(a) | set(b))
    bad = []
    for k in keys:
        pa, pb = a.get(k), b.get(k)
        if pa is None or pb is None:
            bad.append((k, "bucket only in " + (label_a if pb is None else label_b)))
            continue
        for f in ("mean", "min", "max", "count"):
            if abs(pa[f] - pb[f]) > (tol if f != "count" else 0):
                bad.append((k, f"{f}: {label_a}={pa[f]:.4f} {label_b}={pb[f]:.4f}"))
    print(f"\n{label_a} vs {label_b}: {len(keys)} bucket(s), {len(bad)} difference(s)")
    for k, msg in bad[:show]:
        print(f"    hour {k}: {msg}")
    return len(bad)


async def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--stream", default="standard")
    ap.add_argument("--field", default="waterTemperature")
    ap.add_argument("--hours", type=int, default=48)
    ap.add_argument("--stations", help="comma-separated; default: a sample of reporting stations")
    ap.add_argument("--sample", type=int, default=MAX_REGION_STATIONS)
    ap.add_argument("--hourly-db", default="world_of_buoys_hourly")
    args = ap.parse_args()

    couch = await get_couch_client()
    hourly = CouchClient(url=CFG.COUCHDB_URL, database=args.hourly_db,
                         user=CFG.COUCHDB_USER, password=CFG.COUCHDB_PASSWORD)
    async with couch, hourly:
        cache = TTLCache(ttl_seconds=60)
        if args.stations:
            ids = args.stations.split(",")
        else:
            snap = await service.get_snapshot(couch, cache, located_only=True)
            ids = [s["id"] for s in snap if args.stream in (s.get("available") or [])][:args.sample]
        t1 = int(time.time())
        t0 = t1 - args.hours * 3600
        limit = min(1000, max(48, args.hours + 12))
        print(f"{args.stream}:{args.field} over {args.hours}h, {len(ids)} station(s)")

        A = summarise(await old_buckets(couch, ids, args.stream, args.field, t0, t1, limit, sane=False))
        B = summarise(await old_buckets(couch, ids, args.stream, args.field, t0, t1, limit, sane=True))
        C = summarise(await hourly_buckets(hourly, ids, args.stream, args.field, t0, t1))

        n_ab = diff("A(old)", A, "B(old+filter)", B)
        n_bc = diff("B(old+filter)", B, "C(hourly)", C)
        n_ac = diff("A(old)", A, "C(hourly)", C)

        print(f"\n{'PASS' if n_bc == 0 else 'FAIL'}: hourly: matches the filtered old"
              f" computation in {len(B)} bucket(s)" if n_bc == 0 else
              f"\nFAIL: hourly: differs from the filtered old computation in {n_bc} place(s)")
        print(f"note: {n_ab} difference(s) between A and B are the SANE_RANGES filter alone,")
        print(f"      which is the behaviour change switching this read path introduces.")
        return 1 if n_bc else 0

sys.exit(asyncio.run(main()))
