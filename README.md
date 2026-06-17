# World of Buoys

Self-hosted visualization of the NOAA NDBC buoy network. Dark telemetry UI with live map, fleet operations dashboard, and nearby-buoy finder. Kafka-native pipeline, CouchDB storage.

## Architecture

```
NDBC (realtime2 + station_table)
        │  scrape + parse (every 30 min)
        ▼
   ingest service ──publish──► KAFKA ──consume──► sink service
   (buoys.ingest)            (existing)          (buoys.sink)
                                                       │ upsert
                                                       ▼
                                                   COUCHDB (existing)
                                                       │ read
                                                       ▼
                                              FastAPI backend ──/api──► React SPA
                                              (buoys.main:app)          (nginx :80)
```

Four Docker services — **you supply Kafka and CouchDB**, this stack connects to them:

| Service | Role |
|---|---|
| `ingest` | Scrapes NDBC every 30 min, publishes to Kafka |
| `sink` | Consumes Kafka, writes to CouchDB |
| `backend` | FastAPI; reads CouchDB, serves `/api/*` |
| `frontend` | React/Vite SPA + nginx (proxies `/api`) |
| `cloudflared` | Optional Cloudflare Tunnel (profile: `tunnel`) |

## Quick Start

**Prerequisites:** Docker + Compose plugin, an existing Kafka broker, an existing CouchDB instance.

```bash
git clone <this-repo> world-of-buoys
cd world-of-buoys
cp .env.example .env
```

Edit `.env` — at minimum set:
```
KAFKA_BOOTSTRAP_SERVERS=192.168.1.20:9092
COUCHDB_URL=http://192.168.1.21:5984
COUCHDB_USER=admin
COUCHDB_PASSWORD=your-password
```

Then:
```bash
docker compose up -d --build
```

Open `http://localhost:8080`. Within a few minutes of the first ingest cycle (~1,300 stations fetched) buoys appear on the map.

## Proxmox LXC Deploy Notes

1. Create an Ubuntu 22.04 LXC (or use an existing one).
2. If using an **unprivileged** container: in the container options, enable **Nesting** (required for Docker).
3. SSH into the LXC and install Docker:

```bash
apt update && apt install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt update && apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
```

4. Clone the repo, configure `.env`, run `docker compose up -d --build`.

## Cloudflare Tunnel (Optional)

To expose the UI publicly without port-forwarding:

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → **Zero Trust → Networks → Tunnels → Create tunnel**
2. Choose "Cloudflared", name it (e.g. `world-of-buoys`)
3. Copy the **tunnel token**
4. In `.env`, set: `CLOUDFLARE_TUNNEL_TOKEN=<your-token>`
5. Configure the tunnel's public hostname to point to `http://frontend:80` (within the Docker network)
6. Start with the tunnel profile:

```bash
docker compose --profile tunnel up -d
```

The `cloudflared` service only starts when `--profile tunnel` is specified — local dev works without the token.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `KAFKA_BOOTSTRAP_SERVERS` | _(required)_ | Kafka broker(s), e.g. `192.168.1.20:9092` |
| `KAFKA_OBSERVATIONS_TOPIC` | `buoy.observations` | Observation messages topic |
| `KAFKA_STATIONS_TOPIC` | `buoy.stations` | Station metadata topic |
| `KAFKA_CONSUMER_GROUP` | `world-of-buoys-sink` | Sink consumer group |
| `KAFKA_SECURITY_PROTOCOL` | `PLAINTEXT` | `PLAINTEXT`, `SASL_PLAINTEXT`, `SASL_SSL`, `SSL` |
| `KAFKA_SASL_MECHANISM` | _(empty)_ | `PLAIN`, `SCRAM-SHA-256`, etc. |
| `COUCHDB_URL` | _(required)_ | e.g. `http://192.168.1.21:5984` |
| `COUCHDB_DATABASE` | `world_of_buoys` | CouchDB database name |
| `COUCHDB_USER` | _(required)_ | CouchDB admin user |
| `COUCHDB_PASSWORD` | _(required)_ | CouchDB password |
| `INGEST_INTERVAL_SECONDS` | `1800` | How often to scrape NDBC (30 min) |
| `STATION_TABLE_REFRESH_SECONDS` | `86400` | How often to refresh station metadata (1 day) |
| `INGEST_STATION_FILTER` | _(empty)_ | Comma-sep station IDs to limit ingest (testing) |
| `INGEST_MAX_CONCURRENCY` | `16` | Parallel realtime2 fetches |
| `SNAPSHOT_TTL_SECONDS` | `60` | In-process cache TTL for the buoy snapshot |
| `FRESH_WINDOW_HOURS` | `24` | Hours before a station is considered "not reporting" |
| `WEB_PORT` | `8080` | Host port for the frontend |
| `CLOUDFLARE_TUNNEL_TOKEN` | _(empty)_ | Tunnel token (only needed with `--profile tunnel`) |

## API Reference

All temperatures in °C, wind in m/s, wave heights in m, pressure in hPa. The frontend converts to imperial.

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Liveness + CouchDB reachable + station count |
| GET | `/api/buoys` | All located stations with latest readings (`?located_only=true`) |
| GET | `/api/buoys/{id}` | Full station detail |
| GET | `/api/buoys/{id}/series` | Time series (`?stream=standard&field=waterTemperature&limit=200`) |
| GET | `/api/buoys/{id}/nearby` | Nearest stations (`?radius_km=200&limit=10`) |
| GET | `/api/nearby` | Nearest to coordinates (`?lat=31.4&lon=-80.9&radius_km=200`) |
| GET | `/api/stats` | Fleet stats: totals, byOwner, byType, coverage, SST histogram |

Example:
```bash
curl http://localhost:8080/api/buoys/41008 | jq .
```

## Local Development

**Backend:**
```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# Set env vars (or: export $(grep -v '^#' ../.env | xargs))
uvicorn buoys.main:app --reload   # API at http://localhost:8000
python -m buoys.ingest            # run ingest once
python -m buoys.sink              # run sink
pytest tests/                     # offline tests
```

**Frontend:**
```bash
cd frontend
npm install
npm run dev    # http://localhost:5173 — /api proxied to localhost:8000
```

## Kafka Topics

- **buoy.observations** — one message per station per stream per ingest cycle. Key = stationId.
  ```json
  {"stationId":"41008","stream":"standard","ts":1718452800,"observedAt":"2024-06-15T12:00:00Z","values":{"waterTemperature":23.4,...}}
  ```
- **buoy.stations** — station metadata, refreshed daily. Key = stationId.

To switch to Avro/schema registry: wrap serialization in `backend/buoys/kafka_io.py` only — nothing else changes.

## Troubleshooting

**Map is empty after startup**
- Check `docker compose logs ingest` — first cycle fetches ~1,300 stations and can take 5–10 min
- Verify Kafka connectivity: `KAFKA_BOOTSTRAP_SERVERS` must be reachable from inside containers (use LAN IP, not `localhost`)
- Run with a filter to speed up testing: `INGEST_STATION_FILTER=41008,44013`

**Backend container unhealthy**
- Check `docker compose logs backend`
- Verify CouchDB connectivity: `curl http://$COUCHDB_USER:$COUCHDB_PASSWORD@$COUCHDB_URL/`

**Cloudflared not connecting**
- Verify `CLOUDFLARE_TUNNEL_TOKEN` is set in `.env`
- In the Cloudflare dashboard, the tunnel's public hostname service should point to `http://frontend:80`
- Check logs: `docker compose --profile tunnel logs cloudflared`
