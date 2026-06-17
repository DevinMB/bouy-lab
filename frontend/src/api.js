const BASE = '/api'

async function apiFetch(path) {
  const r = await fetch(BASE + path)
  if (!r.ok) throw new Error(`API ${path} returned ${r.status}`)
  return r.json()
}

export async function fetchBuoys(locatedOnly = true) {
  return apiFetch(`/buoys?located_only=${locatedOnly}`)
}

export async function fetchBuoyDetail(id) {
  return apiFetch(`/buoys/${id}`)
}

export async function fetchSeries(id, stream, field, limit = 200) {
  return apiFetch(`/buoys/${id}/series?stream=${stream}&field=${field}&limit=${limit}`)
}

export async function fetchNearby(lat, lon, radiusKm = 200, limit = 10) {
  return apiFetch(`/nearby?lat=${lat}&lon=${lon}&radius_km=${radiusKm}&limit=${limit}`)
}

export async function fetchStats() {
  return apiFetch('/stats')
}

export async function fetchResearchTrend(stream, field, hours = 120) {
  return apiFetch(`/research/trend?stream=${stream}&field=${field}&hours=${hours}`)
}

export async function fetchResearchCorrelate(stream, field, stations, hours = 120) {
  const ids = encodeURIComponent(stations.join(','))
  return apiFetch(`/research/correlate?stream=${stream}&field=${field}&stations=${ids}&hours=${hours}`)
}

export async function fetchResearchTrendRegion(stream, field, lat, lon, radiusKm, hours = 120) {
  return apiFetch(`/research/trend_region?stream=${stream}&field=${field}&lat=${lat}&lon=${lon}&radius_km=${radiusKm}&hours=${hours}`)
}

export async function fetchHealth() {
  return apiFetch('/health')
}

export const units = {
  tempC_to_F: (c) => (c != null ? c * 9 / 5 + 32 : null),
  mps_to_mph: (v) => (v != null ? v * 2.23694 : null),
  m_to_ft: (v) => (v != null ? v * 3.28084 : null),
  km_to_mi: (v) => (v != null ? v * 0.621371 : null),
  hPa_to_inHg: (v) => (v != null ? v * 0.02953 : null),

  formatTemp: (c, useMetric) =>
    c == null ? '—' : useMetric ? `${c.toFixed(1)} °C` : `${(c * 9 / 5 + 32).toFixed(1)} °F`,

  formatWind: (mps, useMetric) =>
    mps == null ? '—' : useMetric ? `${mps.toFixed(1)} m/s` : `${(mps * 2.23694).toFixed(1)} mph`,

  formatWave: (m, useMetric) =>
    m == null ? '—' : useMetric ? `${m.toFixed(1)} m` : `${(m * 3.28084).toFixed(1)} ft`,

  formatPressure: (hPa, useMetric) =>
    hPa == null ? '—' : useMetric ? `${hPa.toFixed(1)} hPa` : `${(hPa * 0.02953).toFixed(2)} inHg`,

  formatDist: (km, useMetric) =>
    km == null ? '—' : useMetric ? `${km.toFixed(1)} km` : `${(km * 0.621371).toFixed(1)} mi`,

  displayTemp: (c, useMetric) => (useMetric ? c : (c != null ? c * 9 / 5 + 32 : null)),
}
