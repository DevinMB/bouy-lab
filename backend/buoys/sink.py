"""Entry point: python -m buoys.sink"""
import asyncio
import logging
import signal
import sys
import time

from buoys.config import CFG
from buoys.kafka_io import make_consumer
from buoys.couch import CouchClient, get_couch_client

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

_running = True

# In-memory caches to keep the (one-time) history backfill from hammering CouchDB:
#  - station metadata rarely changes, so cache it instead of refetching per obs
#  - track the newest ts seen per (station, stream) so we only touch the "latest"
#    rollup for genuinely-new readings rather than every backfilled historical row
_station_meta_cache: dict = {}
_latest_hwm: dict = {}


def _handle_signal(sig, frame):
    global _running
    log.info("Received signal %s — shutting down", sig)
    _running = False


async def process_batch(couch: CouchClient, messages: list) -> None:
    for topic, key, value in messages:
        try:
            if topic == CFG.KAFKA_OBSERVATIONS_TOPIC:
                station_id = value.get("stationId", "")
                stream = value.get("stream", "")

                # Station meta for lat/lon/owner/type enrichment (cached)
                station_meta = _station_meta_cache.get(station_id)
                if station_meta is None:
                    station_doc = await couch.get_station(station_id)
                    station_meta = station_doc or {}
                    _station_meta_cache[station_id] = station_meta

                await couch.upsert_observation(value)

                # Only update the latest rollup for newer readings — historical
                # backfill rows are older than what we've already recorded.
                lk = (station_id, stream)
                incoming_ts = value.get("ts", 0)
                if incoming_ts > _latest_hwm.get(lk, 0):
                    await couch.upsert_latest_if_newer(station_id, stream, value, station_meta)
                    _latest_hwm[lk] = incoming_ts

            elif topic == CFG.KAFKA_STATIONS_TOPIC:
                await couch.upsert_station(value)
                # Refresh the cache so enrichment uses the latest owner/type names
                _station_meta_cache[value.get("stationId", "")] = value

        except Exception as e:
            log.error("Failed to process message from %s key=%s: %s", topic, key, e)


async def main():
    global _running

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    log.info("Starting sink service")

    # Ensure CouchDB is set up
    async with await get_couch_client() as couch:
        await couch.ensure_db_and_views()
        log.info("CouchDB database and views ensured")

    consumer = make_consumer()
    topics = [CFG.KAFKA_OBSERVATIONS_TOPIC, CFG.KAFKA_STATIONS_TOPIC]
    consumer.subscribe(topics)
    log.info("Subscribed to topics: %s", topics)

    async with await get_couch_client() as couch:
        while _running:
            messages = []
            try:
                # Collect a batch
                for _ in range(50):
                    msg = consumer.poll(timeout=0.2)
                    if msg is None:
                        break
                    if msg.error():
                        log.warning("Kafka error: %s", msg.error())
                        continue
                    import json
                    try:
                        key = msg.key().decode("utf-8") if msg.key() else None
                        value = json.loads(msg.value().decode("utf-8"))
                        messages.append((msg.topic(), key, value))
                    except Exception as e:
                        log.warning("Failed to decode message: %s", e)

                if messages:
                    await process_batch(couch, messages)
                    consumer.commit(asynchronous=False)
                    log.debug("Committed batch of %d messages", len(messages))
                else:
                    await asyncio.sleep(0.1)

            except Exception as e:
                log.error("Sink loop error: %s", e, exc_info=True)
                await asyncio.sleep(5)

    consumer.close()
    log.info("Sink shutdown complete")


if __name__ == "__main__":
    asyncio.run(main())
