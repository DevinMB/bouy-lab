import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport

import buoys.main as main_module
from buoys.cache import TTLCache
from tests.fake_couch import FakeCouchClient

FAKE_LATEST_41008 = {
    "_id": "latest:41008",
    "type": "latest",
    "stationId": "41008",
    "name": "GRAYS REEF",
    "lat": 31.402,
    "lon": -80.866,
    "owner": "NDBC",
    "ttype": "BUOY",
    "available": ["standard"],
    "waterTempC": 23.4,
    "observedAt": "2024-06-15T12:00:00Z",
    "ts": 1718452800,
    "streams": {
        "standard": {
            "ts": 1718452800,
            "values": {"waterTemperature": 23.4, "windSpeed": 5.1, "pressure": 1015.0},
        }
    },
}

FAKE_LATEST_44013 = {
    "_id": "latest:44013",
    "type": "latest",
    "stationId": "44013",
    "name": "BOSTON 16 NM East of Boston",
    "lat": 42.346,
    "lon": -70.651,
    "owner": "NDBC",
    "ttype": "BUOY",
    "available": ["standard", "spec"],
    "waterTempC": 15.2,
    "observedAt": "2024-06-15T11:00:00Z",
    "ts": 1718449200,
    "streams": {},
}

FAKE_LATEST_NO_LOC = {
    "_id": "latest:UNLOC",
    "type": "latest",
    "stationId": "UNLOC",
    "name": "No Location Station",
    "lat": None,
    "lon": None,
    "owner": "TEST",
    "available": [],
    "waterTempC": None,
    "observedAt": None,
    "ts": 0,
    "streams": {},
}


@pytest_asyncio.fixture
async def client():
    fake_couch = FakeCouchClient()
    fake_couch.seed([FAKE_LATEST_41008, FAKE_LATEST_44013, FAKE_LATEST_NO_LOC])
    main_module._couch = fake_couch
    main_module._cache = TTLCache(ttl_seconds=60)

    async with AsyncClient(
        transport=ASGITransport(app=main_module.app),
        base_url="http://test",
    ) as ac:
        yield ac

    main_module._couch = None
    main_module._cache = None


@pytest.mark.asyncio
async def test_health(client):
    resp = await client.get("/api/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert "stationCount" in data


@pytest.mark.asyncio
async def test_get_buoys(client):
    resp = await client.get("/api/buoys")
    assert resp.status_code == 200
    data = resp.json()
    # located_only=True by default, so UNLOC is excluded
    assert len(data) == 2
    ids = {item["id"] for item in data}
    assert "41008" in ids
    assert "44013" in ids
    for item in data:
        assert "lat" in item
        assert "lon" in item
        assert item["lat"] is not None


@pytest.mark.asyncio
async def test_get_buoys_located_only_false(client):
    resp = await client.get("/api/buoys?located_only=false")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 3


@pytest.mark.asyncio
async def test_get_buoy_detail(client):
    resp = await client.get("/api/buoys/41008")
    assert resp.status_code == 200
    data = resp.json()
    assert data["id"] == "41008"
    assert data["lat"] == pytest.approx(31.402)


@pytest.mark.asyncio
async def test_get_buoy_not_found(client):
    resp = await client.get("/api/buoys/ZZZZ")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_nearby(client):
    resp = await client.get("/api/nearby?lat=31.4&lon=-80.9&radius_km=5000&limit=5")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) > 0
    for item in data:
        assert "distanceKm" in item
    # Closest to 31.4,-80.9 should be 41008
    assert data[0]["id"] == "41008"


@pytest.mark.asyncio
async def test_stats(client):
    resp = await client.get("/api/stats")
    assert resp.status_code == 200
    data = resp.json()
    assert "total" in data
    assert "reporting" in data
    assert "byOwner" in data
    assert data["total"] == 3


@pytest.mark.asyncio
async def test_series(client):
    # No obs seeded, so data should be empty list
    resp = await client.get("/api/buoys/41008/series?stream=standard&field=waterTemperature")
    assert resp.status_code == 200
    data = resp.json()
    assert data["stationId"] == "41008"
    assert data["stream"] == "standard"
    assert isinstance(data["data"], list)
