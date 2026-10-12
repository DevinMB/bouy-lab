# Moving the processing onto Flink (MARS)

**Status:** plan, not started. The live stack runs on 192.168.10.60.

World of Buoys already has the right shape for stream processing: a scraper
publishes to Kafka, a sink writes to CouchDB, and the API reads CouchDB. What does
not fit is that the API does the heavy analysis itself, on every request. This
plan moves the data processing into Flink jobs run by MARS (the Flink SQL console
on 192.168.1.250), and leaves the API reading finished results.

## What moves, and what stays

| Piece | Today | Plan | Why |
|---|---|---|---|
| Ingest (`ingest.py`, `ndbc.py`, `parsing.py`) | Python scraper, every 30 min, ~1,300 stations | **Stays in Python** | Parsing NDBC's fixed-width files in SQL would be painful, and it already only publishes to Kafka. It appears on MARS's pipeline map as an outside producer. |
| Sink (`sink.py`) | Kafka to CouchDB: `obs:` docs, `latest:` per station, `station:` docs | **Streaming Flink job** (phase 1) | Topic-to-CouchDB with deterministic ids is what MARS's other jobs already do. |
| Network-wide hourly trend (`get_trend`) | CouchDB `trend` view with `_stats` reduce | **Stays** | CouchDB already maintains it incrementally; it is cheap. |
| Regional trend (`_trend_from_stations`) | Fetches up to 80 stations' raw series per request | **Streaming Flink job** (phase 2) | Hourly bucket per station, written as it closes; the API sums finished buckets. |
| Anomalies (`get_anomalies`) | z-score of all latest values per request | **Streaming Flink job** (phase 2) | A running network mean and spread per metric. |
| Correlation, teleconnections, propagation (`_pearson`, `_leadlag`) | Pairwise and lag-scan maths per request | **Scheduled Flink batch job** (phase 3) | Every station against every other at 48 lags is too big; limited to nearby stations (as propagation already does), each station's top correlates and leaders can be precomputed hourly or nightly. |
| Forecast (`_build_forecast`) | Python, from leaders | **Stays**, reading phase 3's results | Small once the leaders are known. |
| API and UI | FastAPI, React | **Stays**, slimmer | Mostly reads of precomputed documents. |

## Facts the jobs must match

- Topics: `buoy.observations` (key: station), `buoy.stations`. The Python sink's
  consumer group is `world-of-buoys-sink`; Flink jobs get their own (MARS gives
  each job `mars-<job>` unless the table names one).
- CouchDB database `world_of_buoys` (on 192.168.1.250, about 7 GB). Document ids:
  `obs:<station>:<stream>:<ts>`, `latest:<station>`, `station:<station>`.
- `latest:<station>` merges every stream for the station into one document:
  `streams.<stream> = {ts, values}`, the newest `ts`, station name, location,
  owner, type and available streams, and `waterTempC` (standard stream first,
  then ocean). The API's `latest` view and the map depend on that exact shape.
- Views in `_design/buoys`: `series` `[station, stream, ts]`, `latest`, and
  `trend` `[stream, field, hourBucket]` with `_stats`. The jobs write documents
  these views already index, so the views stay as they are.

## The CouchDB connector supports this

MARS's CouchDB sink accepts inserts and updates (`INSERT`, `UPDATE_AFTER`), not
deletes, and writes each row under a deterministic `_id`. So an aggregation or
"keep the newest" job can write its changing results: give the sink table a
primary key matching the document id, and each update overwrites that document.
No connector change is needed.

## Phases

Each phase runs beside the current code first, writing to a **shadow database**
(`world_of_buoys_shadow`), and is compared against production before anything
switches. The live API keeps reading `world_of_buoys` until a phase is proven.

### Phase 1: the sink

1. In MARS, catalog tables for `buoy.observations` and `buoy.stations` (raw JSON
   passthrough), and CouchDB tables for the shadow database.
2. Job `buoys_observations`: each observation to `obs:<station>:<stream>:<ts>`,
   with the same fields as today (`type: "observation"`, `values`, ...).
3. Job `buoys_stations`: each station to `station:<station>`.
4. Job `buoys_latest`: newest reading per (station, stream) (Flink's top-1
   deduplication), combined per station (`JSON_OBJECTAGG` of streams), joined
   with the station details, `waterTempC` by the same precedence; upserted to
   `latest:<station>`.
5. Run for a few ingest cycles; a comparison script diffs shadow against
   production for the same ids (ignoring `_rev`). Differences are fixed in SQL.
6. Cut over: point the three jobs at `world_of_buoys`, stop the Python `sink`
   service. Ids are deterministic, so the switch overwrites documents with
   identical content; nothing is duplicated. Roll back by starting `sink` again.

### Phase 2: hourly buckets and anomalies

1. Job `buoys_hourly`: one-hour tumbling windows per (station, stream, field)
   (mean, min, max, count), to `hourly:<station>:<stream>:<field>:<hour>`.
2. Job `buoys_anomaly_stats`: running network mean and standard deviation per
   (stream, field) over latest values, to `netstats:<stream>:<field>`.
3. API: `_trend_from_stations` reads hourly documents for the region's stations
   instead of raw series; `get_anomalies` reads `netstats` instead of computing.
   Compare responses old against new for a set of regions before switching.

### Phase 3: scheduled correlation

1. Batch job, run by MARS on a schedule (hourly or nightly): for each station,
   Pearson correlation and best lag (0 to 48 hours) against stations within the
   propagation distance, over phase 2's hourly buckets. Top N per station to
   `corr:<station>:<stream>:<field>`.
2. API: teleconnections and propagation read the precomputed leaders; the
   forecast step stays in Python on top.
3. This is the heaviest job; size it from MARS's cluster resources view first.

### Phase 4: tidy up

Remove the Python sink service, the request-time computation that phases 2 and
3 replaced, and the `TTLCache` entries that only existed to hide that cost.

## Risks and how they are handled

- **Live site.** Everything runs to the shadow database first; cut-overs are
  config changes with a one-step rollback.
- **Document shape drift.** The comparison script, not inspection, decides when
  a phase is ready.
- **History.** Flink reads Kafka from its retention window only. The existing
  CouchDB history stays where it is; jobs write the same ids, so old and new
  documents coexist without a migration.
- **Bursty input.** Ingest publishes about every 30 minutes; a quiet topic
  between cycles is normal (MARS judges job health by checkpoints, not input).
