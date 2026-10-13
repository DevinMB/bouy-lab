import time
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


def _hourly_obs(station_id, stream, start_ts, hours, values_fn):
    """Seed docs: one observation per hour ending at start_ts (newest first)."""
    docs = []
    for h in range(hours):
        ts = start_ts - h * 3600
        docs.append({
            "_id": f"obs:{station_id}:{stream}:{ts}",
            "type": "observation",
            "stationId": station_id, "stream": stream, "ts": ts,
            "values": values_fn(h),
        })
    return docs


@pytest.mark.asyncio
async def test_highlights(client):
    import time
    now = int(time.time())
    # 41008: 72h of hourly data — water warming 0.1 °C/h, pressure falling 0.5 hPa/h,
    # seas building, brisk wind, warm air over cooler water.
    docs = _hourly_obs("41008", "standard", now, 72, lambda h: {
        "waterTemperature": 25.0 - 0.1 * h,
        "airTemperature": 30.0,
        "pressure": 1000.0 + 0.5 * h,
        "waveHeight": 3.0 - 0.02 * h,
        "windSpeed": 12.0, "gustSpeed": 15.0,
    })
    # 44013: only 3 points — too sparse for a trend, but "now" values still rank.
    docs += _hourly_obs("44013", "standard", now, 3, lambda h: {
        "waterTemperature": 15.0, "windSpeed": 20.0, "pressure": 1010.0,
        # 999 °C is a sensor fault and must be dropped by the sanity range.
        "airTemperature": 999.0,
    })
    main_module._couch.seed(docs)

    resp = await client.get("/api/research/highlights?hours=72")
    assert resp.status_code == 200
    data = resp.json()
    assert data["hours"] == 72
    assert data["stationsScanned"] == 2
    assert data["stationsWithTrend"] == 1
    s = data["sections"]

    assert [r["id"] for r in s["warming"]] == ["41008"]
    assert s["warming"][0]["value"] == pytest.approx(7.2, abs=0.05)   # 0.1 °C/h × 72h
    assert s["warming"][0]["latest"] == pytest.approx(25.0)
    assert len(s["warming"][0]["series"]) == 72
    assert s["cooling"] == []

    assert [r["id"] for r in s["pressureFalling"]] == ["41008"]
    assert s["pressureFalling"][0]["value"] == pytest.approx(-36.0, abs=0.1)
    assert s["pressureRising"] == []

    assert [r["id"] for r in s["seasBuilding"]] == ["41008"]
    assert [r["id"] for r in s["biggestSeas"]] == ["41008"]

    # Windiest ranks by current wind; the sparse station still counts for "now".
    assert [r["id"] for r in s["windiest"]] == ["44013", "41008"]
    assert s["windiest"][1]["gust"] == pytest.approx(15.0)

    # Air–sea gap needs both fields; 44013's bogus air temp was dropped.
    assert [r["id"] for r in s["airSeaGap"]] == ["41008"]
    assert s["airSeaGap"][0]["value"] == pytest.approx(5.0)

    # Volatility needs ≥6 buckets.
    assert [r["id"] for r in s["volatileWater"]] == ["41008"]

    # Seeded latest docs are from 2024 — far older than the window, so not "went quiet".
    assert s["wentQuiet"] == []

    pulse = {p["field"]: p for p in data["pulse"]}
    assert pulse["waterTemperature"]["delta"] > 0
    assert pulse["pressure"]["delta"] < 0

    # Second call is served from cache.
    resp2 = await client.get("/api/research/highlights?hours=72")
    assert resp2.json()["generatedAt"] == data["generatedAt"]


@pytest.mark.asyncio
async def test_highlights_empty_network(client):
    resp = await client.get("/api/research/highlights?hours=24")
    assert resp.status_code == 200
    data = resp.json()
    assert data["stationsWithTrend"] == 0
    assert all(rows == [] for rows in data["sections"].values())


