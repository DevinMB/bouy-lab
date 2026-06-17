"""Entry point: python -m buoys.ingest"""
import asyncio
import logging
import time
from datetime import datetime, timezone

import httpx

from buoys.config import CFG
from buoys.ndbc import (
    fetch_station_table_parsed,
    fetch_owner_map,
    fetch_all_stations,
    _make_client,
    STREAMS,
)
from buoys.parsing import parse_ndbc_file
from buoys.kafka_io import make_producer, publish_observation, publish_station, flush_producer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

# In-memory state carried across cycles
_station_cache: list = []
_owner_map: dict = {}
# Per (stationId, stream) high-water mark of the newest observation ts already
# published. Lets the first cycle backfill a window of history, then publish
# only genuinely-new rows on subsequent cycles.
_obs_hwm: dict = {}
# Cap on how many historical rows to backfill per stream the first time we see
# it (NDBC realtime2 files hold ~45 days of hourly data; the UI shows ~4 days).
BACKFILL_ROWS = 120


async def run_ingest_cycle(producer, last_station_refresh: float) -> float:
    now = time.time()

    async with _make_client() as client:
        # Refresh station table on a longer interval
        global _station_cache, _owner_map
        if now - last_station_refresh > CFG.STATION_TABLE_REFRESH_SECONDS or not _station_cache:
            log.info("Refreshing station table from NDBC...")
            try:
                _station_cache = await fetch_station_table_parsed(client)
                _owner_map = await fetch_owner_map(client)
                log.info("Loaded %d stations, %d owner names", len(_station_cache), len(_owner_map))

                updated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                for station in _station_cache:
                    owner_code = station.get("owner", "")
                    owner_name = _owner_map.get(owner_code, owner_code)
                    publish_station(producer, {
                        **station,
                        "owner": owner_name,
                        "ownerCode": owner_code,
                        "updatedAt": updated_at,
                    })
                flush_producer(producer)
                last_station_refresh = now
            except Exception as e:
                log.error("Station table refresh failed: %s", e)

    # Determine which stations to ingest
    if CFG.INGEST_STATION_FILTER:
        station_ids = CFG.INGEST_STATION_FILTER
        log.info("Using station filter: %s", station_ids)
    else:
        station_ids = [s["stationId"] for s in _station_cache]

    if not station_ids:
        log.warning("No station IDs to ingest")
        return last_station_refresh

    log.info("Fetching realtime2 data for %d stations...", len(station_ids))
    try:
        all_data = await fetch_all_stations(station_ids, CFG.INGEST_MAX_CONCURRENCY)
    except Exception as e:
        log.error("Failed to fetch station data: %s", e)
        return last_station_refresh

    obs_count = 0
    for station_id, data in all_data.items():
        for stream, text in data.get("streams", {}).items():
            rows = parse_ndbc_file(text, stream)  # newest-first
            if not rows:
                continue

            key = (station_id, stream)
            hwm = _obs_hwm.get(key)
            if hwm is None:
                # First sighting this process: backfill a bounded history window.
                to_publish = rows[:BACKFILL_ROWS]
            else:
                # Steady state: only rows newer than what we've already published.
                to_publish = [r for r in rows if r["ts"] > hwm]

            for r in to_publish:
                publish_observation(producer, {
                    "stationId": station_id,
                    "stream": stream,
                    "ts": r["ts"],
                    "observedAt": r["observedAt"],
                    "values": r.get("values", {}),
                })
                obs_count += 1

            _obs_hwm[key] = rows[0]["ts"]  # newest row

    flush_producer(producer)
    log.info("Published %d observations", obs_count)
    return last_station_refresh


async def main():
    log.info("Starting ingest service")
    producer = make_producer()
    last_station_refresh = 0.0

    while True:
        try:
            last_station_refresh = await run_ingest_cycle(producer, last_station_refresh)
        except Exception as e:
            log.error("Ingest cycle failed: %s", e, exc_info=True)

        log.info("Sleeping %ds until next cycle", CFG.INGEST_INTERVAL_SECONDS)
        await asyncio.sleep(CFG.INGEST_INTERVAL_SECONDS)


if __name__ == "__main__":
    asyncio.run(main())
