import pytest
from buoys.parsing import (
    coerce_float,
    parse_location,
    parse_timestamp,
    parse_standard_row,
    parse_ocean_row,
    parse_ndbc_file,
    parse_station_table,
)

# ── coerce_float ──────────────────────────────────────────────────────────────

def test_coerce_float_mm():
    assert coerce_float("MM") is None


def test_coerce_float_blank():
    assert coerce_float("") is None
    assert coerce_float("  ") is None


def test_coerce_float_valid():
    assert coerce_float("23.4") == pytest.approx(23.4)


def test_coerce_float_negative():
    assert coerce_float("-1.5") == pytest.approx(-1.5)


def test_coerce_mm_never_nan():
    result = coerce_float("MM")
    assert result is None
    # Ensure it's not float("nan")
    assert result != result is False  # nan != nan would be True; None != None is False


# ── parse_location ────────────────────────────────────────────────────────────

def test_parse_location_north_west():
    loc = "28.508 N 80.185 W (28°30'27\" N 80°11'6\" W)"
    lat, lon = parse_location(loc)
    assert lat == pytest.approx(28.508)
    assert lon == pytest.approx(-80.185)


def test_parse_location_south_east():
    loc = "33.5 S 45.2 E (33°30'0\" S 45°12'0\" E)"
    lat, lon = parse_location(loc)
    assert lat == pytest.approx(-33.5)
    assert lon == pytest.approx(45.2)


def test_parse_location_invalid():
    lat, lon = parse_location("no coords here")
    assert lat is None
    assert lon is None


def test_parse_location_empty():
    lat, lon = parse_location("")
    assert lat is None
    assert lon is None


# ── parse_timestamp ───────────────────────────────────────────────────────────

def test_parse_timestamp():
    ts, iso = parse_timestamp("24", "06", "15", "12", "00")
    assert ts == 1718452800
    assert iso == "2024-06-15T12:00:00Z"


# ── parse_standard_row ────────────────────────────────────────────────────────

STANDARD_ROW = "24 06 15 12 00 270 5.1 6.2 1.5 8 7 MM 1015.0 25.0 23.4 18.0 MM MM MM".split()


def test_parse_standard_row_basic():
    result = parse_standard_row(STANDARD_ROW)
    assert result["ts"] == 1718452800
    assert result["values"]["waterTemperature"] == pytest.approx(23.4)
    assert result["values"]["windSpeed"] == pytest.approx(5.1)
    assert result["values"]["pressure"] == pytest.approx(1015.0)


def test_parse_standard_row_with_mm():
    row = STANDARD_ROW.copy()
    row[14] = "MM"  # WTMP column
    result = parse_standard_row(row)
    assert result["values"]["waterTemperature"] is None


def test_parse_standard_row_mm_never_nan():
    row = STANDARD_ROW.copy()
    row[14] = "MM"
    result = parse_standard_row(row)
    wt = result["values"]["waterTemperature"]
    assert wt is None
    # Must not be float nan
    if wt is not None:
        assert wt == wt  # nan != nan would fail


# ── parse_ocean_row ───────────────────────────────────────────────────────────

def test_parse_ocean_row():
    row = "24 06 15 12 00 10.0 22.1 4.5 35.2 MM MM MM MM 8.1 MM".split()
    result = parse_ocean_row(row)
    assert result["values"]["waterTemperature"] == pytest.approx(22.1)
    assert result["values"]["salinity"] == pytest.approx(35.2)
    assert result["values"]["depth"] == pytest.approx(10.0)


# ── parse_ndbc_file ───────────────────────────────────────────────────────────

STANDARD_FILE = """#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE
#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft
24 06 15 12 00 270  5.1  6.2   1.5   8.0   7.0  MM 1015.0  25.0  23.4  18.0   MM   MM   MM
24 06 15 11 00 265  4.8  5.9   1.4   7.5   6.8  MM 1014.5  24.8  23.1  17.8   MM   MM   MM
"""


def test_parse_ndbc_file_standard():
    results = parse_ndbc_file(STANDARD_FILE, "standard")
    assert len(results) == 2
    assert results[0]["values"]["waterTemperature"] == pytest.approx(23.4)
    assert results[1]["values"]["waterTemperature"] == pytest.approx(23.1)


def test_parse_ndbc_file_empty():
    results = parse_ndbc_file("", "standard")
    assert results == []


def test_water_temp_precedence_standard():
    results = parse_ndbc_file(STANDARD_FILE, "standard")
    # Standard WTMP present — should be waterTemperature
    assert results[0]["values"]["waterTemperature"] is not None


# ── parse_station_table ───────────────────────────────────────────────────────

STATION_TABLE = """# STATION_ID | OWNER | TTYPE | HULL | NAME | PAYLOAD | LOCATION | TIMEZONE | FORECAST | NOTE
41008 | NDBC | BUOY | 3-m discus | GRAYS REEF - 40 NM Southeast of Savannah, GA | S | 31.402 N 80.866 W (31°24'7" N 80°51'58" W) | ET | AR7 |
44013 | NDBC | BUOY | 3-m discus | BOSTON 16 NM East of Boston, MA | S | 42.346 N 70.651 W (42°20'46" N 70°39'4" W) | ET | ANZ232 |
"""


def test_parse_station_table_basic():
    stations = parse_station_table(STATION_TABLE)
    assert len(stations) == 2

    s1 = next(s for s in stations if s["stationId"] == "41008")
    assert s1["lat"] == pytest.approx(31.402)
    assert s1["lon"] == pytest.approx(-80.866)
    assert s1["owner"] == "NDBC"

    s2 = next(s for s in stations if s["stationId"] == "44013")
    assert s2["lat"] == pytest.approx(42.346)
    assert s2["lon"] == pytest.approx(-70.651)


def test_parse_station_table_south_west_negative():
    table = "# header\n99999 | TEST | BUOY | disc | Test Station | S | 10.5 S 20.3 W (blah) | UTC | | \n"
    stations = parse_station_table(table)
    assert len(stations) == 1
    assert stations[0]["lat"] == pytest.approx(-10.5)
    assert stations[0]["lon"] == pytest.approx(-20.3)
