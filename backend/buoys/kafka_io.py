import json
import logging
from confluent_kafka import Producer, Consumer, KafkaError
from buoys.config import CFG, kafka_producer_conf, kafka_consumer_conf

log = logging.getLogger(__name__)


def _delivery_report(err, msg):
    if err is not None:
        log.error("Kafka delivery failed for %s: %s", msg.key(), err)


def make_producer() -> Producer:
    return Producer(kafka_producer_conf())


def make_consumer(group_id: str = None) -> Consumer:
    gid = group_id or CFG.KAFKA_CONSUMER_GROUP
    return Consumer(kafka_consumer_conf(gid))


def _produce(producer: Producer, topic: str, key: str, value: dict) -> None:
    """Produce one message, applying backpressure when the local queue fills.

    During the history backfill we can enqueue faster than librdkafka drains to
    the broker; produce() then raises BufferError. poll() serves delivery
    callbacks and frees queue space, so we drain and retry rather than drop data.
    """
    payload = json.dumps(value).encode("utf-8")
    k = key.encode("utf-8")
    for attempt in range(10):
        try:
            producer.produce(topic=topic, key=k, value=payload, on_delivery=_delivery_report)
            return
        except BufferError:
            producer.poll(1.0)
    # Final attempt after a full flush; let any error propagate.
    producer.flush(10.0)
    producer.produce(topic=topic, key=k, value=payload, on_delivery=_delivery_report)


def publish_observation(producer: Producer, obs: dict) -> None:
    _produce(producer, CFG.KAFKA_OBSERVATIONS_TOPIC, obs["stationId"], obs)
    # Serve delivery callbacks without blocking so the queue keeps draining.
    producer.poll(0)


def publish_station(producer: Producer, station: dict) -> None:
    _produce(producer, CFG.KAFKA_STATIONS_TOPIC, station["stationId"], station)
    producer.poll(0)


def flush_producer(producer: Producer, timeout: float = 30.0) -> None:
    remaining = producer.flush(timeout=timeout)
    if remaining > 0:
        log.warning("Kafka flush timed out with %d messages remaining", remaining)


def consume_batch(consumer: Consumer, topics: list, batch_size: int = 50, timeout: float = 1.0) -> list:
    """
    Poll for up to batch_size messages. Returns [(topic, key, value_dict)].
    Does NOT commit — caller commits after durable write.
    """
    consumer.subscribe(topics)
    messages = []
    empty_polls = 0

    while len(messages) < batch_size and empty_polls < 3:
        msg = consumer.poll(timeout=timeout)
        if msg is None:
            empty_polls += 1
            continue
        if msg.error():
            if msg.error().code() == KafkaError._PARTITION_EOF:
                empty_polls += 1
                continue
            log.error("Kafka consumer error: %s", msg.error())
            empty_polls += 1
            continue

        empty_polls = 0
        try:
            key = msg.key().decode("utf-8") if msg.key() else None
            value = json.loads(msg.value().decode("utf-8"))
            messages.append((msg.topic(), key, value))
        except Exception as e:
            log.warning("Failed to decode Kafka message: %s", e)

    return messages
