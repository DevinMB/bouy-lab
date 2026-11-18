import React, { useEffect, useState } from 'react'
import { fetchBuoyDetail, fetchSeries, fetchPropagation, units as U } from '../api'
import { thermalColor, thermalGradient } from '../thermal'
import Sparkline from './Sparkline'

const STREAM_FIELDS = {
  standard: { field: 'waterTemperature', label: 'Water', unit: 'temp' },
  ocean: { field: 'waterTemperature', label: 'Subsurface', unit: 'temp' },
  spec: { field: 'waveHeight', label: 'Waves', unit: 'wave' },
  srad: { field: 'solarRadiation', label: 'Solar', unit: '' },
}

const convertSeries = (v, unit, useMetric) => U.convert(v, unit, useMetric)
const seriesUnitLabel = (unit, useMetric) => (unit === '' ? 'W/m²' : U.unitLabel(unit, useMetric))

// Chart colour: temperature streams use the SST ramp (meaningful); other
// streams get a fixed bright colour, since the thermal ramp renders small wave/
// solar values as a hard-to-see deep-water blue.
function sparkColor(unit, firstVal) {
  switch (unit) {
    case 'temp': return thermalColor(firstVal)
    case 'wave': return '#60a5fa'
    default: return '#facc15'
  }
}

// Metrics that make sense to forecast via upstream propagation. The default is
// remembered in localStorage so changing it in one buoy sets it for all.
const FORECAST_METRICS = [
  { id: 'waveHeight', field: 'waveHeight', label: 'Wave Height', short: 'Waves', unit: 'wave', streams: ['standard', 'spec'] },
  { id: 'pressure', field: 'pressure', label: 'Pressure', short: 'Pressure', unit: 'pressure', streams: ['standard'] },
  { id: 'windSpeed', field: 'windSpeed', label: 'Wind Speed', short: 'Wind', unit: 'wind', streams: ['standard'] },
  { id: 'waterTemperature', field: 'waterTemperature', label: 'Water Temp', short: 'Water', unit: 'temp', streams: ['standard', 'ocean'] },
]

function loadForecastMetric() {
  try { return localStorage.getItem('forecastMetric') || 'waveHeight' } catch { return 'waveHeight' }
}

// Format an ISO timestamp into a local time string + relative age.
function formatObserved(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  const ageMin = (Date.now() - d.getTime()) / 60000
  let ago
  if (ageMin < 60) ago = `${Math.max(1, Math.round(ageMin))} min ago`
  else if (ageMin < 60 * 48) ago = `${Math.round(ageMin / 60)} h ago`
  else ago = `${Math.round(ageMin / 1440)} d ago`
  const local = d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return { local, ago, stale: ageMin > 24 * 60 }
}

// ── Plain-language readings ──────────────────────────────────────────────
const CARDINALS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
const cardinal = (deg) => (deg == null ? null : CARDINALS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16])

function windWord(mps) {
  if (mps == null) return null
  if (mps < 0.5) return 'Calm'
  if (mps < 3.4) return 'Light air'
  if (mps < 8) return 'Moderate breeze'
  if (mps < 13.9) return 'Strong breeze'
  if (mps < 20.8) return 'Gale'
  return 'Storm force'
}

function swellWord(period) {
  if (period == null) return null
  if (period >= 13) return 'Long-period groundswell'
  if (period >= 9) return 'Mid-period swell'
  return 'Short-period wind chop'
}

function pressureTrend(ptdy) {
  if (ptdy == null) return null
  if (ptdy <= -1) return { arrow: '↓', word: 'Falling', hint: 'weather may turn' }
  if (ptdy >= 1) return { arrow: '↑', word: 'Rising', hint: 'settling conditions' }
  return { arrow: '→', word: 'Steady', hint: 'no big change' }
}

// Split "12.3 mph" → ["12.3", "mph"] so the number and unit can be set apart.
function split(formatted) {
  if (!formatted || formatted === '—') return ['—', '']
  const i = formatted.indexOf(' ')
  return i < 0 ? [formatted, ''] : [formatted.slice(0, i), formatted.slice(i + 1)]
}