@pytest.mark.asyncio
async def test_highlights_hours_bounds(client):
    assert (await client.get("/api/research/highlights?hours=6")).status_code == 422
    assert (await client.get("/api/research/highlights?hours=720")).status_code == 422


# ── /api/research/anomalies filtering ────────────────────────────────────────

def _fresh_latest(sid, streams):
    """A latest: doc whose overall ts is the newest across its streams."""
    return {
        "_id": f"latest:{sid}", "type": "latest", "stationId": sid, "name": sid,
        "lat": 30.0, "lon": -80.0, "owner": "NDBC", "ttype": "BUOY", "available": [],
        "ts": max(v["ts"] for v in streams.values()), "streams": streams,
    }


@pytest.mark.asyncio
async def test_anomalies_drops_sensor_faults(client):
    """A 999 °C reading must not reach the statistic.

    It would inflate std, and because z = (val - mean) / std that compresses
    every z-score toward zero -- the fault ranks top while real anomalies are
    buried. Same SANE_RANGES filter the Trends digest already applies.
    """
    now = int(time.time())
    docs = [_fresh_latest(sid, {"standard": {"ts": now, "values": {"waterTemperature": v}}})
            for sid, v in [("A1", 20.0), ("A2", 21.0), ("A3", 19.0), ("A4", 20.5)]]
    docs.append(_fresh_latest("BAD", {"standard": {"ts": now, "values": {"waterTemperature": 999.0}}}))
    main_module._couch.seed(docs)

    data = (await client.get("/api/research/anomalies?stream=standard&field=waterTemperature")).json()
    assert data["excludedOutOfRange"] == 1
    assert "BAD" not in [a["id"] for a in data["anomalies"]]
    assert data["n"] == 4
    # 20.125 mean over four plausible readings, not dragged up by the fault.
    assert 19.0 <= data["mean"] <= 21.0
    assert data["std"] < 1.5


@pytest.mark.asyncio
async def test_anomalies_drops_stale_readings(client):
    """A months-old reading does not belong in a *current* network mean."""
    now = int(time.time())
    docs = [_fresh_latest(sid, {"standard": {"ts": now, "values": {"waterTemperature": v}}})
            for sid, v in [("B1", 20.0), ("B2", 21.0), ("B3", 19.0)]]
    docs.append(_fresh_latest("OLD", {"standard": {"ts": now - 90 * 86400,
                                                   "values": {"waterTemperature": 2.0}}}))
    main_module._couch.seed(docs)

    data = (await client.get("/api/research/anomalies?stream=standard&field=waterTemperature")).json()
    assert "OLD" not in [a["id"] for a in data["anomalies"]]
    assert data["excludedStale"] >= 1
    assert data["n"] == 3


@pytest.mark.asyncio
async def test_anomalies_staleness_uses_the_streams_own_ts():
    """The subtle one: freshness is per stream, not per document.

    doc.ts is the newest ts across all streams, so a station with a live
    standard feed and a long-dead ocean sensor has a fresh doc.ts. Judging on
    doc.ts would admit the dead ocean reading; judging on the stream's own ts
    does not.
    """
    fake = FakeCouchClient()
    main_module._couch = fake
    main_module._cache = TTLCache(ttl_seconds=60)
    now = int(time.time())
    fake.seed([
        _fresh_latest("MIX", {
            "standard": {"ts": now, "values": {"waterTemperature": 20.0}},
            "ocean": {"ts": now - 30 * 86400, "values": {"waterTemperature": 5.0}},
        }),
        _fresh_latest("C1", {"standard": {"ts": now, "values": {"waterTemperature": 21.0}},
                             "ocean": {"ts": now, "values": {"waterTemperature": 18.0}}}),
        _fresh_latest("C2", {"standard": {"ts": now, "values": {"waterTemperature": 19.0}},
                             "ocean": {"ts": now, "values": {"waterTemperature": 17.0}}}),
        _fresh_latest("C3", {"standard": {"ts": now, "values": {"waterTemperature": 20.5}},
                             "ocean": {"ts": now, "values": {"waterTemperature": 17.5}}}),
    ])
    async with AsyncClient(transport=ASGITransport(app=main_module.app),
                           base_url="http://test") as c:
        ocean = (await c.get("/api/research/anomalies?stream=ocean&field=waterTemperature")).json()
        assert "MIX" not in [a["id"] for a in ocean["anomalies"]], "dead ocean sensor admitted"
        assert ocean["excludedStale"] == 1
        assert ocean["n"] == 3
        std = (await c.get("/api/research/anomalies?stream=standard&field=waterTemperature")).json()
        assert "MIX" in [a["id"] for a in std["anomalies"]], "live standard feed wrongly dropped"
        assert std["n"] == 4


