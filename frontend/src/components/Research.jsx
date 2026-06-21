import React, { useState, useMemo, useEffect, useRef } from 'react'
import {
  ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import {
  fetchResearchTrend, fetchResearchTrendStations, fetchResearchCorrelate,
  fetchTeleconnections, fetchAnomalies, fetchPropagation,
} from '../api'
import { pointInPolygon, polygonCentroid, haversineKm } from '../geo'
import { corrColor } from '../correlation'
import { useIsNarrow } from '../hooks'

// Metrics shared across many buoys (stream + field), with their SI unit family + chart color.
const METRICS = [
  { key: 'standard:waterTemperature', stream: 'standard', field: 'waterTemperature', label: 'Water Temp', unit: 'temp', color: '#ef6a4b' },
  { key: 'standard:airTemperature', stream: 'standard', field: 'airTemperature', label: 'Air Temp', unit: 'temp', color: '#f59e0b' },
  { key: 'standard:windSpeed', stream: 'standard', field: 'windSpeed', label: 'Wind Speed', unit: 'wind', color: '#14b8a6' },
  { key: 'standard:gustSpeed', stream: 'standard', field: 'gustSpeed', label: 'Gust Speed', unit: 'wind', color: '#0ea5e9' },
  { key: 'standard:waveHeight', stream: 'standard', field: 'waveHeight', label: 'Wave Height', unit: 'wave', color: '#3b82f6' },
  { key: 'standard:pressure', stream: 'standard', field: 'pressure', label: 'Pressure', unit: 'pressure', color: '#a855f7' },
  { key: 'spec:waveHeight', stream: 'spec', field: 'waveHeight', label: 'Wave Height (spectral)', unit: 'wave', color: '#6366f1' },
  { key: 'spec:swellHeight', stream: 'spec', field: 'swellHeight', label: 'Swell Height', unit: 'wave', color: '#8b5cf6' },
  { key: 'srad:solarRadiation', stream: 'srad', field: 'solarRadiation', label: 'Solar Radiation', unit: '', color: '#eab308' },
  { key: 'ocean:waterTemperature', stream: 'ocean', field: 'waterTemperature', label: 'Subsurface Temp', unit: 'temp', color: '#fb7185' },
]

const DEFAULT_ENABLED = ['standard:waterTemperature']

const WINDOWS = [
  { label: '24h', hours: 24 },
  { label: '3d', hours: 72 },
  { label: '7d', hours: 168 },
  { label: '14d', hours: 336 },
  { label: '30d', hours: 720 },
]

function convert(v, unit, useMetric) {
  if (v == null) return null
  if (useMetric) return v
  switch (unit) {
    case 'temp': return v * 9 / 5 + 32
    case 'wind': return v * 2.23694
    case 'wave': return v * 3.28084
    case 'pressure': return v * 0.02953
    default: return v
  }
}

function unitLabel(unit, useMetric) {
  switch (unit) {
    case 'temp': return useMetric ? '°C' : '°F'
    case 'wind': return useMetric ? 'm/s' : 'mph'
    case 'wave': return useMetric ? 'm' : 'ft'
    case 'pressure': return useMetric ? 'hPa' : 'inHg'
    default: return ''
  }
}

function fmtTs(ts) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  return `${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:00`
}

const selectStyle = {
  background: 'var(--color-bg)', border: '1px solid var(--color-border)',
  borderRadius: 4, color: 'var(--color-text)', fontSize: '0.8125rem',
  padding: '0.375rem 0.5rem', fontFamily: 'var(--font-body)', outline: 'none',
}

const segBtn = (active) => ({
  border: 'none', borderRadius: 0,
  background: active ? 'var(--color-amber-dim)' : 'transparent',
  color: active ? 'var(--color-amber)' : 'var(--color-text-dim)',
})

const MODES = [
  ['trend', 'Trend'],
  ['matrix', 'Correlation'],
  ['teleconnections', 'Teleconnections'],
  ['propagation', 'Propagation'],
  ['anomalies', 'Anomalies'],
]

const MAX_LAGS = [
  { label: '±24h', hours: 24 },
  { label: '±48h', hours: 48 },
  { label: '±72h', hours: 72 },
]

