import React, { useState, useMemo, useEffect } from 'react'
import {
  ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts'
import { fetchResearchTrend, fetchResearchTrendStations, fetchResearchCorrelate } from '../api'
import { pointInPolygon, polygonCentroid, haversineKm } from '../geo'

// Metrics shared across many buoys (stream + field), with their SI unit family.
const METRICS = [
  { key: 'standard:waterTemperature', stream: 'standard', field: 'waterTemperature', label: 'Water Temp', unit: 'temp' },
  { key: 'standard:airTemperature', stream: 'standard', field: 'airTemperature', label: 'Air Temp', unit: 'temp' },
  { key: 'standard:windSpeed', stream: 'standard', field: 'windSpeed', label: 'Wind Speed', unit: 'wind' },
  { key: 'standard:gustSpeed', stream: 'standard', field: 'gustSpeed', label: 'Gust Speed', unit: 'wind' },
  { key: 'standard:waveHeight', stream: 'standard', field: 'waveHeight', label: 'Wave Height', unit: 'wave' },
  { key: 'standard:pressure', stream: 'standard', field: 'pressure', label: 'Pressure', unit: 'pressure' },
  { key: 'spec:waveHeight', stream: 'spec', field: 'waveHeight', label: 'Wave Height (spectral)', unit: 'wave' },
  { key: 'spec:swellHeight', stream: 'spec', field: 'swellHeight', label: 'Swell Height', unit: 'wave' },
  { key: 'srad:solarRadiation', stream: 'srad', field: 'solarRadiation', label: 'Solar Radiation', unit: '' },
  { key: 'ocean:waterTemperature', stream: 'ocean', field: 'waterTemperature', label: 'Ocean Temp', unit: 'temp' },
]

const WINDOWS = [
  { label: '24h', hours: 24 },
  { label: '3d', hours: 72 },
  { label: '5d', hours: 120 },
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

// Two-sided correlation color: green for positive, red for negative, by magnitude.
function corrColor(r) {
  if (r == null) return 'rgba(255,255,255,0.04)'
  const m = Math.abs(r)
  const c = r >= 0 ? '34,197,94' : '239,68,68'
  return `rgba(${c},${(0.12 + 0.6 * m).toFixed(3)})`
}

const selectStyle = {
  background: 'var(--color-bg)', border: '1px solid var(--color-border)',
  borderRadius: 4, color: 'var(--color-text)', fontSize: '0.8125rem',
  padding: '0.375rem 0.5rem', fontFamily: 'var(--font-body)', outline: 'none',
}

export default function Research({ buoys, useMetric, researchRegion, scope, onScopeChange, onOpenMap }) {
  const [mode, setMode] = useState('trend')
  const [metricKey, setMetricKey] = useState(METRICS[0].key)
  const [hours, setHours] = useState(120)
  const metric = METRICS.find((m) => m.key === metricKey) || METRICS[0]

  return (
    <div className="ops-page">
      {/* Controls */}
      <div className="ops-section" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' }}>
        <div style={{ display: 'flex', border: '1px solid var(--color-border)', borderRadius: 4, overflow: 'hidden' }}>
          {[['trend', 'Network Trend'], ['matrix', 'Correlation Matrix']].map(([m, label]) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className="btn"
              style={{
                border: 'none', borderRadius: 0,
                background: mode === m ? 'var(--color-amber-dim)' : 'transparent',
                color: mode === m ? 'var(--color-amber)' : 'var(--color-text-dim)',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <select value={metricKey} onChange={(e) => setMetricKey(e.target.value)} style={selectStyle}>
          {METRICS.map((m) => (
            <option key={m.key} value={m.key}>{m.label}</option>
          ))}
        </select>

        <div style={{ display: 'flex', gap: '0.25rem' }}>
          {WINDOWS.map((w) => (
            <button
              key={w.hours}
              onClick={() => setHours(w.hours)}
              className={`btn${hours === w.hours ? ' btn-amber' : ''}`}
              style={{ padding: '0.375rem 0.625rem' }}
            >
              {w.label}
            </button>
          ))}
        </div>

        {mode === 'trend' && (
          <div style={{ display: 'flex', border: '1px solid var(--color-border)', borderRadius: 4, overflow: 'hidden' }}>
            {[['network', 'Network'], ['region', 'Region']].map(([s, label]) => (
              <button
                key={s}
                onClick={() => onScopeChange(s)}
                className="btn"
                style={{
                  border: 'none', borderRadius: 0,
                  background: scope === s ? 'var(--color-amber-dim)' : 'transparent',
                  color: scope === s ? 'var(--color-amber)' : 'var(--color-text-dim)',
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {mode === 'trend'
        ? <TrendView metric={metric} hours={hours} useMetric={useMetric} scope={scope} region={researchRegion} buoys={buoys} onOpenMap={onOpenMap} />
        : <MatrixView metric={metric} hours={hours} buoys={buoys} />}
    </div>
  )
}

function TrendView({ metric, hours, useMetric, scope, region, buoys, onOpenMap }) {
  const [points, setPoints] = useState(null)
  const [meta, setMeta] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const hasPolygon = (region?.points?.length || 0) >= 3
  const noRegion = scope === 'region' && !hasPolygon

  // Buoys inside the drawn polygon that report this metric (nearest-centroid first, capped).
  const regionStations = useMemo(() => {
    if (scope !== 'region' || !hasPolygon) return []
    const inside = buoys.filter((b) => b.lat != null && b.lon != null
      && b.available?.includes(metric.stream)
      && pointInPolygon(b.lat, b.lon, region.points))
    if (inside.length <= 80) return inside.map((b) => b.id)
    const [cLat, cLon] = polygonCentroid(region.points)
    return inside
      .sort((a, b) => haversineKm(cLat, cLon, a.lat, a.lon) - haversineKm(cLat, cLon, b.lat, b.lon))
      .slice(0, 80)
      .map((b) => b.id)
  }, [scope, hasPolygon, region, buoys, metric.stream])

  useEffect(() => {
    if (noRegion) { setPoints(null); setMeta(null); return }
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

  const title = scope === 'region'
    ? `Region ${metric.label} — ${meta?.contributing ?? meta?.stationCount ?? '…'} buoys in selection (${hours}h)`
    : `Network ${metric.label} — mean & min/max band (${hours}h)`

  if (noRegion) {
    return (
      <div className="ops-section">
        <div className="chart-container">
          <div className="loading-veil" style={{ height: 200, flexDirection: 'column', gap: '0.75rem' }}>
            <div>No region drawn yet.</div>
            <button className="btn btn-primary" onClick={onOpenMap}>Go to Map → lasso a region</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="ops-section">
      <div className="ops-section-title">{title}</div>
      <div className="chart-container">
        {loading && <div className="loading-veil" style={{ height: 240 }}>Loading…</div>}
        {error && <div className="loading-veil" style={{ height: 240, color: 'var(--color-error)' }}>{error}</div>}
        {!loading && !error && data.length === 0 && (
          <div className="loading-veil" style={{ height: 240 }}>No data in this window yet</div>
        )}
        {!loading && !error && data.length > 0 && (
          <>
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                <XAxis
                  dataKey="ts" tickFormatter={fmtTs}
                  tick={{ fontSize: 9, fill: 'var(--color-text-dim)', fontFamily: 'var(--font-mono)' }}
                  tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={40}
                />
                <YAxis
                  tick={{ fontSize: 9, fill: 'var(--color-text-dim)', fontFamily: 'var(--font-mono)' }}
                  tickLine={false} axisLine={false} width={40}
                  label={{ value: ulabel, angle: -90, position: 'insideLeft', fontSize: 9, fill: 'var(--color-text-dim)' }}
                />
                <Tooltip
                  contentStyle={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 4, fontSize: '0.6875rem', fontFamily: 'var(--font-mono)' }}
                  labelFormatter={fmtTs}
                  formatter={(val, name) => {
                    if (name === 'band') return [`${val[0]?.toFixed(1)}–${val[1]?.toFixed(1)} ${ulabel}`, 'min–max']
                    return [`${val?.toFixed(1)} ${ulabel}`, 'mean']
                  }}
                />
                <Area dataKey="band" stroke="none" fill="#3b82f6" fillOpacity={0.15} isAnimationActive={false} />
                <Line dataKey="mean" stroke="#3b82f6" strokeWidth={1.75} dot={false} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
            <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-dim)', fontFamily: 'var(--font-mono)', marginTop: '0.5rem' }}>
              Up to {peakCount} buoys per hour · band shows the spread
              {scope === 'region' && meta?.capped ? ` · nearest ${meta.stationCount} of ${meta.requested} reporting buoys` : ''}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function MatrixView({ metric, hours, buoys }) {
  const candidates = useMemo(
    () => buoys.filter((b) => b.available?.includes(metric.stream)),
    [buoys, metric.stream]
  )
  const [selected, setSelected] = useState([])
  const [search, setSearch] = useState('')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // Seed a default selection whenever the metric's candidate set changes.
  useEffect(() => {
    setSelected(candidates.slice(0, 6).map((b) => b.id))
    setResult(null)
  }, [metric.key]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id) => {
    setSelected((cur) => cur.includes(id)
      ? cur.filter((x) => x !== id)
      : (cur.length >= 16 ? cur : [...cur, id]))
  }

  const matches = useMemo(() => {
    const q = search.toLowerCase().trim()
    return candidates
      .filter((b) => !q || b.id.toLowerCase().includes(q) || (b.name || '').toLowerCase().includes(q))
      .slice(0, 30)
  }, [candidates, search])

  const run = () => {
    if (selected.length < 2) return
    setLoading(true)
    setError(null)
    fetchResearchCorrelate(metric.stream, metric.field, selected, hours)
      .then(setResult)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }

  const nameOf = (id) => candidates.find((b) => b.id === id)?.name || id

  return (
    <div className="ops-section">
      <div className="ops-section-title">Correlation — {metric.label} ({hours}h)</div>

      {/* Selection */}
      <div className="chart-container" style={{ marginBottom: '1rem' }}>
        <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-dim)', marginBottom: '0.5rem' }}>
          Selected buoys ({selected.length}/16) — pick 2+ that report this metric
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginBottom: '0.625rem' }}>
          {selected.length === 0 && <span style={{ fontSize: '0.75rem', color: 'var(--color-text-dim)' }}>None selected</span>}
          {selected.map((id) => (
            <button key={id} onClick={() => toggle(id)} className="mono"
              style={{ fontSize: '0.6875rem', padding: '0.2rem 0.45rem', background: 'var(--color-amber-dim)', border: '1px solid var(--color-amber)', borderRadius: 12, color: 'var(--color-amber)', cursor: 'pointer' }}>
              {id} ×
            </button>
          ))}
        </div>
        <input
          className="input" placeholder="Search buoys to add…"
          value={search} onChange={(e) => setSearch(e.target.value)}
          style={{ marginBottom: '0.5rem' }}
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', maxHeight: 120, overflowY: 'auto' }}>
          {candidates.length === 0 && (
            <span style={{ fontSize: '0.75rem', color: 'var(--color-text-dim)' }}>No buoys report this metric yet.</span>
          )}
          {matches.map((b) => {
            const on = selected.includes(b.id)
            return (
              <button key={b.id} onClick={() => toggle(b.id)} className="mono"
                style={{ fontSize: '0.6875rem', padding: '0.2rem 0.45rem', background: on ? 'var(--color-surface-2)' : 'transparent', border: '1px solid var(--color-border)', borderRadius: 12, color: on ? 'var(--color-text-bright)' : 'var(--color-text-dim)', cursor: 'pointer' }}
                title={b.name || b.id}>
                {on ? '✓ ' : '+ '}{b.id}
              </button>
            )
          })}
        </div>
        <button className="btn btn-primary" style={{ marginTop: '0.75rem' }} onClick={run} disabled={selected.length < 2 || loading}>
          {loading ? 'Computing…' : 'Compute correlation'}
        </button>
      </div>

      {error && <div className="loading-veil" style={{ color: 'var(--color-error)' }}>{error}</div>}

      {/* Heatmap */}
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
                  <td title={nameOf(rowId)} style={{ padding: '0.25rem 0.4rem', color: 'var(--color-text-dim)', whiteSpace: 'nowrap', textAlign: 'right' }}>{rowId}</td>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.75rem', fontSize: '0.625rem', color: 'var(--color-text-dim)', fontFamily: 'var(--font-mono)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 12, background: corrColor(1), display: 'inline-block', borderRadius: 2 }} /> +1 move together</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 12, background: corrColor(0), display: 'inline-block', borderRadius: 2 }} /> 0 unrelated</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 12, background: corrColor(-1), display: 'inline-block', borderRadius: 2 }} /> −1 inverse</span>
            <span>· “—” = too few overlapping hours</span>
          </div>
        </div>
      )}
    </div>
  )
}