// ── Small pieces ─────────────────────────────────────────────────────────
function Icon({ d, size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

const ICONS = {
  wind: 'M2 6h8a2 2 0 1 0-2-2M2 10h11a2 2 0 1 1-2 2',
  wave: 'M1 9c1.75 0 1.75-1.5 3.5-1.5S6.25 9 8 9s1.75-1.5 3.5-1.5S13.25 9 15 9M1 13c1.75 0 1.75-1.5 3.5-1.5S6.25 13 8 13s1.75-1.5 3.5-1.5S13.25 13 15 13',
  air: 'M8 2v8.5M5.5 12.5a2.5 2.5 0 1 0 5 0 2.5 2.5 0 0 0-5 0M10 4h2M10 7h2',
  gauge: 'M2.5 11a5.5 5.5 0 1 1 11 0M8 11l2.5-3.5',
  close: 'M4 4l8 8M12 4l-8 8',
  link: 'M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1',
  check: 'M3 8.5l3 3 7-7',
  target: 'M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5',
}

// Wind compass: the arrow points where the wind is blowing TO (NDBC reports FROM).
function Compass({ deg, speed }) {
  const has = deg != null
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" aria-label={has ? `Wind from ${cardinal(deg)}` : 'No wind direction'}>
      <circle cx="32" cy="32" r="29" fill="var(--color-bg)" stroke="var(--color-border-2)" />
      {Array.from({ length: 24 }).map((_, i) => {
        const a = (i * 15 * Math.PI) / 180
        const major = i % 6 === 0
        const r1 = major ? 23 : 25.5
        return <line key={i} x1={32 + Math.sin(a) * r1} y1={32 - Math.cos(a) * r1} x2={32 + Math.sin(a) * 28} y2={32 - Math.cos(a) * 28} stroke={major ? 'var(--color-text-dim)' : 'var(--color-border-2)'} strokeWidth={major ? 1.4 : 1} />
      })}
      <text x="32" y="15" textAnchor="middle" fontSize="7" fontFamily="var(--font-mono)" fill="var(--color-text-dim)">N</text>
      {has && (
        <g transform={`rotate(${deg + 180} 32 32)`}>
          <line x1="32" y1="46" x2="32" y2="20" stroke="var(--color-amber)" strokeWidth="2" strokeLinecap="round" />
          <path d="M27 23 32 15l5 8z" fill="var(--color-amber)" />
        </g>
      )}
      <circle cx="32" cy="32" r="9" fill="var(--color-bg-3)" stroke="var(--color-border-2)" />
      <text x="32" y="35" textAnchor="middle" fontSize="8.5" fontFamily="var(--font-display)" fontWeight="600" fill="var(--color-text-bright)">{speed}</text>
    </svg>
  )
}

function Tile({ icon, label, value, unit, note, children }) {
  const empty = value === '—'
  return (
    <div className={`tile${empty ? ' empty' : ''}`}>
      <div className="eyebrow"><Icon d={ICONS[icon]} /> {label}</div>
      <div className="value">{value}{unit && <small>{unit}</small>}</div>
      {children}
      {note && <div className="note">{note}</div>}
    </div>
  )
}

function Row({ k, v }) {
  if (v == null || v === '') return null
  return (
    <div className="readout-row">
      <span className="k">{k}</span>
      <span className="leader" />
      <span className="v">{v}</span>
    </div>
  )
}

// ── Panel ────────────────────────────────────────────────────────────────
export default function DetailPanel({ buoy, useMetric, onClose, onNearbyRequest, onShowPropagationMap, onOpenPropagation }) {
  const [detail, setDetail] = useState(null)
  const [seriesData, setSeriesData] = useState({})
  const [loadingSeries, setLoadingSeries] = useState(false)
  const [historyStream, setHistoryStream] = useState(null)
  const [forecast, setForecast] = useState(null)
  const [forecastLoading, setForecastLoading] = useState(false)
  const [forecastMetricId, setForecastMetricId] = useState(loadForecastMetric)
  const [copied, setCopied] = useState(false)

  const changeForecastMetric = (id) => {
    setForecastMetricId(id)
    try { localStorage.setItem('forecastMetric', id) } catch { /* ignore */ }
  }

  // The chosen forecast metric and the stream this buoy reports it on (if any).
  const fm = FORECAST_METRICS.find((m) => m.id === forecastMetricId) || FORECAST_METRICS[0]
  const forecastable = FORECAST_METRICS.some((m) => m.streams.some((s) => buoy?.available?.includes(s)))
  const forecastStream = fm.streams.find((s) => buoy?.available?.includes(s)) || null

  useEffect(() => {
    setForecast(null)
    if (!buoy || !forecastStream) return
    let alive = true
    setForecastLoading(true)
    fetchPropagation(buoy.id, forecastStream, fm.field, 336, 36, { topN: 3, maxDistKm: 3000 })
      .then((r) => { if (alive) setForecast(r) })
      .catch(() => { if (alive) setForecast(null) })
      .finally(() => { if (alive) setForecastLoading(false) })
    return () => { alive = false }
  }, [buoy?.id, forecastStream, fm.field])

  const copyLink = () => {
    const url = `${window.location.origin}/buoy/${encodeURIComponent(buoy.id)}`
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1500) }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(() => window.prompt('Copy this link:', url))
    } else {
      window.prompt('Copy this link:', url)
    }
  }

  useEffect(() => {
    if (!buoy) return
    setDetail(null)
    setSeriesData({})
    setHistoryStream(null)
    fetchBuoyDetail(buoy.id)
      .then(setDetail)
      .catch(console.error)
  }, [buoy?.id])

  useEffect(() => {
    if (!detail?.available?.length) return
    setLoadingSeries(true)
    const available = detail.available.filter((s) => STREAM_FIELDS[s])
    Promise.all(
      available.map((stream) => {
        const { field } = STREAM_FIELDS[stream]
        return fetchSeries(detail.id, stream, field, 96)
          .then((res) => [stream, res.data])
          .catch(() => [stream, []])
      })
    )
      .then((pairs) => {
        const map = {}
        pairs.forEach(([s, d]) => { map[s] = d })
        setSeriesData(map)
      })
      .finally(() => setLoadingSeries(false))
  }, [detail?.id, detail?.available?.join(',')])

  // Escape closes the sheet.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!buoy) return null

  const wtc = buoy.latest?.waterTempC
  const std = detail?.streams?.standard?.values || {}
  const L = buoy.latest || {}
  const observed = formatObserved(detail?.latest?.observedAt || L.observedAt)
  const ownerName = detail?.owner || buoy.owner
  const stationType = detail?.ttype || detail?.type || buoy.type

  // Prefer the detail doc, fall back to the list snapshot.
  const windSpeed = std.windSpeed ?? L.windSpeed
  const gust = std.gustSpeed ?? L.gustSpeed
  const windDir = std.windDirection ?? L.windDirection
  const waveHt = std.waveHeight ?? L.waveHeight ?? L.swellHeight
  const wavePeriod = std.dominantWavePeriod ?? L.swellPeriod
  const waveDir = std.meanWaveDirection ?? L.swellDirection
  const pressure = std.pressure ?? L.pressure
  const air = std.airTemperature ?? L.airTemperature
  const trend = pressureTrend(std.pressureTendency)

  const [windVal, windUnit] = split(U.formatWind(windSpeed, useMetric))
  const [waveVal, waveUnit] = split(U.formatWave(waveHt, useMetric))
  const [airVal, airUnit] = split(U.formatTemp(air, useMetric))
  const [presVal, presUnit] = split(U.formatPressure(pressure, useMetric))
  const tempUnit = useMetric ? '°C' : '°F'

  const airWaterDelta = air != null && wtc != null ? U.convertDelta(air - wtc, 'temp', useMetric) : null
  const airNote = airWaterDelta == null
    ? (std.dewPoint != null ? `Dew point ${U.formatTemp(std.dewPoint, useMetric)}` : null)
    : Math.abs(airWaterDelta) < 1
      ? 'Air and water about even'
      : `${Math.abs(airWaterDelta).toFixed(0)}° ${airWaterDelta > 0 ? 'warmer' : 'cooler'} than the water`

  // Where this reading sits on the global SST ramp (−2…31 °C).
  const scalePct = wtc != null ? Math.max(0, Math.min(100, ((wtc + 2) / 33) * 100)) : null
  const glow = wtc != null ? thermalColor(wtc) : 'transparent'

  // History tabs: one per stream with data; the selected one drives the chart.
  const historyTabs = Object.entries(STREAM_FIELDS)
    .filter(([stream]) => buoy.available?.includes(stream) && seriesData[stream]?.length)
  const activeHistory = historyTabs.find(([s]) => s === historyStream) || historyTabs[0]

  return (
    <aside className="detail-panel glass" aria-label={`Station ${buoy.id}`}>
      <div className="detail-scroll">
        {/* Header + hero */}
        <div style={{ padding: '1rem 1.125rem 1.125rem', background: `radial-gradient(120% 90% at 0% 0%, color-mix(in srgb, ${glow} 16%, transparent), transparent 60%)` }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="eyebrow">Station {buoy.id}{stationType ? ` · ${stationType}` : ''}</div>
              <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '1.25rem', lineHeight: 1.2, color: 'var(--color-text-bright)', marginTop: 4, letterSpacing: '-0.01em' }}>
                {buoy.name || buoy.id}
              </h2>
            </div>
            <button className="icon-btn" onClick={copyLink} title={copied ? 'Link copied' : 'Copy share link'} aria-label="Copy share link">
              <Icon d={copied ? ICONS.check : ICONS.link} size={14} />
            </button>
            <button className="icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close">
              <Icon d={ICONS.close} size={14} />
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '1rem', marginTop: '1.25rem' }}>
            <div>
              <div className="eyebrow" style={{ marginBottom: 6 }}>Sea surface</div>
              <div className="hero-temp">
                <span className="big">{wtc != null ? U.displayTemp(wtc, useMetric).toFixed(1) : '—'}</span>
                {wtc != null && <span className="unit">{tempUnit}</span>}
              </div>
            </div>
            <div className="fresh-pill" title={observed ? `Observed ${observed.local}` : undefined}>
              <span className={`pulse${!observed || observed.stale ? ' stale' : ''}`} style={{ width: 6, height: 6 }} />
              {observed ? <span><b>{observed.ago}</b></span> : <span>No recent obs</span>}
            </div>
          </div>

          {scalePct != null && (
            <div style={{ marginTop: '1rem' }}>
              <div className="thermal-scale" style={{ background: thermalGradient(20) }}>
                <span className="marker" style={{ left: `${scalePct}%`, background: glow }} />
              </div>
              <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.625rem', color: 'var(--color-text-dim)', marginTop: 6 }}>
                <span>{useMetric ? '−2°' : '28°'}</span>
                <span>global ocean range</span>
                <span>{useMetric ? '31°' : '88°'}</span>
              </div>
            </div>
          )}
        </div>

        {/* Conditions */}
        <div className="detail-section">
          <div className="tiles">
            <div className="tile wide">
              <Compass deg={windDir} speed={windVal === '—' ? '–' : Math.round(parseFloat(windVal))} />
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <div className="eyebrow"><Icon d={ICONS.wind} /> Wind</div>
                <div className="value">
                  {windVal}<small>{windUnit}</small>
                  {windDir != null && <small>from {cardinal(windDir)}</small>}
                </div>
                <div className="note">
                  {[windWord(windSpeed), gust != null ? `gusts ${U.formatWind(gust, useMetric)}` : null].filter(Boolean).join(' · ') || 'No wind sensor reporting'}
                </div>
              </div>
            </div>

            <Tile icon="wave" label="Waves" value={waveVal} unit={waveUnit}
              note={wavePeriod != null ? `${wavePeriod.toFixed(0)}s${waveDir != null ? ` from ${cardinal(waveDir)}` : ''} · ${swellWord(wavePeriod)}` : (waveHt == null ? 'Not measured here' : null)} />

            <Tile icon="air" label="Air" value={airVal} unit={airUnit} note={airNote} />

            <Tile icon="gauge" label="Pressure" value={presVal} unit={presUnit}
              note={trend ? `${trend.arrow} ${trend.word} — ${trend.hint}` : null} />

            <Tile icon="air" label="Dew point" value={split(U.formatTemp(std.dewPoint, useMetric))[0]} unit={std.dewPoint != null ? tempUnit : ''}
              note={std.visibility != null ? `Visibility ${std.visibility} nmi` : null} />
          </div>
        </div>

        {/* Incoming — swell/storm propagation forecast (metric is a saved default) */}
        {forecastable && (
          <div className="detail-section">
            <div className="detail-section-head">
              <span className="eyebrow">Incoming · next 36h</span>
            </div>
            <div className="segmented small" role="group" aria-label="Forecast metric" style={{ marginBottom: '0.75rem', display: 'flex' }}>
              {FORECAST_METRICS.map((m) => (
                <button key={m.id} style={{ flex: 1 }} aria-pressed={m.id === forecastMetricId} onClick={() => changeForecastMetric(m.id)}>{m.short}</button>
              ))}
            </div>

            {!forecastStream && (
              <div className="note" style={{ fontSize: '0.8125rem', color: 'var(--color-text-dim)' }}>This station doesn’t report {fm.label.toLowerCase()}.</div>
            )}
            {forecastStream && forecastLoading && <div className="loading-veil" style={{ height: 80 }}>Tracing upstream buoys…</div>}
            {forecastStream && !forecastLoading && (!forecast || !forecast.leaders?.length) && (
              <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-dim)' }}>No upstream buoy leads this one strongly enough to forecast from.</div>
            )}
            {forecastStream && !forecastLoading && forecast && forecast.leaders?.length > 0 && (() => {
              const top = forecast.leaders[0]
              const fc = forecast.forecast || []
              const ulabel = seriesUnitLabel(fm.unit, useMetric)
              const data = fc.map((p) => ({ ts: p.ts, value: convertSeries(p.value, fm.unit, useMetric) }))
              const peak = data.length ? Math.max(...data.map((d) => d.value)) : null
              const payload = {
                targetId: forecast.target, targetName: forecast.targetName, label: fm.label,
                target: { lat: buoy.lat, lon: buoy.lon },
                leaders: forecast.leaders.map((Ld) => ({ id: Ld.id, lat: Ld.lat, lon: Ld.lon, lagHours: Ld.lagHours, r: Ld.r })),
              }
              return (
                <>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.25rem' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-bright)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {top.name || top.id}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--color-text-dim)' }}>leads this station by ~{top.lagHours}h</div>
                    </div>
                    {peak != null && (
                      <div style={{ textAlign: 'right', flex: 'none' }}>
                        <div className="eyebrow">Peak</div>
                        <div className="num" style={{ fontSize: '1.125rem', color: 'var(--color-text-bright)', fontWeight: 500 }}>{peak.toFixed(1)}<small style={{ fontSize: '0.6875rem', color: 'var(--color-text-dim)', marginLeft: 3 }}>{ulabel}</small></div>
                      </div>
                    )}
                  </div>
                  {data.length > 0 && <Sparkline data={data} color="#60a5fa" unitLabel={ulabel} height={96} dashed />}
                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.625rem' }}>
                    {onShowPropagationMap && (
                      <button className="btn" style={{ flex: 1, justifyContent: 'center' }} onClick={() => onShowPropagationMap(payload)}>
                        Show on map
                      </button>
                    )}
                    {onOpenPropagation && (
                      <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }}
                        onClick={() => onOpenPropagation({ id: buoy.id, metricKey: `${forecastStream}:${fm.field}` })}>
                        Full forecast →
                      </button>
                    )}
                  </div>
                </>
              )
            })()}
          </div>
        )}

        {/* History: metric tabs drive one chart */}
        <div className="detail-section">
          <div className="detail-section-head">
            <span className="eyebrow">Past 4 days</span>
          </div>
          {loadingSeries && <div className="loading-veil" style={{ height: 120 }}>Loading history…</div>}
          {!loadingSeries && historyTabs.length === 0 && (
            <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-dim)' }}>No history recorded for this station yet.</div>
          )}
          {!loadingSeries && activeHistory && (
            <>
              <div className="metric-tabs" role="tablist">
                {historyTabs.map(([stream, { label, unit }]) => {
                  const latest = seriesData[stream][0]?.value
                  const v = convertSeries(latest, unit, useMetric)
                  return (
                    <button key={stream} role="tab" className="metric-tab" aria-selected={stream === activeHistory[0]} onClick={() => setHistoryStream(stream)}>
                      <span className="eyebrow">{label}</span>
                      <span className="num">{v != null ? v.toFixed(1) : '—'}<small>{seriesUnitLabel(unit, useMetric)}</small></span>
                    </button>
                  )
                })}
              </div>
              <div className="metric-chart">
                {(() => {
                  const [stream, { unit }] = activeHistory
                  const raw = seriesData[stream] || []
                  const data = raw.map((d) => ({ ...d, value: convertSeries(d.value, unit, useMetric) }))
                  return <Sparkline data={data} color={sparkColor(unit, raw[0]?.value)} unitLabel={seriesUnitLabel(unit, useMetric)} height={120} />
                })()}
              </div>
            </>
          )}
        </div>

        {/* Station facts */}
        <div className="detail-section">
          <div className="readout">
            <Row k="Operator" v={ownerName} />
            <Row k="Platform" v={stationType} />
            <Row k="Position" v={buoy.lat != null ? <span className="mono">{Math.abs(buoy.lat).toFixed(2)}°{buoy.lat >= 0 ? 'N' : 'S'} {Math.abs(buoy.lon).toFixed(2)}°{buoy.lon >= 0 ? 'E' : 'W'}</span> : null} />
            <Row k="Observed" v={observed?.local} />
            <Row k="Streams" v={buoy.available?.length ? <span className="mono">{buoy.available.join(' · ')}</span> : null} />
          </div>
        </div>
      </div>

      <div className="detail-actions">
        <button className="btn" onClick={() => onNearbyRequest({ lat: buoy.lat, lon: buoy.lon, stationId: buoy.id })}>
          <Icon d={ICONS.target} size={14} /> Compare nearby
        </button>
        <button className={`btn${copied ? ' btn-amber' : ''}`} onClick={copyLink}>
          <Icon d={copied ? ICONS.check : ICONS.link} size={14} /> {copied ? 'Copied' : 'Share link'}
        </button>
      </div>
    </aside>
  )
}
