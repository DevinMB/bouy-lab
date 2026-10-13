"""hourly: retention -- the parts that decide what gets destroyed.

A purge cannot be undone, so the selection rules are pinned here rather than
trusted to review: the cutoff arithmetic, the refusal to run with a retention
short enough to delete data the site still reads, and the id parsing the
series walk depends on.
"""
import pytest

from buoys.retention import (
    DAY, HOUR, MIN_RETENTION_DAYS, cutoff_for, hour_of, series_prefix,
)


def test_cutoff_is_an_hour_boundary_90_days_back():
    now = 1791889666  # 2026-10-13 11:07:46Z
    c = cutoff_for(now, 90)
    assert c % HOUR == 0
    assert now - 90 * DAY - HOUR < c <= now - 90 * DAY


@pytest.mark.parametrize("days", [0, 1, 7, 30])
def test_refuses_retention_shorter_than_the_api_reads(days):
    """The API serves hourly: for windows up to 30 days. A typo of 9 instead of
    90 must fail loudly, not quietly purge 80 days of data the site uses."""
    with pytest.raises(ValueError):
        cutoff_for(1791889666, days)


def test_minimum_retention_is_accepted():
    cutoff_for(1791889666, MIN_RETENTION_DAYS)


def test_series_prefix_and_hour():
    i = "hourly:41013:standard:windSpeed:1791288000"
    assert series_prefix(i) == "hourly:41013:standard:windSpeed:"
    assert hour_of(i) == 1791288000


def test_prefix_splits_from_the_right():
    """Parse the hour off the END, so the walk stays correct even for a station
    id containing ':' (none do today, but the walk must not depend on that)."""
    i = "hourly:odd:id:standard:windSpeed:1791288000"
    assert hour_of(i) == 1791288000
    assert series_prefix(i) == "hourly:odd:id:standard:windSpeed:"


def test_fixed_width_hours_make_the_expiry_range_exact():
    """The walk selects [prefix, prefix+cutoff) by _id. That is only equal to
    'hour < cutoff' because hours are fixed-width 10-digit epochs, so string
    order is numeric order -- the same invariant test_couch_ids.py pins for obs."""
    p, cutoff = "hourly:41013:standard:windSpeed:", 1784000000
    for h in (1777230000, 1783999800, 1784000000, 1791288000):
        in_range = p <= f"{p}{h}" < f"{p}{cutoff}"
        assert in_range == (h < cutoff), h
