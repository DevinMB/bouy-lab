"""Retention for the hourly: tier -- keep 90 days, purge the rest.

Decided 2026-10-13: hourly: keeps 90 days, daily: is kept forever, and the
removal runs here in bouy-lab (the Flink CouchDB sink never deletes, by
design). Run as a loop:   python -m buoys.retention
or once, counting only:  python -m buoys.retention --once --dry-run

Why _purge and not DELETE. A DELETE leaves a tombstone per document forever.
At ~78k hourly docs a day that is tens of millions of tombstones a year, which
every compaction has to carry. _purge removes the document outright.

How expired ids are found without a full scan. Ids are
`hourly:<station>:<stream>:<field>:<hour>` with the hour a fixed-width 10-digit
epoch, so each series is a contiguous key range ordered by hour. The walk asks
for the first key after the current series -- which names the next series AND
is that series' oldest hour -- then takes the bounded range below the cutoff
for that series, then jumps past it. Two small queries per series, about 6.5k
series, and it finds every series in the database, including stations that have
since gone quiet, without depending on latest: docs.
"""
import argparse
import asyncio
import logging
import time

from buoys.config import CFG
from buoys.couch import CouchClient, HIGH_SENTINEL

log = logging.getLogger("buoys.retention")

PREFIX = "hourly:"
HOUR = 3600
DAY = 86400
# The API serves hourly: for windows up to 30 days (LONG_WINDOW_HOURS). A
# retention shorter than that would delete data the site still reads, so a
# misconfigured RETENTION_HOURLY_DAYS (0, 1, a typo) is refused outright.
MIN_RETENTION_DAYS = 31
PURGE_BATCH = 100  # CouchDB [purge] max_document_id_number default


def cutoff_for(now: float, days: int) -> int:
    """First hour that is KEPT. Everything with hour < cutoff is expired."""
    if days < MIN_RETENTION_DAYS:
        raise ValueError(f"refusing hourly retention of {days} days; minimum is "
                         f"{MIN_RETENTION_DAYS} (the API reads hourly: out to 30 days)")
    t = int(now) - days * DAY
    return t - t % HOUR


def series_prefix(doc_id: str) -> str:
    """'hourly:41013:standard:windSpeed:1791288000' -> 'hourly:41013:standard:windSpeed:'"""
    return doc_id.rsplit(":", 1)[0] + ":"


def hour_of(doc_id: str) -> int:
    return int(doc_id.rsplit(":", 1)[1])


async def walk(couch: CouchClient, cutoff: int, dry_run: bool, max_purge: int) -> dict:
    db = CFG.COUCHDB_HOURLY_DATABASE
    stats = {"series": 0, "expired": 0, "purged": 0, "oldest_hour": None, "batches": 0}
    pending: dict = {}

    async def flush():
        if not pending:
            return
        if not dry_run:
            res = await couch.purge(dict(pending), db)
            got = len(res.get("purged", {}))
            if got != len(pending):
                log.warning("purge batch: asked %d, server reports %d", len(pending), got)
            stats["purged"] += got
            stats["batches"] += 1
        pending.clear()

    start = PREFIX
    while True:
        head = await couch.all_docs_rows(start, PREFIX + HIGH_SENTINEL, db, limit=1)
        if not head:
            break
        first_id = head[0]["id"]
        prefix = series_prefix(first_id)
        stats["series"] += 1
        try:
            oldest = hour_of(first_id)
        except ValueError:
            log.warning("skipping malformed id %r", first_id)
            start = prefix + HIGH_SENTINEL
            continue
        if stats["oldest_hour"] is None or oldest < stats["oldest_hour"]:
            stats["oldest_hour"] = oldest

        if oldest < cutoff:  # this series has something to expire
            rows = await couch.all_docs_rows(prefix, f"{prefix}{cutoff}", db, inclusive_end=False)
            for r in rows:
                rid = r["id"]
                # Belt and braces: the key range already excludes these, but a
                # retention job must never act on anything it has not re-checked.
                if not rid.startswith(PREFIX) or hour_of(rid) >= cutoff:
                    continue
                stats["expired"] += 1
                if stats["expired"] > max_purge:
                    log.warning("hit RETENTION_MAX_PER_RUN=%d; resuming next run", max_purge)
                    await flush()
                    return stats
                pending[rid] = [r["value"]["rev"]]
                if len(pending) >= PURGE_BATCH:
                    await flush()
        start = prefix + HIGH_SENTINEL
    await flush()
    return stats


async def run_once(dry_run: bool) -> dict:
    days = CFG.RETENTION_HOURLY_DAYS
    cutoff = cutoff_for(time.time(), days)
    couch = CouchClient(CFG.COUCHDB_URL, CFG.COUCHDB_DATABASE, CFG.COUCHDB_USER, CFG.COUCHDB_PASSWORD)
    async with couch:
        t = time.monotonic()
        stats = await walk(couch, cutoff, dry_run, CFG.RETENTION_MAX_PER_RUN)
    oldest = stats["oldest_hour"]
    first_expiry = time.strftime("%Y-%m-%d", time.gmtime(oldest + days * DAY)) if oldest else "n/a"
    log.info("hourly retention %s: keep %dd (cutoff %s) | %d series | %d expired | %d purged"
             " in %d batches | oldest hour %s -> first expiry %s | %.1fs",
             "DRY RUN" if dry_run else "run", days,
             time.strftime("%Y-%m-%d %H:00Z", time.gmtime(cutoff)), stats["series"],
             stats["expired"], stats["purged"], stats["batches"],
             time.strftime("%Y-%m-%d %H:00Z", time.gmtime(oldest)) if oldest else "n/a",
             first_expiry, time.monotonic() - t)
    return stats


async def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--once", action="store_true", help="run a single pass and exit")
    ap.add_argument("--dry-run", action="store_true", help="count only, purge nothing")
    args = ap.parse_args()
    dry = args.dry_run or CFG.RETENTION_DRY_RUN
    if args.once:
        await run_once(dry)
        return
    while True:
        try:
            await run_once(dry)
        except Exception as e:  # a failed pass must not kill the loop
            log.error("retention pass failed: %r", e)
        await asyncio.sleep(CFG.RETENTION_INTERVAL_SECONDS)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    asyncio.run(main())