export default function Research({ buoys, useMetric, researchRegion, scope, onScopeChange, onOpenMap, onSelectBuoy, onShowCorrelationMap, onShowPropagationMap, propagationRequest, onConsumePropagationRequest }) {
  const isNarrow = useIsNarrow()
  // A propagation request (from a buoy's detail panel) opens this tab straight
  // into Propagation mode with that buoy preselected.
  const [mode, setMode] = useState(propagationRequest ? 'propagation' : 'trend')
  const [hours, setHours] = useState(168)
  const [maxLag, setMaxLag] = useState(48)
  const [enabled, setEnabled] = useState(DEFAULT_ENABLED)
  const [singleMetricKey, setSingleMetricKey] = useState(propagationRequest?.metricKey || METRICS[0].key)

  // Consume the request once so manual visits to this tab start fresh.
  useEffect(() => {
    if (propagationRequest) onConsumePropagationRequest?.()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const enabledMetrics = METRICS.filter((m) => enabled.includes(m.key))
  const singleMetric = METRICS.find((m) => m.key === singleMetricKey) || METRICS[0]
  const toggleMetric = (key) =>
    setEnabled((cur) => cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key])

  const showWindow = mode !== 'anomalies'
  const showScope = mode === 'trend' || mode === 'anomalies'
  const showMetricDropdown = mode !== 'trend'

  return (
    <div className="ops-page">
      {/* Controls row */}
      <div className="ops-section" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', border: '1px solid var(--color-border)', borderRadius: 4, overflow: 'hidden' }}>
          {MODES.map(([m, label]) => (
            <button key={m} onClick={() => setMode(m)} className="btn" style={segBtn(mode === m)}>{label}</button>
          ))}
        </div>

        {showWindow && (
          <div style={{ display: 'flex', gap: '0.25rem' }}>
            {WINDOWS.map((w) => (
              <button key={w.hours} onClick={() => setHours(w.hours)}
                className={`btn${hours === w.hours ? ' btn-amber' : ''}`} style={{ padding: '0.375rem 0.625rem' }}>
                {w.label}
              </button>
            ))}
          </div>
        )}

        {showScope && (
          <div style={{ display: 'flex', border: '1px solid var(--color-border)', borderRadius: 4, overflow: 'hidden' }}>
            {[['network', 'Network'], ['region', 'Region']].map(([s, label]) => (
              <button key={s} onClick={() => onScopeChange(s)} className="btn" style={segBtn(scope === s)}>{label}</button>
            ))}
          </div>
        )}

        {showMetricDropdown && (
          <select value={singleMetricKey} onChange={(e) => setSingleMetricKey(e.target.value)} style={selectStyle}>
            {METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        )}

        {mode === 'propagation' && (
          <div style={{ display: 'flex', gap: '0.25rem' }}>
            {MAX_LAGS.map((l) => (
              <button key={l.hours} onClick={() => setMaxLag(l.hours)}
                className={`btn${maxLag === l.hours ? ' btn-amber' : ''}`} style={{ padding: '0.375rem 0.625rem' }}>
                {l.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Metric show/hide chips (trend mode) */}
      {mode === 'trend' && (
        <div className="ops-section" style={{ marginTop: '-0.5rem' }}>
          <div style={{ fontSize: '0.625rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-text-dim)', marginBottom: '0.4rem' }}>
            Metrics — tap to show / hide
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
            {METRICS.map((m) => {
              const on = enabled.includes(m.key)
              return (
                <button key={m.key} onClick={() => toggleMetric(m.key)} className="mono"
                  style={{
                    fontSize: '0.6875rem', padding: '0.25rem 0.55rem', borderRadius: 12, cursor: 'pointer',
                    border: `1px solid ${on ? m.color : 'var(--color-border)'}`,
                    background: on ? `${m.color}22` : 'transparent',
                    color: on ? m.color : 'var(--color-text-dim)',
                    display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                  }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: m.color, display: 'inline-block', opacity: on ? 1 : 0.4 }} />
                  {m.label}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {mode === 'trend' && (
        <TrendStack metrics={enabledMetrics} hours={hours} useMetric={useMetric} scope={scope}
          region={researchRegion} buoys={buoys} onOpenMap={onOpenMap} isNarrow={isNarrow} onHide={toggleMetric} />
      )}
      {mode === 'matrix' && <MatrixView metric={singleMetric} hours={hours} buoys={buoys} onSelectBuoy={onSelectBuoy} />}
      {mode === 'teleconnections' && (
        <TeleconnectionView metric={singleMetric} hours={hours} buoys={buoys}
          onSelectBuoy={onSelectBuoy} onShowMap={onShowCorrelationMap} />
      )}
      {mode === 'propagation' && (
        <PropagationView metric={singleMetric} hours={hours} maxLag={maxLag} buoys={buoys}
          useMetric={useMetric} onSelectBuoy={onSelectBuoy} onShowMap={onShowPropagationMap}
          initialTarget={propagationRequest?.id} />
      )}
      {mode === 'anomalies' && (
        <AnomalyView metric={singleMetric} scope={scope} region={researchRegion} buoys={buoys}
          useMetric={useMetric} isNarrow={isNarrow} onSelectBuoy={onSelectBuoy} onOpenMap={onOpenMap} />
      )}
    </div>
  )
}

// ── Reusable buoy picker (search + selected chips + results) ────────────────
function BuoyPicker({ candidates, selected, onToggle, placeholder = 'Search buoys…', single = false }) {
  const [search, setSearch] = useState('')
  const matches = useMemo(() => {
    const q = search.toLowerCase().trim()
    return candidates
      .filter((b) => !q || b.id.toLowerCase().includes(q) || (b.name || '').toLowerCase().includes(q))
      .slice(0, 30)
  }, [candidates, search])

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginBottom: '0.5rem' }}>
        {selected.length === 0 && <span style={{ fontSize: '0.75rem', color: 'var(--color-text-dim)' }}>{single ? 'No buoy chosen' : 'None selected'}</span>}
        {selected.map((id) => (
          <button key={id} onClick={() => onToggle(id)} className="mono"
            style={{ fontSize: '0.6875rem', padding: '0.2rem 0.45rem', background: 'var(--color-amber-dim)', border: '1px solid var(--color-amber)', borderRadius: 12, color: 'var(--color-amber)', cursor: 'pointer' }}>
            {id} ×
          </button>
        ))}
      </div>
      <input className="input" placeholder={placeholder} value={search} onChange={(e) => setSearch(e.target.value)} style={{ marginBottom: '0.5rem' }} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', maxHeight: 120, overflowY: 'auto' }}>
        {candidates.length === 0 && <span style={{ fontSize: '0.75rem', color: 'var(--color-text-dim)' }}>No buoys report this metric yet.</span>}
        {matches.map((b) => {
          const on = selected.includes(b.id)
          return (
            <button key={b.id} onClick={() => onToggle(b.id)} className="mono"
              style={{ fontSize: '0.6875rem', padding: '0.2rem 0.45rem', background: on ? 'var(--color-surface-2)' : 'transparent', border: '1px solid var(--color-border)', borderRadius: 12, color: on ? 'var(--color-text-bright)' : 'var(--color-text-dim)', cursor: 'pointer' }}
              title={b.name || b.id}>
              {on ? '✓ ' : '+ '}{b.id}
            </button>
          )
        })}
      </div>
    </>
  )
}

// ── Network / Region trend (stacked per-metric charts) ──────────────────────
function TrendStack({ metrics, hours, useMetric, scope, region, buoys, onOpenMap, isNarrow, onHide }) {
  if (scope === 'region' && isNarrow) {
    return (
      <div className="ops-section">
        <div className="chart-container">
          <div className="loading-veil" style={{ height: 170, flexDirection: 'column', gap: '0.5rem', textAlign: 'center', padding: '1rem' }}>
            <div style={{ color: 'var(--color-text-bright)' }}>Region analysis is desktop-only</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--color-text-dim)' }}>
              Drawing a region requires a larger screen. Switch to <b style={{ color: 'var(--color-amber)' }}>Network</b> here, or open this on a desktop.
            </div>
          </div>
        </div>
      </div>
    )
  }

  const hasPolygon = (region?.points?.length || 0) >= 3
  if (scope === 'region' && !hasPolygon) {
    return (
      <div className="ops-section">
        <div className="chart-container">
          <div className="loading-veil" style={{ height: 170, flexDirection: 'column', gap: '0.75rem' }}>
            <div>No region drawn yet.</div>
            <button className="btn btn-primary" onClick={onOpenMap}>Go to Map → lasso a region</button>
          </div>
        </div>
      </div>
    )
  }

  if (metrics.length === 0) {
    return (
      <div className="ops-section">
        <div className="chart-container">
          <div className="loading-veil" style={{ height: 120 }}>Enable a metric above to see its trend.</div>
        </div>
      </div>
    )
  }

  return (
    <>
      {metrics.map((m) => (
        <TrendRow key={m.key} metric={m} hours={hours} useMetric={useMetric}
          scope={scope} region={region} buoys={buoys} onHide={() => onHide(m.key)} />
      ))}
    </>
  )
}

function TrendRow({ metric, hours, useMetric, scope, region, buoys, onHide }) {
  const [points, setPoints] = useState(null)
  const [meta, setMeta] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const regionStations = useMemo(() => {
    if (scope !== 'region' || !(region?.points?.length >= 3)) return []
    const inside = buoys.filter((b) => b.lat != null && b.lon != null
      && b.available?.includes(metric.stream)
      && pointInPolygon(b.lat, b.lon, region.points))
    if (inside.length <= 80) return inside.map((b) => b.id)
    const [cLat, cLon] = polygonCentroid(region.points)
    return inside
      .sort((a, b) => haversineKm(cLat, cLon, a.lat, a.lon) - haversineKm(cLat, cLon, b.lat, b.lon))
      .slice(0, 80)
      .map((b) => b.id)
  }, [scope, region, buoys, metric.stream])

  useEffect(() => {
    if (scope === 'region' && regionStations.length === 0) {
      setPoints([]); setMeta({ stationCount: 0, contributing: 0 }); return
    }
    let alive = true
    setLoading(true)
    setError(null)
    const req = scope === 'region'
      ? fetchResearchTrendStations(metric.stream, metric.field, regionStations, hours)
      : fetchResearchTrend(metric.stream, metric.field, hours)
    req
      .then((res) => { if (alive) { setPoints(res.points || []); setMeta(res) } })
      .catch((e) => { if (alive) setError(String(e)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [metric.key, hours, scope, regionStations.join(',')])

  const data = useMemo(() => (points || []).map((p) => ({
    ts: p.ts,
    mean: convert(p.mean, metric.unit, useMetric),
    band: [convert(p.min, metric.unit, useMetric), convert(p.max, metric.unit, useMetric)],
    count: p.count,
  })), [points, metric.unit, useMetric])

  const ulabel = unitLabel(metric.unit, useMetric)
  const peakCount = data.reduce((m, d) => Math.max(m, d.count), 0)
  const color = metric.color || '#3b82f6'
  const countLabel = scope === 'region'
    ? `${meta?.contributing ?? meta?.stationCount ?? '…'} buoys in selection`
    : `up to ${peakCount} buoys/hr`

  return (
    <div className="ops-section">
      <div className="ops-section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: color, marginRight: 6 }} />
          {metric.label} <span style={{ color: 'var(--color-text-dim)' }}>· {countLabel}</span>
        </span>
        <button onClick={onHide} title="Hide this metric"
          style={{ background: 'none', border: 'none', color: 'var(--color-text-dim)', cursor: 'pointer', fontSize: '0.9rem', lineHeight: 1 }}>✕</button>
      </div>
      <div className="chart-container">
        {loading && <div className="loading-veil" style={{ height: 180 }}>Loading…</div>}
        {error && <div className="loading-veil" style={{ height: 180, color: 'var(--color-error)' }}>{error}</div>}
        {!loading && !error && data.length === 0 && <div className="loading-veil" style={{ height: 180 }}>No data in this window</div>}
        {!loading && !error && data.length > 0 && (
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
              <XAxis dataKey="ts" tickFormatter={fmtTs}
                tick={{ fontSize: 9, fill: 'var(--color-text-dim)', fontFamily: 'var(--font-mono)' }}
                tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={40} />
              <YAxis tick={{ fontSize: 9, fill: 'var(--color-text-dim)', fontFamily: 'var(--font-mono)' }}
                tickLine={false} axisLine={false} width={40}
                label={{ value: ulabel, angle: -90, position: 'insideLeft', fontSize: 9, fill: 'var(--color-text-dim)' }} />
              <Tooltip
                contentStyle={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 4, fontSize: '0.6875rem', fontFamily: 'var(--font-mono)' }}
                labelFormatter={fmtTs}
                formatter={(val, name) => name === 'band'
                  ? [`${val[0]?.toFixed(1)}–${val[1]?.toFixed(1)} ${ulabel}`, 'min–max']
                  : [`${val?.toFixed(1)} ${ulabel}`, 'mean']} />
              <Area dataKey="band" stroke="none" fill={color} fillOpacity={0.15} isAnimationActive={false} />
              <Line dataKey="mean" stroke={color} strokeWidth={1.75} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}

// ── Correlation matrix ──────────────────────────────────────────────────────
function MatrixView({ metric, hours, buoys, onSelectBuoy }) {
  const candidates = useMemo(() => buoys.filter((b) => b.available?.includes(metric.stream)), [buoys, metric.stream])
  const [selected, setSelected] = useState([])
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    setSelected(candidates.slice(0, 6).map((b) => b.id))
    setResult(null)
  }, [metric.key]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id) => setSelected((cur) => cur.includes(id)
    ? cur.filter((x) => x !== id)
    : (cur.length >= 16 ? cur : [...cur, id]))

  const run = () => {
    if (selected.length < 2) return
    setLoading(true); setError(null)
    fetchResearchCorrelate(metric.stream, metric.field, selected, hours)
      .then(setResult).catch((e) => setError(String(e))).finally(() => setLoading(false))
  }

  const nameOf = (id) => candidates.find((b) => b.id === id)?.name || id
  const openBuoy = (id) => { const b = buoys.find((x) => x.id === id); if (b) onSelectBuoy(b) }

  return (
    <div className="ops-section">
      <div className="ops-section-title">Correlation — {metric.label} ({hours}h)</div>

      <div className="chart-container" style={{ marginBottom: '1rem' }}>
        <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-dim)', marginBottom: '0.5rem' }}>
          Selected buoys ({selected.length}/16) — pick 2+ that report this metric
        </div>
        <BuoyPicker candidates={candidates} selected={selected} onToggle={toggle} placeholder="Search buoys to add…" />
        <button className="btn btn-primary" style={{ marginTop: '0.75rem' }} onClick={run} disabled={selected.length < 2 || loading}>
          {loading ? 'Computing…' : 'Compute correlation'}
        </button>
      </div>

      {error && <div className="loading-veil" style={{ color: 'var(--color-error)' }}>{error}</div>}

      {result && result.stations?.length > 0 && (
        <div className="chart-container" style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontFamily: 'var(--font-mono)', fontSize: '0.625rem' }}>
            <thead>
              <tr>
                <th style={{ padding: '0.25rem 0.4rem' }}></th>
                {result.stations.map((id) => (
                  <th key={id} title={nameOf(id)} style={{ padding: '0.25rem 0.4rem', color: 'var(--color-text-dim)', writingMode: 'vertical-rl', transform: 'rotate(180deg)', whiteSpace: 'nowrap' }}>{id}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.stations.map((rowId, i) => (
                <tr key={rowId}>
                  <td title={`Open ${nameOf(rowId)}`} onClick={() => openBuoy(rowId)}
                    style={{ padding: '0.25rem 0.4rem', color: 'var(--color-text-dim)', whiteSpace: 'nowrap', textAlign: 'right', cursor: 'pointer' }}>{rowId}</td>
                  {result.stations.map((colId, j) => {
                    const r = result.matrix[i][j]
                    return (
                      <td key={colId} title={`${rowId} ↔ ${colId}: ${r == null ? 'n/a' : r}`}
                        style={{ padding: '0.3rem 0.4rem', textAlign: 'center', background: corrColor(r), color: 'var(--color-text-bright)', minWidth: 34 }}>
                        {r == null ? '—' : r.toFixed(2)}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <CorrLegend note="“—” = too few overlapping hours" />
        </div>
      )}
    </div>
  )
}

// ── Teleconnection finder ───────────────────────────────────────────────────
function TeleconnectionView({ metric, hours, buoys, onSelectBuoy, onShowMap }) {
  const candidates = useMemo(() => buoys.filter((b) => b.available?.includes(metric.stream)), [buoys, metric.stream])
  const [ref, setRef] = useState(null)
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => { setResult(null) }, [metric.key, hours])

  const toggleRef = (id) => setRef((cur) => (cur === id ? null : id))
  const openBuoy = (id) => { const b = buoys.find((x) => x.id === id); if (b) onSelectBuoy(b) }

  const run = () => {
    if (!ref) return
    setLoading(true); setError(null)
    fetchTeleconnections(ref, metric.stream, metric.field, hours)
      .then(setResult).catch((e) => setError(String(e))).finally(() => setLoading(false))
  }

  const results = result?.results || []
  const top = results.slice(0, 12)
  const bottom = results.filter((x) => x.r < 0).slice(-12).reverse()

  return (
    <div className="ops-section">
      <div className="ops-section-title">Teleconnections — {metric.label} ({hours}h)</div>

      <div className="chart-container" style={{ marginBottom: '1rem' }}>
        <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-dim)', marginBottom: '0.5rem' }}>
          Pick a reference buoy, then rank every buoy reporting this metric by correlation to it.
        </div>
        <BuoyPicker candidates={candidates} selected={ref ? [ref] : []} onToggle={toggleRef} single placeholder="Search reference buoy…" />
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={run} disabled={!ref || loading}>{loading ? 'Scanning…' : 'Compute'}</button>
          {result && results.length > 0 && (
            <button className="btn" onClick={() => onShowMap({ ref: result.ref, refName: result.refName, label: metric.label, results })}>Show on map</button>
          )}
        </div>
      </div>

      {error && <div className="loading-veil" style={{ color: 'var(--color-error)' }}>{error}</div>}

      {result && (
        results.length === 0 ? (
          <div className="chart-container"><div className="loading-veil" style={{ height: 120 }}>Not enough overlapping data to correlate.</div></div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1rem' }}>
            <RankList title="Most correlated (+)" rows={top} onOpen={openBuoy} />
            <RankList title="Most inverse (−)" rows={bottom} onOpen={openBuoy} emptyText="No inversely-correlated buoys." />
          </div>
        )
      )}
    </div>
  )
}

function RankList({ title, rows, onOpen, emptyText }) {
  return (
    <div className="chart-container">
      <div className="ops-section-title" style={{ marginBottom: '0.5rem' }}>{title}</div>
      {(!rows || rows.length === 0) && <div style={{ fontSize: '0.75rem', color: 'var(--color-text-dim)' }}>{emptyText || 'No results.'}</div>}
      {rows && rows.map((row) => (
        <button key={row.id} onClick={() => onOpen(row.id)}
          style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', padding: '0.35rem 0.4rem', background: 'none', border: 'none', borderBottom: '1px solid var(--color-border)', cursor: 'pointer', textAlign: 'left' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6875rem', color: 'var(--color-text-bright)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: corrColor(row.r), marginRight: 6, verticalAlign: 'middle' }} />
            {row.id} <span style={{ color: 'var(--color-text-dim)' }}>{row.name}</span>
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6875rem', color: 'var(--color-text-bright)', whiteSpace: 'nowrap' }}>
            {row.r > 0 ? '+' : ''}{row.r.toFixed(2)} <span style={{ color: 'var(--color-text-dim)' }}>· {row.overlap}h</span>
          </span>
        </button>
      ))}
    </div>
  )
}

// ── Propagation forecast ────────────────────────────────────────────────────
function buildPropagationPayload(result, metricLabel, buoys) {
  const tb = buoys.find((b) => b.id === result.target)
  return {
    targetId: result.target,
    targetName: result.targetName,
    label: metricLabel,
    target: tb ? { lat: tb.lat, lon: tb.lon } : null,
    leaders: (result.leaders || []).map((L) => ({ id: L.id, lat: L.lat, lon: L.lon, lagHours: L.lagHours, r: L.r })),
  }
}

function PropagationView({ metric, hours, maxLag, buoys, useMetric, onSelectBuoy, onShowMap, initialTarget }) {
  const candidates = useMemo(() => buoys.filter((b) => b.available?.includes(metric.stream)), [buoys, metric.stream])
  const [target, setTarget] = useState(initialTarget || null)
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => { setResult(null) }, [metric.key, hours, maxLag])

  const toggleTarget = (id) => setTarget((cur) => (cur === id ? null : id))
  const openBuoy = (id) => { const b = buoys.find((x) => x.id === id); if (b) onSelectBuoy(b) }

  const runFor = (id) => {
    if (!id) return
    setLoading(true); setError(null)
    fetchPropagation(id, metric.stream, metric.field, hours, maxLag)
      .then(setResult).catch((e) => setError(String(e))).finally(() => setLoading(false))
  }
  const run = () => runFor(target)

  // Arrived from a buoy's detail panel — preselect the target and compute once.
  const didAuto = useRef(false)
  useEffect(() => {
    if (initialTarget && !didAuto.current) {
      didAuto.current = true
      setTarget(initialTarget)
      runFor(initialTarget)
    }
  }, [initialTarget]) // eslint-disable-line react-hooks/exhaustive-deps

  const leaders = result?.leaders || []
  const ulabel = unitLabel(metric.unit, useMetric)
  const chartData = useMemo(() => {
    if (!result) return []
    const rows = []
    ;(result.observed || []).forEach((p) => rows.push({ ts: p.ts, observed: convert(p.value, metric.unit, useMetric) }))
    ;(result.forecast || []).forEach((p) => rows.push({ ts: p.ts, forecast: convert(p.value, metric.unit, useMetric) }))
    return rows.sort((a, b) => a.ts - b.ts)
  }, [result, metric.unit, useMetric])
  const nowTs = Math.floor(Date.now() / 1000)

  return (
    <div className="ops-section">
      <div className="ops-section-title">Propagation forecast — {metric.label} ({hours}h window · ±{maxLag}h lag)</div>

      <div className="chart-container" style={{ marginBottom: '1rem' }}>
        <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-dim)', marginBottom: '0.5rem' }}>
          Pick a target buoy. We find upstream buoys whose {metric.label.toLowerCase()} precedes it and forecast what's incoming.
        </div>
        <BuoyPicker candidates={candidates} selected={target ? [target] : []} onToggle={toggleTarget} single placeholder="Search target buoy…" />
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={run} disabled={!target || loading}>{loading ? 'Scanning…' : 'Compute'}</button>
          {result && leaders.length > 0 && (
            <button className="btn" onClick={() => onShowMap(buildPropagationPayload(result, metric.label, buoys))}>Show on map</button>
          )}
        </div>
      </div>

      {error && <div className="loading-veil" style={{ color: 'var(--color-error)' }}>{error}</div>}

      {result && (leaders.length === 0 ? (
        <div className="chart-container"><div className="loading-veil" style={{ height: 120 }}>No strong upstream leaders found within range. Try a longer window or another metric.</div></div>
      ) : (
        <>
          <div className="chart-container" style={{ marginBottom: '1rem' }}>
            <ResponsiveContainer width="100%" height={248}>
              <ComposedChart data={chartData} margin={{ top: 20, right: 8, left: -8, bottom: 0 }}>
                <XAxis dataKey="ts" tickFormatter={fmtTs} type="number" domain={['dataMin', 'dataMax']}
                  tick={{ fontSize: 9, fill: 'var(--color-text-dim)', fontFamily: 'var(--font-mono)' }}
                  tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={50} />
                <YAxis tick={{ fontSize: 9, fill: 'var(--color-text-dim)', fontFamily: 'var(--font-mono)' }}
                  tickLine={false} axisLine={false} width={40}
                  label={{ value: ulabel, angle: -90, position: 'insideLeft', fontSize: 9, fill: 'var(--color-text-dim)' }} />
                <Tooltip
                  contentStyle={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 4, fontSize: '0.6875rem', fontFamily: 'var(--font-mono)' }}
                  labelFormatter={fmtTs}
                  formatter={(val, name) => [`${val?.toFixed(1)} ${ulabel}`, name]} />
                <ReferenceLine x={nowTs} stroke="var(--color-amber)" strokeDasharray="3 3" label={{ value: 'now', fontSize: 9, fill: 'var(--color-amber)', position: 'top' }} />
                <Line dataKey="observed" name="observed" stroke="var(--color-text-bright)" strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
                <Line dataKey="forecast" name="forecast" stroke={metric.color} strokeWidth={1.75} strokeDasharray="5 4" dot={false} isAnimationActive={false} connectNulls />
              </ComposedChart>
            </ResponsiveContainer>
            <div style={{ fontSize: '0.625rem', color: 'var(--color-text-dim)', fontFamily: 'var(--font-mono)', marginTop: '0.5rem' }}>
              Solid = observed · dashed = forecast blended from upstream leaders
            </div>
          </div>

          <div className="chart-container">
            <div className="ops-section-title" style={{ marginBottom: '0.5rem' }}>Upstream leaders</div>
            {leaders.map((L) => (
              <button key={L.id} onClick={() => openBuoy(L.id)}
                style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', padding: '0.35rem 0.4rem', background: 'none', border: 'none', borderBottom: '1px solid var(--color-border)', cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6875rem', color: 'var(--color-text-bright)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: corrColor(L.r), marginRight: 6, verticalAlign: 'middle' }} />
                  {L.id} <span style={{ color: 'var(--color-text-dim)' }}>{L.name}</span>
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6875rem', color: 'var(--color-text-bright)', whiteSpace: 'nowrap' }}>
                  +{L.lagHours}h <span style={{ color: 'var(--color-text-dim)' }}>· r {L.r.toFixed(2)} · {L.distanceKm}km · {L.speedKmh}km/h</span>
                </span>
              </button>
            ))}
          </div>
        </>
      ))}
    </div>
  )
}

// ── Anomaly spotlight ───────────────────────────────────────────────────────
function AnomalyView({ metric, scope, region, buoys, useMetric, isNarrow, onSelectBuoy, onOpenMap }) {
  const hasPolygon = (region?.points?.length || 0) >= 3
  const regionStations = useMemo(() => {
    if (scope !== 'region' || !hasPolygon) return []
    return buoys.filter((b) => b.lat != null && b.lon != null
      && b.available?.includes(metric.stream)
      && pointInPolygon(b.lat, b.lon, region.points)).map((b) => b.id)
  }, [scope, hasPolygon, region, buoys, metric.stream])

  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const blockedRegion = scope === 'region' && (isNarrow || !hasPolygon)

  useEffect(() => {
    if (blockedRegion) { setResult(null); return }
    let alive = true
    setLoading(true); setError(null)
    fetchAnomalies(metric.stream, metric.field, scope, scope === 'region' ? regionStations : [], 25)
      .then((r) => { if (alive) setResult(r) })
      .catch((e) => { if (alive) setError(String(e)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [metric.key, scope, regionStations.join(','), blockedRegion])

  if (scope === 'region' && isNarrow) {
    return (
      <div className="ops-section"><div className="chart-container">
        <div className="loading-veil" style={{ height: 150, flexDirection: 'column', gap: '0.5rem', textAlign: 'center', padding: '1rem' }}>
          <div style={{ color: 'var(--color-text-bright)' }}>Region analysis is desktop-only</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--color-text-dim)' }}>Switch to <b style={{ color: 'var(--color-amber)' }}>Network</b>, or open on a desktop.</div>
        </div>
      </div></div>
    )
  }
  if (scope === 'region' && !hasPolygon) {
    return (
      <div className="ops-section"><div className="chart-container">
        <div className="loading-veil" style={{ height: 150, flexDirection: 'column', gap: '0.75rem' }}>
          <div>No region drawn yet.</div>
          <button className="btn btn-primary" onClick={onOpenMap}>Go to Map → lasso a region</button>
        </div>
      </div></div>
    )
  }

  const openBuoy = (id) => { const b = buoys.find((x) => x.id === id); if (b) onSelectBuoy(b) }
  const ulabel = unitLabel(metric.unit, useMetric)
  const anomalies = result?.anomalies || []
  const meanDisp = result?.mean != null ? convert(result.mean, metric.unit, useMetric) : null

  return (
    <div className="ops-section">
      <div className="ops-section-title">
        Anomalies — {metric.label} {scope === 'region' ? '(region)' : '(network)'}
        {result?.n ? <span style={{ color: 'var(--color-text-dim)' }}> · {result.n} buoys{meanDisp != null ? `, mean ${meanDisp.toFixed(1)} ${ulabel}` : ''}</span> : ''}
      </div>
      <div className="chart-container">
        {loading && <div className="loading-veil" style={{ height: 160 }}>Loading…</div>}
        {error && <div className="loading-veil" style={{ height: 160, color: 'var(--color-error)' }}>{error}</div>}
        {!loading && !error && anomalies.length === 0 && <div className="loading-veil" style={{ height: 160 }}>Not enough buoys reporting this metric.</div>}
        {!loading && !error && anomalies.map((a) => {
          const val = convert(a.value, metric.unit, useMetric)
          const high = a.direction === 'high'
          return (
            <button key={a.id} onClick={() => openBuoy(a.id)}
              style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', padding: '0.4rem', background: 'none', border: 'none', borderBottom: '1px solid var(--color-border)', cursor: 'pointer', textAlign: 'left' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6875rem', color: 'var(--color-text-bright)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {a.id} <span style={{ color: 'var(--color-text-dim)' }}>{a.name}</span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', whiteSpace: 'nowrap' }}>
                <span className="mono" style={{ fontSize: '0.6875rem', color: 'var(--color-text-bright)' }}>{val?.toFixed(1)} {ulabel}</span>
                <span className="mono" style={{ fontSize: '0.625rem', padding: '0.1rem 0.4rem', borderRadius: 10, color: high ? '#ef6a4b' : '#3b82f6', border: `1px solid ${high ? '#ef6a4b' : '#3b82f6'}` }}>
                  {a.z > 0 ? '+' : ''}{a.z}σ {high ? '▲' : '▼'}
                </span>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function CorrLegend({ note }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', marginTop: '0.75rem', fontSize: '0.625rem', color: 'var(--color-text-dim)', fontFamily: 'var(--font-mono)' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 12, background: corrColor(1), display: 'inline-block', borderRadius: 2 }} /> +1 move together</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 12, background: corrColor(0), display: 'inline-block', borderRadius: 2 }} /> 0 unrelated</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 12, background: corrColor(-1), display: 'inline-block', borderRadius: 2 }} /> −1 inverse</span>
      {note && <span>· {note}</span>}
    </div>
  )
}
