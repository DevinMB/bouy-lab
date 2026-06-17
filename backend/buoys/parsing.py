import re
import logging
from datetime import datetime, timezone

log = logging.getLogger(__name__)

# Regex to extract decimal-degree lat/lon from NDBC LOCATION field
_LOC_RE = re.compile(
    r"(-?\d+(?:\.\d+)?)\s*([NS])\s+(-?\d+(?:\.\d+)?)\s*([EW])"
)


def parse_location(location_str: str) -> tuple:
    """Extract (lat, lon) from NDBC LOCATION field. Returns (None, None) on failure."""
    if not location_str:
        return None, None
    m = _LOC_RE.search(location_str)
    if not m:
        return None, None
    lat = float(m.group(1))
    if m.group(2) == "S":
        lat = -lat
    lon = float(m.group(3))
    if m.group(4) == "W":
        lon = -lon
    return lat, lon


def coerce_float(val: str):
    """Convert NDBC value to float. MM, blank, or non-numeric -> None."""
    if not val or val.strip() in ("MM", ""):
        return None
    try:
        return float(val.strip())
    except ValueError:
        return None


def parse_timestamp(yy: str, mo: str, dd: str, hh: str, mm: str) -> tuple:
    """Parse NDBC 5-column UTC timestamp into (epoch_seconds, iso8601).

    NDBC switched to 4-digit years at some point; handle both gracefully.
    """
    year = int(yy)
    if year < 100:
        year += 2000
    dt = datetime(year, int(mo), int(dd), int(hh), int(mm), tzinfo=timezone.utc)
    return int(dt.timestamp()), dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _base(row: list) -> dict:
    """Parse the 5-column timestamp prefix common to all NDBC file types."""
    ts, observed_at = parse_timestamp(row[0], row[1], row[2], row[3], row[4])
    return {"ts": ts, "observedAt": observed_at}


def parse_standard_row(row: list) -> dict:
    """
    19 columns: YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP DEWP VIS PTDY TIDE
    Indices:      0  1  2  3  4    5    6   7    8   9  10  11   12   13   14   15  16   17   18
    """
    if len(row) < 15:
        return {}
    d = _base(row)
    d["values"] = {
        "windDirection": coerce_float(row[5]),
        "windSpeed": coerce_float(row[6]),
        "gustSpeed": coerce_float(row[7]),
        "waveHeight": coerce_float(row[8]),
        "dominantWavePeriod": coerce_float(row[9]),
        "averageWavePeriod": coerce_float(row[10]),
        "meanWaveDirection": coerce_float(row[11]),
        "pressure": coerce_float(row[12]),
        "airTemperature": coerce_float(row[13]),
        "waterTemperature": coerce_float(row[14]),
        "dewPoint": coerce_float(row[15]) if len(row) > 15 else None,
        "visibility": coerce_float(row[16]) if len(row) > 16 else None,
        "pressureTendency": coerce_float(row[17]) if len(row) > 17 else None,
        "tide": coerce_float(row[18]) if len(row) > 18 else None,
    }
    return d


def parse_ocean_row(row: list) -> dict:
    """
    15 columns: YY MM DD hh mm DEPTH OTMP COND SAL O2% O2PPM CLCON TURB PH EH
    """
    if len(row) < 7:
        return {}
    d = _base(row)
    d["values"] = {
        "depth": coerce_float(row[5]),
        "waterTemperature": coerce_float(row[6]),  # OTMP
        "conductivity": coerce_float(row[7]) if len(row) > 7 else None,
        "salinity": coerce_float(row[8]) if len(row) > 8 else None,
        "oxygenPercent": coerce_float(row[9]) if len(row) > 9 else None,
        "dissolvedOxygen": coerce_float(row[10]) if len(row) > 10 else None,
        "chlorophyll": coerce_float(row[11]) if len(row) > 11 else None,
        "turbidity": coerce_float(row[12]) if len(row) > 12 else None,
        "pH": coerce_float(row[13]) if len(row) > 13 else None,
        "redoxPotential": coerce_float(row[14]) if len(row) > 14 else None,
    }
    return d


def parse_spec_row(row: list) -> dict:
    """
    15 columns: YY MM DD hh mm WVHT SwH SwP WWH WWP SwD WWD STEEPNESS APD MWD
    """
    if len(row) < 10:
        return {}
    d = _base(row)
    d["values"] = {
        "waveHeight": coerce_float(row[5]),
        "swellHeight": coerce_float(row[6]),
        "swellPeriod": coerce_float(row[7]),
        "windWaveHeight": coerce_float(row[8]),
        "windWavePeriod": coerce_float(row[9]),
        "swellDirection": coerce_float(row[10]) if len(row) > 10 else None,
        "windWaveDirection": coerce_float(row[11]) if len(row) > 11 else None,
        "steepness": row[12].strip() if len(row) > 12 else None,
        "averageWavePeriod": coerce_float(row[13]) if len(row) > 13 else None,
        "meanWaveDirection": coerce_float(row[14]) if len(row) > 14 else None,
    }
    return d


def parse_srad_row(row: list) -> dict:
    """
    8 columns: YY MM DD hh mm SRAD1 SWRAD LWRAD
    """
    if len(row) < 6:
        return {}
    d = _base(row)
    d["values"] = {
        "solarRadiation": coerce_float(row[5]),
        "shortWaveRadiation": coerce_float(row[6]) if len(row) > 6 else None,
        "longWaveRadiation": coerce_float(row[7]) if len(row) > 7 else None,
    }
    return d


def parse_dart_row(row: list) -> dict:
    """
    7 columns: YY MM DD hh mm T HEIGHT
    """
    if len(row) < 7:
        return {}
    d = _base(row)
    d["values"] = {
        "type": row[5].strip() if len(row) > 5 else None,
        "waterColumnHeight": coerce_float(row[6]) if len(row) > 6 else None,
    }
    return d


_ROW_PARSERS = {
    "standard": parse_standard_row,
    "ocean": parse_ocean_row,
    "spec": parse_spec_row,
    "srad": parse_srad_row,
    "dart": parse_dart_row,
}


def parse_ndbc_file(text: str, stream: str) -> list:
    """
    Parse an NDBC realtime2 file. Skip the two # header rows and return
    a list of parsed row dicts, newest-first (as NDBC delivers them).
    """
    parser = _ROW_PARSERS.get(stream)
    if not parser:
        return []

    lines = text.splitlines()
    data_lines = []
    header_count = 0
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            header_count += 1
            continue
        data_lines.append(stripped)

    results = []
    for line in data_lines:
        try:
            row = line.split()
            parsed = parser(row)
            if parsed and "ts" in parsed:
                results.append(parsed)
        except Exception as e:
            log.debug("Failed to parse row in %s stream: %s — %s", stream, line, e)

    return results


def parse_station_table(text: str) -> list:
    """
    Parse the pipe-delimited NDBC station table.
    Columns: STATION_ID | OWNER | TTYPE | HULL | NAME | PAYLOAD | LOCATION | TIMEZONE | FORECAST | NOTE
    """
    stations = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = [p.strip() for p in stripped.split("|")]
        if len(parts) < 7:
            continue
        station_id = parts[0].lower()
        if not station_id:
            continue
        location_str = parts[6] if len(parts) > 6 else ""
        lat, lon = parse_location(location_str)
        stations.append({
            "stationId": station_id,
            "owner": parts[1],
            "ttype": parts[2],
            "hull": parts[3],
            "name": parts[4],
            "payload": parts[5],
            "location": location_str,
            "lat": lat,
            "lon": lon,
            "timezone": parts[7] if len(parts) > 7 else "",
        })
    return stations