# ── long research windows: daily resolution ──────────────────────────────────

def test_days_combine_weighted_by_count_not_mean_of_means():
    """A day's mean must weight each hour by its reading count.

    One reading of 10 and three readings of 20 is a day mean of 17.5. Averaging
    the two hourly means would give 15 -- wrong whenever reporting cadence
    varies within a day, which on this network it routinely does.
    """
    from buoys.service import _hours_to_days
    day = 1791763200  # a UTC midnight
    out = _hours_to_days([
        {"ts": day + 3600, "mean": 10.0, "min": 10.0, "max": 10.0, "count": 1},
        {"ts": day + 7200, "mean": 20.0, "min": 19.0, "max": 21.0, "count": 3},
    ])
    assert len(out) == 1
    assert out[0]["ts"] == day
    assert out[0]["mean"] == 17.5
    assert (out[0]["min"], out[0]["max"], out[0]["count"]) == (10.0, 21.0, 4)


def _obs(sid, ts, temp):
    return {"_id": f"obs:{sid}:standard:{ts}", "type": "observation", "stationId": sid,
            "stream": "standard", "ts": ts, "values": {"waterTemperature": temp}}


@pytest.mark.asyncio
async def test_long_windows_report_daily_resolution(client):
    now = int(time.time())
    main_module._couch.seed([_obs("D1", now - k * 3600, 20.0 + k % 3) for k in range(0, 72, 2)])
    short = (await client.get("/api/research/trend?stream=standard&field=waterTemperature&hours=168")).json()
    long_ = (await client.get("/api/research/trend?stream=standard&field=waterTemperature&hours=2160")).json()
    assert short["resolution"] == "hour"
    assert long_["resolution"] == "day"
    # daily buckets land on UTC midnights
    assert long_["points"] and all(p["ts"] % 86400 == 0 for p in long_["points"])


@pytest.mark.asyncio
async def test_regional_long_window_reads_daily_mean(client):
    """>30 days reads daily: and plots meanInDay -- not the newest reading."""
    now = int(time.time())
    today = now - now % 86400
    # Same station, same day: readings 10, 20, 30. Newest is 30; the mean is 20.
    main_module._couch.seed([_obs("R1", today + 600 * k, v) for k, v in enumerate((10.0, 20.0, 30.0))])
    data = (await client.get(
        "/api/research/trend_stations?stream=standard&field=waterTemperature&hours=2160&stations=R1")).json()
    assert data["resolution"] == "day"
    pt = next(p for p in data["points"] if p["ts"] == today)
    assert pt["mean"] == 20.0, "long windows must plot the daily MEAN, not the newest reading"


@pytest.mark.asyncio
async def test_long_windows_only_on_trend_endpoints(client):
    """correlate/teleconnections/propagation read raw series under the 1000-point
    cap, so a year window there would be silently truncated. They stay at 720h."""
    ok = await client.get("/api/research/trend?stream=standard&field=waterTemperature&hours=8760")
    bad = await client.get("/api/research/correlate?stream=standard&field=waterTemperature"
                           "&stations=A,B,C&hours=8760")
    assert ok.status_code == 200
    assert bad.status_code == 422
