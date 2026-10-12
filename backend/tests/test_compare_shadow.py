"""The shadow-vs-production comparison rules (tools/compare_shadow.py).

Phase 1 of the Flink migration deliberately changes behaviour -- it fixes the
latest: starvation bug -- so the comparison has to separate "expected, because
we fixed something" from "regression". Those tolerances decide when a phase cuts
over, so they are pinned here rather than trusted to review.
"""
from tools.compare_shadow import (
    compare_exact,
    compare_latest,
    strip_meta,
    water_temp_from_streams,
)


def _latest(ts, streams, **over):
    doc = {
        "_id": f"latest:{over.get('stationId', 'bzst2')}",
        "_rev": "1-abc",
        "type": "latest",
        "stationId": "bzst2",
        "name": "8779749 - SPI Brazos Santiago, TX",
        "lat": 26.067,
        "lon": -97.155,
        "owner": "TCOON",
        "ttype": "Water Level Observation Network",
        "available": [],
        "streams": streams,
        "ts": ts,
        "observedAt": "2026-10-12T12:00:00Z",
    }
    doc["waterTempC"] = water_temp_from_streams(streams)
    doc.update(over)
    return doc


def _stream(ts, temp=28.2):
    return {"ts": ts, "values": {"waterTemperature": temp, "windSpeed": 5.1}}


# ── strip_meta / water_temp_from_streams ──────────────────────────────────────

def test_strip_meta_drops_underscore_keys():
    assert strip_meta({"_id": "x", "_rev": "1-a", "ts": 1}) == {"ts": 1}


def test_water_temp_precedence():
    assert water_temp_from_streams({"standard": _stream(1, 20.0), "ocean": _stream(1, 30.0)}) == 20.0
    assert water_temp_from_streams({"ocean": _stream(1, 30.0)}) == 30.0
    # standard present but null falls through to ocean, mirroring the sink
    assert water_temp_from_streams({"standard": _stream(1, None), "ocean": _stream(1, 30.0)}) == 30.0
    assert water_temp_from_streams({"standard": _stream(1, None)}) is None
    assert water_temp_from_streams({}) is None


# ── obs: / station: exact comparison ─────────────────────────────────────────

def test_compare_exact_ignores_rev():
    a = {"_id": "obs:x", "_rev": "1-a", "ts": 10, "values": {"t": 1.0}}
    b = {"_id": "obs:x", "_rev": "99-z", "ts": 10, "values": {"t": 1.0}}
    assert compare_exact(a, b) == []


def test_compare_exact_reports_changed_and_absent_fields():
    a = {"_id": "obs:x", "ts": 10, "stream": "standard"}
    b = {"_id": "obs:x", "ts": 11}
    diffs = compare_exact(a, b)
    assert any(d.startswith("ts:") for d in diffs)
    assert any(d.startswith("stream:") for d in diffs)


def test_compare_exact_treats_null_and_absent_as_different():
    """NDBC "MM" becomes an explicit null; a dropped key is not the same thing."""
    a = {"_id": "obs:x", "values": {"waveHeight": None}}
    b = {"_id": "obs:x", "values": {}}
    assert compare_exact(a, b) != []


# ── latest: tolerated differences ────────────────────────────────────────────

def test_identical_latest_is_clean():
    streams = {"standard": _stream(1791806400)}
    hard, notes, _ = compare_latest(_latest(1791806400, streams), _latest(1791806400, streams))
    assert hard == []
    assert notes == []


def test_extra_stream_in_shadow_is_expected():
    prod = _latest(1791806400, {"standard": _stream(1791806400)})
    shadow = _latest(1791806400, {"standard": _stream(1791806400),
                                  "ocean": _stream(1791792480, 27.9)})
    hard, notes, _ = compare_latest(shadow, prod)
    assert hard == []
    assert any("ocean" in n for n in notes)


def test_newer_stream_in_shadow_is_expected():
    prod = _latest(1791792480, {"standard": _stream(1791792480, 24.7)})
    shadow = _latest(1791806880, {"standard": _stream(1791806880, 24.9)})
    hard, notes, _ = compare_latest(shadow, prod)
    assert hard == []
    assert any("newer in shadow" in n for n in notes)


