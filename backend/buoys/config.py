import os
from dataclasses import dataclass, field


def _env(key: str, default: str = "") -> str:
    """Read an env var and strip inline shell-style comments.

    docker-compose env_file passes the full line value including any
    trailing "  # comment" annotation, e.g.:
        KAFKA_SASL_MECHANISM=   # PLAIN | SCRAM-SHA-256 ...
    confluent-kafka rejects that comment text as an invalid config value.
    """
    val = os.environ.get(key, default)
    if " #" in val:
        val = val[: val.index(" #")]
    return val.strip()


@dataclass
class Config:
    # Kafka
    KAFKA_BOOTSTRAP_SERVERS: str = ""
    KAFKA_OBSERVATIONS_TOPIC: str = "buoy.observations"
    KAFKA_STATIONS_TOPIC: str = "buoy.stations"
    KAFKA_CONSUMER_GROUP: str = "world-of-buoys-sink"
    KAFKA_CLIENT_ID: str = "world-of-buoys"
    KAFKA_SECURITY_PROTOCOL: str = "PLAINTEXT"
    KAFKA_SASL_MECHANISM: str = ""
    KAFKA_SASL_USERNAME: str = ""
    KAFKA_SASL_PASSWORD: str = ""
    KAFKA_SSL_CA_LOCATION: str = ""

    # CouchDB
    COUCHDB_URL: str = ""
    COUCHDB_DATABASE: str = "world_of_buoys"
    COUCHDB_USER: str = ""
    COUCHDB_PASSWORD: str = ""

    # Ingest
    INGEST_INTERVAL_SECONDS: int = 1800
    STATION_TABLE_REFRESH_SECONDS: int = 86400
    INGEST_STATION_FILTER: list = field(default_factory=list)
    INGEST_MAX_CONCURRENCY: int = 16
    # Rows of history to backfill per stream on first sight (NDBC files hold ~45
    # days hourly). Raise temporarily for a one-time deep backfill, then lower it
    # back to avoid heavy re-publishing on every ingest restart.
    INGEST_BACKFILL_ROWS: int = 120

    # API
    SNAPSHOT_TTL_SECONDS: int = 60
    FRESH_WINDOW_HOURS: int = 24
    CORS_ALLOW_ORIGINS: list = field(default_factory=list)

    # Web
    WEB_PORT: int = 8080


def _load() -> Config:
    raw_filter = _env("INGEST_STATION_FILTER")
    station_filter = [s.strip() for s in raw_filter.split(",") if s.strip()] if raw_filter else []

    raw_cors = _env("CORS_ALLOW_ORIGINS")
    cors_origins = [s.strip() for s in raw_cors.split(",") if s.strip()] if raw_cors else []

    return Config(
        KAFKA_BOOTSTRAP_SERVERS=_env("KAFKA_BOOTSTRAP_SERVERS"),
        KAFKA_OBSERVATIONS_TOPIC=_env("KAFKA_OBSERVATIONS_TOPIC", "buoy.observations"),
        KAFKA_STATIONS_TOPIC=_env("KAFKA_STATIONS_TOPIC", "buoy.stations"),
        KAFKA_CONSUMER_GROUP=_env("KAFKA_CONSUMER_GROUP", "world-of-buoys-sink"),
        KAFKA_CLIENT_ID=_env("KAFKA_CLIENT_ID", "world-of-buoys"),
        KAFKA_SECURITY_PROTOCOL=_env("KAFKA_SECURITY_PROTOCOL", "PLAINTEXT"),
        KAFKA_SASL_MECHANISM=_env("KAFKA_SASL_MECHANISM"),
        KAFKA_SASL_USERNAME=_env("KAFKA_SASL_USERNAME"),
        KAFKA_SASL_PASSWORD=_env("KAFKA_SASL_PASSWORD"),
        KAFKA_SSL_CA_LOCATION=_env("KAFKA_SSL_CA_LOCATION"),
        COUCHDB_URL=_env("COUCHDB_URL"),
        COUCHDB_DATABASE=_env("COUCHDB_DATABASE", "world_of_buoys"),
        COUCHDB_USER=_env("COUCHDB_USER"),
        COUCHDB_PASSWORD=_env("COUCHDB_PASSWORD"),
        INGEST_INTERVAL_SECONDS=int(_env("INGEST_INTERVAL_SECONDS", "1800")),
        STATION_TABLE_REFRESH_SECONDS=int(_env("STATION_TABLE_REFRESH_SECONDS", "86400")),
        INGEST_STATION_FILTER=station_filter,
        INGEST_MAX_CONCURRENCY=int(_env("INGEST_MAX_CONCURRENCY", "16")),
        INGEST_BACKFILL_ROWS=int(_env("INGEST_BACKFILL_ROWS", "120")),
        SNAPSHOT_TTL_SECONDS=int(_env("SNAPSHOT_TTL_SECONDS", "60")),
        FRESH_WINDOW_HOURS=int(_env("FRESH_WINDOW_HOURS", "24")),
        CORS_ALLOW_ORIGINS=cors_origins,
        WEB_PORT=int(_env("WEB_PORT", "8080")),
    )


CFG = _load()


def kafka_producer_conf() -> dict:
    conf = {
        "bootstrap.servers": CFG.KAFKA_BOOTSTRAP_SERVERS,
        "client.id": CFG.KAFKA_CLIENT_ID,
        "security.protocol": CFG.KAFKA_SECURITY_PROTOCOL,
        "enable.idempotence": True,
        "acks": "all",
        "linger.ms": 5,
    }
    if CFG.KAFKA_SASL_MECHANISM:
        conf["sasl.mechanism"] = CFG.KAFKA_SASL_MECHANISM
    if CFG.KAFKA_SASL_USERNAME:
        conf["sasl.username"] = CFG.KAFKA_SASL_USERNAME
    if CFG.KAFKA_SASL_PASSWORD:
        conf["sasl.password"] = CFG.KAFKA_SASL_PASSWORD
    if CFG.KAFKA_SSL_CA_LOCATION:
        conf["ssl.ca.location"] = CFG.KAFKA_SSL_CA_LOCATION
    return conf


def kafka_consumer_conf(group_id: str) -> dict:
    conf = {
        "bootstrap.servers": CFG.KAFKA_BOOTSTRAP_SERVERS,
        "client.id": CFG.KAFKA_CLIENT_ID,
        "group.id": group_id,
        "security.protocol": CFG.KAFKA_SECURITY_PROTOCOL,
        "enable.auto.commit": False,
        "auto.offset.reset": "earliest",
    }
    if CFG.KAFKA_SASL_MECHANISM:
        conf["sasl.mechanism"] = CFG.KAFKA_SASL_MECHANISM
    if CFG.KAFKA_SASL_USERNAME:
        conf["sasl.username"] = CFG.KAFKA_SASL_USERNAME
    if CFG.KAFKA_SASL_PASSWORD:
        conf["sasl.password"] = CFG.KAFKA_SASL_PASSWORD
    if CFG.KAFKA_SSL_CA_LOCATION:
        conf["ssl.ca.location"] = CFG.KAFKA_SSL_CA_LOCATION
    return conf
