"""The _id ordering invariants that the primary-index range scans depend on.

get_all_latest / get_series stopped using the map-reduce views and now walk
_id ranges instead (couch.py: _all_docs_range). That is only equivalent to the
old view if document ids sort the way the views emitted their keys, so the
assumptions are pinned here rather than left implicit.
"""
import random

from buoys.couch import _obs_prefix

HIGH = "￰"


def test_obs_prefix_shape():
    assert _obs_prefix("bzst2", "standard") == "obs:bzst2:standard:"


def test_obs_id_order_matches_ts():
    """Lexicographic id order == numeric ts order for 10-digit epoch seconds.

    True for 1000000000 (2001-09-09) through 9999999999 (2286-11-20): every ts
    is the same width, so a string compare is a digit-by-digit numeric compare.
    This is what lets a descending _all_docs range return newest-first.
    """
    prefix = _obs_prefix("bzst2", "standard")
    ts_values = [1000000000, 1781654760, 1791764640, 1791806400, 9999999999]
    ts_values += [random.randint(1_000_000_000, 9_999_999_999) for _ in range(200)]
    ids = [f"{prefix}{ts}" for ts in ts_values]

    by_string = sorted(ids)
    by_ts = [f"{prefix}{ts}" for ts in sorted(ts_values)]
    assert by_string == by_ts

    # ...and therefore descending too, which is the direction we actually query.
    assert sorted(ids, reverse=True) == [f"{prefix}{ts}" for ts in sorted(ts_values, reverse=True)]


def test_high_sentinel_sorts_above_every_real_id():
    """The endkey sentinel must close the range, not clip the newest rows."""
    prefix = _obs_prefix("bzst2", "standard")
    assert f"{prefix}9999999999" < prefix + HIGH
    assert f"latest:zzzzzz" < "latest:" + HIGH


def test_prefix_does_not_leak_across_streams_or_stations():
    """The trailing ':' is what keeps neighbouring prefixes out of the range."""
    lo, hi = _obs_prefix("bzst2", "standard"), _obs_prefix("bzst2", "standard") + HIGH

    inside = f"{_obs_prefix('bzst2', 'standard')}1791806400"
    assert lo <= inside <= hi

    # Another stream on the same station, and a station id that merely starts
    # with this one, must both fall outside the range.
    for outside in (
        f"{_obs_prefix('bzst2', 'spec')}1791806400",
        f"{_obs_prefix('bzst2', 'ocean')}1791806400",
        f"{_obs_prefix('bzst21', 'standard')}1791806400",
        "station:bzst2",
        "latest:bzst2",
    ):
        assert not (lo <= outside <= hi), outside
