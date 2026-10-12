"""Diff a Flink shadow CouchDB database against production, document by document.

This is what decides whether a phase of the Flink migration is ready to cut over
(docs/flink-migration.md). It is deliberately not "are they byte-identical" --
phase 1 fixes a bug in the Python sink, so some differences are expected and
have to be told apart from regressions.

Usage, from the backend directory:

    python -m tools.compare_shadow                       # all three types
    python -m tools.compare_shadow --type latest         # one type
    python -m tools.compare_shadow --sample 500          # cap docs per type
    python -m tools.compare_shadow --shadow-db other_db

Reads only. Exits non-zero if any unexplained difference is found, so it can
gate a cut-over from CI or a shell loop.

The comparison rules live in the pure functions below (no I/O) and are covered
by tests/test_compare_shadow.py -- the tolerances are subtle enough that the
cut-over decision should not rest on them being eyeballed.
"""
import argparse
import asyncio
import json
import sys

import httpx

from buoys.config import CFG

HIGH = "￰"
TYPES = ("obs", "station", "latest")

# Stations whose NDBC .ocean file carries several rows per timestamp, one per
# measurement depth. `obs:<station>:<stream>:<ts>` has no depth component, so
# those rows collide on one _id and one of them is silently discarded. The two
# writers discard opposite ones: the Python sink swallows the 409 and keeps the
# FIRST row, the Flink sink upserts and keeps the LAST. Neither is more correct
# -- the id scheme is lossy, and that is the actual bug (tracked separately).
# Differences confined to these pairs are reported as collisions rather than
# regressions. Re-measure by counting (stationId, stream, ts) keys delivered
# more than once on buoy-observations: it was exactly these two over a
# 400k-message window, 190 keys, every one carrying differing values.
KNOWN_ID_COLLISIONS = {("42022", "ocean"), ("42023", "ocean")}


# ── comparison rules (pure) ───────────────────────────────────────────────────

def strip_meta(doc: dict) -> dict:
    """Drop CouchDB bookkeeping. _rev differs by construction; _id is compared via the key."""
    return {k: v for k, v in doc.items() if not k.startswith("_")}


def water_temp_from_streams(streams: dict):
    """The waterTempC rule: standard first, then ocean, else None.

    Mirrors couch.upsert_latest_if_newer. Applied to the shadow's OWN streams,
    so it checks the shadow is internally consistent rather than that it matches
    production -- production can be stale on exactly this field.
    """
    std = ((streams.get("standard") or {}).get("values") or {}).get("waterTemperature")
    ocean = ((streams.get("ocean") or {}).get("values") or {}).get("waterTemperature")
    return std if std is not None else ocean


def compare_exact(shadow: dict, prod: dict) -> list:
    """obs: and station: must match field for field."""
    s, p = strip_meta(shadow), strip_meta(prod)
    diffs = []
    for key in sorted(set(s) | set(p)):
        if s.get(key, "<absent>") != p.get(key, "<absent>"):
            diffs.append(f"{key}: shadow={s.get(key, '<absent>')!r} prod={p.get(key, '<absent>')!r}")
    return diffs


def _meta_ok(field: str, sv, pv, station_id: str) -> bool:
    """The agreed tolerances for latest: metadata.

    Production only overwrites these when the incoming value is present, so it
    can hold a previous non-empty value where Flink writes the current one.
    Flink is not wrong in these cases; production is stale.
    """
    if sv == pv:
        return True
    if field == "name":
        # Production stores "" on creation when the feed carries an empty name
        # and then never overwrites it; Flink falls back to the station id.
        return pv == "" and sv == station_id
    if field in ("owner", "ttype"):
        # Production kept a previous non-empty value; Flink wrote the current
        # (empty) one.
        return sv in ("", None) and bool(pv)
    if field in ("lat", "lon"):
        # Production never writes null over a non-null location.
        return sv is None and pv is not None
    return False


