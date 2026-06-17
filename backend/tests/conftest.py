import os

# Set required env vars before buoys modules are imported
os.environ.setdefault("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092")
os.environ.setdefault("COUCHDB_URL", "http://localhost:5984")
os.environ.setdefault("COUCHDB_USER", "test")
os.environ.setdefault("COUCHDB_PASSWORD", "test")
