"""The two story-builder rules most able to mislead: the spike filter (could
erase a real storm minimum) and the seasonal trend fit (sets the size of every
cold wake). Pinned against the shapes that matter, including 46070's own fall."""
from tools.build_story import DAY, HOUR, despike, fit_trend, tok


def test_despike_keeps_a_genuine_steep_fall():
    """46070 fell ~16 hPa in 3 hours at the bottom of the storm. A filter tuned
    to catch sensor spikes must not shave off the very minimum the story is about."""
    real = [1025.4, 1021.3, 1018.0, 1012.9, 1005.9, 999.4, 995.5, 991.9,
            986.6, 976.1, 960.1, 967.1, 976.8, 980.8, 982.2]
    series = {k * 3 * HOUR: v for k, v in enumerate(real)}
    clean, dropped = despike(series, 15.0)
    assert dropped == 0
    assert min(clean.values()) == 960.1


def test_despike_drops_an_isolated_fault():
    series = {k * HOUR: 1012.0 for k in range(20)}
    series[10 * HOUR] = 964.0  # WHOTS-style bad sample in a calm series
    clean, dropped = despike(series, 15.0)
    assert dropped == 1 and 10 * HOUR not in clean


def test_trend_fit_recovers_a_known_seasonal_slope():
    """-0.15 C/day of steady autumn cooling, with diurnal wobble on top."""
    import math
    series = {h * HOUR: 9.0 - 0.15 * (h / 24) + 0.2 * math.sin(2 * math.pi * h / 24)
              for h in range(14 * 24)}
    fn, slope = fit_trend(series)
    assert abs(slope - (-0.15)) < 0.01
    assert abs(fn(7 * DAY) - (9.0 - 0.15 * 7)) < 0.15


def test_trend_fit_needs_enough_days():
    assert fit_trend({h * HOUR: 9.0 for h in range(48)}) is None


def test_unit_tokens():
    assert tok("hPa", 959.4) == "{hPa:959.4}"
    assert tok("dC", 1.73) == "{dC:1.73}"