def compare_latest(shadow: dict, prod: dict) -> tuple:
    """latest: -- returns (hard_diffs, expected_notes, streams_to_check).

    Expected under the FIX decision: the shadow may carry more streams, and
    newer entries for a stream, because production drops a reading whose ts is
    not the station's global newest. Anything else is a hard difference.
    """
    s, p = strip_meta(shadow), strip_meta(prod)
    station_id = s.get("stationId")
    hard, notes = [], []

    # 1. The shadow must be internally consistent on waterTempC.
    want = water_temp_from_streams(s.get("streams") or {})
    if s.get("waterTempC") != want:
        hard.append(f"waterTempC {s.get('waterTempC')!r} != standard-else-ocean rule {want!r}")

    # 2. available is always [] on both sides.
    for side, doc in (("shadow", s), ("prod", p)):
        if doc.get("available") != []:
            hard.append(f"{side} available={doc.get('available')!r}, expected []")

    s_ts, p_ts = s.get("ts"), p.get("ts")

    # 3. Streams: every production stream must be present and not older.
    s_streams = s.get("streams") or {}
    p_streams = p.get("streams") or {}
    to_check = []
    for name, p_entry in p_streams.items():
        s_entry = s_streams.get(name)
        if s_entry is None:
            # Cannot be judged here. A shadow job started from Kafka's latest
            # offset never sees observations published before it came up, so a
            # stream production accumulated earlier is legitimately absent.
            # A timestamp test gets this wrong: prod's entry can carry a ts
            # inside the shadow's time range while its Kafka message predates
            # the shadow's start offset (observed on latest:41029). The caller
            # resolves it by asking whether the shadow received any observation
            # for this stream at all -- if it did and still built no entry,
            # that is a real bug.
            to_check.append(name)
            continue
        s_sts, p_sts = s_entry.get("ts"), p_entry.get("ts")
        if isinstance(s_sts, int) and isinstance(p_sts, int) and s_sts < p_sts:
            hard.append(f"streams.{name}.ts {s_sts} older than prod {p_sts}")
        elif s_sts == p_sts and s_entry.get("values") != p_entry.get("values"):
            hard.append(f"streams.{name}: same ts {s_sts} but different values")
        elif s_sts != p_sts:
            notes.append(f"streams.{name} newer in shadow ({p_sts} -> {s_sts})")
    for name in set(s_streams) - set(p_streams):
        notes.append(f"streams.{name} only in shadow (prod dropped it)")

    # 4. The shadow must not be older than production -- but only decidable when
    # the shadow holds every stream prod does. prod's overall ts is the newest
    # across its streams, so if the shadow never received one of them, prod
    # being newer is arithmetic rather than a defect (observed on latest:cpxc1,
    # where the shadow only ever got ocean and prod's ts comes from standard).
    if isinstance(s_ts, int) and isinstance(p_ts, int) and s_ts < p_ts:
        if to_check:
            notes.append(f"overall ts older than prod ({s_ts} < {p_ts}), consistent with"
                         f" prod holding stream(s) the shadow has not received:"
                         f" {', '.join(sorted(to_check))}")
        else:
            hard.append(f"shadow ts {s_ts} is OLDER than prod ts {p_ts}")

    # 5. Remaining fields only have to agree when the station's overall ts does.
    if s_ts == p_ts:
        for field in ("stationId", "type", "observedAt", "name", "lat", "lon", "owner", "ttype"):
            if not _meta_ok(field, s.get(field), p.get(field), station_id):
                hard.append(f"{field}: shadow={s.get(field)!r} prod={p.get(field)!r}")
    else:
        notes.append(f"ts newer in shadow ({p_ts} -> {s_ts})")

    return hard, notes, to_check


# ── I/O ───────────────────────────────────────────────────────────────────────

async def fetch_range(client, db, prefix, limit=None):
    params = {
        "startkey": json.dumps(prefix),
        "endkey": json.dumps(prefix + HIGH),
        "include_docs": "true",
    }
    if limit is not None:
        params["limit"] = limit
    r = await client.get(f"{CFG.COUCHDB_URL.rstrip('/')}/{db}/_all_docs", params=params)
    if r.status_code == 404:
        return []
    r.raise_for_status()
    return [row["doc"] for row in r.json().get("rows", []) if row.get("doc")]


async def fetch_many(client, db, ids):
    """_all_docs with keys= -- one round trip for a batch of ids."""
    out = {}
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        r = await client.post(
            f"{CFG.COUCHDB_URL.rstrip('/')}/{db}/_all_docs",
            params={"include_docs": "true"},
            json={"keys": chunk},
        )
        r.raise_for_status()
        for row in r.json().get("rows", []):
            if row.get("doc"):
                out[row["key"]] = row["doc"]
    return out


