import asyncio
import logging
import httpx
from buoys.parsing import parse_station_table, parse_ndbc_file

log = logging.getLogger(__name__)

STATION_TABLE_URL = "https://www.ndbc.noaa.gov/data/stations/station_table.txt"
STATION_OWNERS_URL = "https://www.ndbc.noaa.gov/data/stations/station_owners.txt"
REALTIME2_BASE = "https://www.ndbc.noaa.gov/data/realtime2"
STREAMS = ["standard", "ocean", "spec", "srad", "dart"]
EXTENSIONS = {
    "standard": ".txt",
    "ocean": ".ocean",
    "spec": ".spec",
    "srad": ".srad",
    "dart": ".dart",
}
USER_AGENT = "WorldOfBuoys/1.0 (buoy-data-visualization; https://github.com/world-of-buoys)"


def _make_client(timeout: float = 30.0) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        headers={"User-Agent": USER_AGENT},
        timeout=timeout,
        follow_redirects=True,
    )


async def fetch_station_table(client: httpx.AsyncClient) -> str:
    resp = await client.get(STATION_TABLE_URL)
    resp.raise_for_status()
    return resp.text


async def fetch_station_table_parsed(client: httpx.AsyncClient) -> list:
    text = await fetch_station_table(client)
    return parse_station_table(text)


async def fetch_owner_map(client: httpx.AsyncClient) -> dict:
    """Fetch NDBC's owner-code table → {code: human-readable name}.

    Format is pipe-delimited: OWNER_CODE | OWNER_NAME | COUNTRY, with '#' headers.
    Returns {} on any failure — callers fall back to the raw code.
    """
    try:
        resp = await client.get(STATION_OWNERS_URL)
        resp.raise_for_status()
    except Exception as e:
        log.warning("Failed to fetch station owners table: %s", e)
        return {}

    owners = {}
    for line in resp.text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = [p.strip() for p in stripped.split("|")]
        if len(parts) >= 2 and parts[0]:
            owners[parts[0]] = parts[1]
    return owners


async def probe_station_streams(client: httpx.AsyncClient, station_id: str) -> list:
    """Return list of stream names where HTTP 200 is returned."""
    available = []
    tasks = []

    async def _probe(stream: str):
        ext = EXTENSIONS[stream]
        url = f"{REALTIME2_BASE}/{station_id.upper()}{ext}"
        try:
            resp = await client.head(url)
            if resp.status_code == 200:
                available.append(stream)
        except Exception:
            pass

    await asyncio.gather(*[_probe(s) for s in STREAMS])
    return available


async def fetch_realtime2(client: httpx.AsyncClient, station_id: str, stream: str):
    ext = EXTENSIONS[stream]
    url = f"{REALTIME2_BASE}/{station_id.upper()}{ext}"
    try:
        resp = await client.get(url)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.text
    except Exception as e:
        log.warning("Failed to fetch %s for station %s: %s", stream, station_id, e)
        return None


async def fetch_all_stations(station_ids: list, max_concurrency: int = 16) -> dict:
    """
    For each station_id, probe available streams then fetch each available file.
    Returns {station_id: {"available": [...], "streams": {stream: text}}}
    """
    sem = asyncio.Semaphore(max_concurrency)
    results = {}

    async def _process_station(client: httpx.AsyncClient, station_id: str):
        async with sem:
            available = await probe_station_streams(client, station_id)
            streams = {}
            for stream in available:
                text = await fetch_realtime2(client, station_id, stream)
                if text:
                    streams[stream] = text
            results[station_id] = {"available": available, "streams": streams}

    async with _make_client() as client:
        await asyncio.gather(*[_process_station(client, sid) for sid in station_ids])

    return results