def test_the_real_starvation_case_is_not_a_regression():
    """latest:41033 as MARS measured it: production sat on a 4h-stale standard
    reading because ocean reported in the same minute and won the ts gate."""
    prod = _latest(1791792480, {"standard": _stream(1791792480, 24.7)})
    shadow = _latest(1791806880, {"standard": _stream(1791806880, 24.9),
                                  "ocean": _stream(1791806880, 24.8)})
    hard, notes, _ = compare_latest(shadow, prod)
    assert hard == [], hard
    assert shadow["waterTempC"] == 24.9 and prod["waterTempC"] == 24.7
    assert notes


def test_metadata_tolerances():
    streams = {"standard": _stream(1791806400)}
    ts = 1791806400
    # production stored "" for name and never overwrote it
    hard, _, _ = compare_latest(_latest(ts, streams, name="bzst2"),
                             _latest(ts, streams, name=""))
    assert hard == []
    # production kept a previous non-empty owner; Flink wrote the current empty one
    hard, _, _ = compare_latest(_latest(ts, streams, owner=""),
                             _latest(ts, streams, owner="TCOON"))
    assert hard == []
    # production never writes a null location over a non-null one
    hard, _, _ = compare_latest(_latest(ts, streams, lat=None),
                             _latest(ts, streams, lat=26.067))
    assert hard == []


# ── latest: real regressions ─────────────────────────────────────────────────

def test_shadow_older_than_prod_is_a_regression():
    prod = _latest(1791806400, {"standard": _stream(1791806400)})
    shadow = _latest(1791792480, {"standard": _stream(1791792480)})
    hard, _, _ = compare_latest(shadow, prod)
    assert any("OLDER" in d for d in hard)


def test_missing_stream_is_deferred_not_judged():
    """A stream only in prod cannot be judged without knowing whether the shadow
    ever received it -- a from-latest job legitimately never sees earlier
    messages. It is returned for the caller to resolve, not failed outright.

    This is the real latest:41029 shape: prod holds ocean at the newest ts and a
    starved, stale standard; the shadow has the current standard and no ocean,
    because ocean's Kafka message predates the job's start offset.
    """
    prod = _latest(1791828480, {"ocean": _stream(1791828480, 24.1),
                                "standard": _stream(1791824880, 23.8)})
    shadow = _latest(1791828480, {"standard": _stream(1791828480, 24.0)})
    hard, notes, to_check = compare_latest(shadow, prod)
    assert hard == [], hard
    assert to_check == ["ocean"]


def test_same_ts_different_values_is_a_regression():
    prod = _latest(1791806400, {"standard": _stream(1791806400, 28.2)})
    shadow = _latest(1791806400, {"standard": _stream(1791806400, 99.9)})
    hard, _, _ = compare_latest(shadow, prod)
    assert any("different values" in d for d in hard)


def test_internally_inconsistent_water_temp_is_a_regression():
    streams = {"standard": _stream(1791806400, 28.2)}
    shadow = _latest(1791806400, streams)
    shadow["waterTempC"] = 1.0  # not what the standard-else-ocean rule gives
    hard, _, _ = compare_latest(shadow, _latest(1791806400, streams))
    assert any("waterTempC" in d for d in hard)


def test_non_empty_available_is_a_regression():
    streams = {"standard": _stream(1791806400)}
    hard, _, _ = compare_latest(_latest(1791806400, streams, available=["standard"]),
                             _latest(1791806400, streams))
    assert any("available" in d for d in hard)


def test_genuine_name_mismatch_is_a_regression():
    streams = {"standard": _stream(1791806400)}
    hard, _, _ = compare_latest(_latest(1791806400, streams, name="Wrong Station"),
                             _latest(1791806400, streams, name="8779749 - SPI Brazos Santiago, TX"))
    assert any(d.startswith("name:") for d in hard)


def test_older_overall_ts_is_expected_when_a_stream_was_never_received():
    """The latest:cpxc1 shape. The shadow only ever received ocean for this
    station; prod's overall ts comes from standard, which the shadow never saw.
    Prod being newer is then arithmetic, not a defect -- but the same comparison
    on a shadow holding every prod stream still has to fail (test above)."""
    prod = _latest(1791828900, {"standard": _stream(1791828900, 24.0),
                                "ocean": _stream(1791801720, 23.5)})
    shadow = _latest(1791826980, {"ocean": _stream(1791826980, 23.9)})
    hard, notes, to_check = compare_latest(shadow, prod)
    assert hard == [], hard
    assert to_check == ["standard"]
    assert any("older than prod" in n for n in notes)