def obs_prefix(station_id: str, stream: str) -> str:
    return f"obs:{station_id}:{stream}:"


async def shadow_saw_stream(client, shadow_db, station_id, stream) -> bool:
    """Did the shadow receive any observation at all for this station+stream?"""
    return bool(await fetch_range(client, shadow_db, obs_prefix(station_id, stream), limit=1))


async def compare_type(client, kind, shadow_db, prod_db, sample, show):
    shadow_docs = await fetch_range(client, shadow_db, f"{kind}:", limit=sample)
    if not shadow_docs:
        print(f"\n{kind}: no documents in {shadow_db} -- nothing to compare")
        return 0, 0
    ids = [d["_id"] for d in shadow_docs]
    prod_docs = await fetch_many(client, prod_db, ids)

    missing, hard_total, noted, collided = [], 0, 0, 0
    shown = 0
    for sdoc in shadow_docs:
        pdoc = prod_docs.get(sdoc["_id"])
        if pdoc is None:
            missing.append(sdoc["_id"])
            continue
        if kind == "latest":
            hard, notes, to_check = compare_latest(sdoc, pdoc)
            for stream in to_check:
                if await shadow_saw_stream(client, shadow_db, sdoc.get("stationId"), stream):
                    hard.append(f"streams.{stream}: shadow received observations"
                                f" for it but built no entry")
                else:
                    notes.append(f"streams.{stream} only in prod (never delivered"
                                 f" into the shadow's offset window)")
        else:
            hard, notes = compare_exact(sdoc, pdoc), []
            if hard and (sdoc.get("stationId"), sdoc.get("stream")) in KNOWN_ID_COLLISIONS:
                collided += 1
                hard, notes = [], ["upstream id collision: several rows share this _id"]
        if notes:
            noted += 1
        if hard:
            hard_total += 1
            if shown < show:
                shown += 1
                print(f"\n  MISMATCH {sdoc['_id']}")
                for d in hard:
                    print(f"    - {d}")

    print(f"\n{kind}: {len(shadow_docs)} compared | {hard_total} unexplained"
          f" | {noted} with expected-only differences | {len(missing)} shadow-only"
          + (f" | {collided} upstream id collision(s)" if collided else ""))
    if collided:
        print(f"  {collided} doc(s) differ only because several upstream rows share"
              f" one _id (see KNOWN_ID_COLLISIONS) -- the writers keep opposite rows")
    if missing[:5]:
        # Not a failure. Flink writes in parallel where the Python sink does
        # sequential PUTs, so the shadow runs ahead and documents appear here
        # before prod has written them. Expect this to shrink between runs;
        # a count that stays flat or grows is worth investigating.
        print("  present in shadow, not yet in prod -- the Python sink is behind")
        print(f"  (first 5): {missing[:5]}")
    return hard_total, len(shadow_docs)


async def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--shadow-db", default="world_of_buoys_shadow")
    ap.add_argument("--prod-db", default=CFG.COUCHDB_DATABASE)
    ap.add_argument("--type", choices=TYPES, action="append", dest="types")
    ap.add_argument("--sample", type=int, default=2000, help="max docs per type (default 2000)")
    ap.add_argument("--show", type=int, default=10, help="mismatches to print per type")
    args = ap.parse_args()

    kinds = args.types or list(TYPES)
    print(f"comparing shadow={args.shadow_db} against prod={args.prod_db}")
    print(f"types={kinds} sample={args.sample}")

    failures = 0
    compared = 0
    async with httpx.AsyncClient(
        auth=(CFG.COUCHDB_USER, CFG.COUCHDB_PASSWORD), timeout=120.0
    ) as client:
        for kind in kinds:
            hard, n = await compare_type(client, kind, args.shadow_db, args.prod_db,
                                         args.sample, args.show)
            failures += hard
            compared += n

    # An empty shadow database must not read as a pass -- this gates a cut-over,
    # and "nothing to compare" is the one answer that proves nothing.
    if compared == 0:
        print(f"\nNO DATA: nothing was compared. Is {args.shadow_db} populated?")
        return 2

    print(f"\n{'FAIL' if failures else 'PASS'}: {failures} unexplained difference(s)"
          f" across {compared} document(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
