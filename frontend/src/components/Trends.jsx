import React, { useState, useEffect, useRef } from 'react'
import { fetchHighlights, units } from '../api'

// The Trends tab: a digest of what's notable across the network right now,
// computed server-side (service.get_highlights) and kept warm in its cache.
// Every list ranks buoys; clicking one opens it on the map.

const WINDOWS = [
  { label: '24h', hours: 24, ago: '24h ago' },
  { label: '3d', hours: 72, ago: '3 days ago' },
  { label: '7d', hours: 168, ago: '7 days ago' },
]

const PULSE = {
  waterTemperature: { label: 'Water temp', unit: 'temp' },
  airTemperature: { label: 'Air temp', unit: 'temp' },
  windSpeed: { label: 'Wind', unit: 'wind' },
  waveHeight: { label: 'Waves', unit: 'wave' },
  pressure: { label: 'Pressure', unit: 'pressure' },
}

const UP = '#ef6a4b'   // warm / rising
const DOWN = '#3b82f6' // cool / falling

// kind: 'delta' → value is a change over the window; 'now' → a current reading;
// 'spread' → a standard deviation; 'gap' → a signed difference between two readings.
const SECTIONS = [
  { key: 'warming', title: 'Fastest warming water', unit: 'temp', color: UP, kind: 'delta',
    blurb: 'Steepest upward water-temperature trend over the window.' },
  { key: 'cooling', title: 'Fastest cooling water', unit: 'temp', color: DOWN, kind: 'delta',
    blurb: 'Steepest downward water-temperature trend — cold fronts, upwelling, lake turnover.' },
  { key: 'pressureFalling', title: 'Pressure falling', unit: 'pressure', color: '#a855f7', kind: 'delta',
    blurb: 'Steepest barometric drops. A falling glass usually means weather is on its way.' },
  { key: 'pressureRising', title: 'Pressure rising', unit: 'pressure', color: '#8b5cf6', kind: 'delta',
    blurb: 'Steepest barometric rises — clearing behind a front, or a building high.' },
  { key: 'seasBuilding', title: 'Seas building', unit: 'wave', color: '#6366f1', kind: 'delta',
    blurb: 'Largest upward trend in wave height over the window.' },
  { key: 'biggestSeas', title: 'Biggest seas right now', unit: 'wave', color: '#3b82f6', kind: 'now',
    blurb: 'Highest current significant wave height.', extra: (r, f) => r.peak != null ? `peak ${f(r.peak)}` : null },
  { key: 'windiest', title: 'Strongest wind right now', unit: 'wind', color: '#14b8a6', kind: 'now',
    blurb: 'Highest current sustained wind speed.', extra: (r, f) => r.gust != null ? `gust ${f(r.gust)}` : null },
  { key: 'volatileWater', title: 'Most volatile water temp', unit: 'temp', color: '#fb7185', kind: 'spread',
    blurb: 'Largest hour-to-hour swings in water temperature — tidal fronts, mixing, sensors near the surface.',
    extra: (r, f) => r.range != null ? `range ${f(r.range, true)}` : null },
  { key: 'airSeaGap', title: 'Largest air–sea temperature gap', unit: 'temp', color: '#f59e0b', kind: 'gap',
    blurb: 'Air minus water. Warm air over cold water breeds fog; cold air over warm water breeds squalls.',
    extra: (r, f) => `air ${f(r.air)} · water ${f(r.water)}` },
]

function timeAgo(ts) {
  if (!ts) return ''
  const m = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60))
  if (m < 60) return `${m} min ago`
  const h = m / 60
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)} h ago`
  return `${(h / 24).toFixed(1)} days ago`
}

// Many NOS tide stations are named "9461710 - Atka, AK"; the number is noise here.
function displayName(row) {
  const n = (row.name || '').replace(/^\d{6,8}\s*-\s*/, '').trim()
  return n || row.id
}

function fmtNum(v, digits) {
  if (v == null || Number.isNaN(v)) return '—'
  return v.toFixed(digits)
}

// Pressure in inHg needs two decimals to show any movement at all.
function digitsFor(unit, useMetric) {
  return unit === 'pressure' && !useMetric ? 2 : 1
}

// Tiny inline-SVG sparkline; series is [[ts, value], …] oldest-first.
function MiniSpark({ series, color, width = 84, height = 26 }) {
  if (!series || series.length < 2) return <svg width={width} height={height} />
  const xs = series.map((p) => p[0])
  const ys = series.map((p) => p[1])
  const x0 = xs[0], x1 = xs[xs.length - 1]
  const yMin = Math.min(...ys), yMax = Math.max(...ys)
  const spanX = x1 - x0 || 1
  const spanY = yMax - yMin || 1
  const pts = series.map(([t, v]) => {
    const x = 1 + ((t - x0) / spanX) * (width - 2)
    const y = height - 2 - ((v - yMin) / spanY) * (height - 4)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  return (
    <svg width={width} height={height} style={{ flexShrink: 0, display: 'block' }} aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" opacity={0.9} />
    </svg>
  )
}

function PulseCard({ entry, hours, useMetric }) {
  const meta = PULSE[entry.field]
  if (!meta) return null
  const ul = units.unitLabel(meta.unit, useMetric)
  const d = digitsFor(meta.unit, useMetric)
  const now = units.convert(entry.now, meta.unit, useMetric)
  const delta = units.convertDelta(entry.delta, meta.unit, useMetric)
  const dir = delta == null ? 0 : delta > 0 ? 1 : delta < 0 ? -1 : 0
  const ago = WINDOWS.find((w) => w.hours === hours)?.ago || `${hours}h ago`
  return (
    <div className="stat-card">
      <div className="label">{meta.label}</div>
      <div className="value" style={{ fontSize: '1.25rem' }}>
        {fmtNum(now, d)} <span style={{ fontSize: '0.75rem', color: 'var(--color-text-dim)' }}>{ul}</span>
      </div>
      <div className="mono" style={{ marginTop: '0.4rem', fontSize: '0.6875rem', color: dir > 0 ? UP : dir < 0 ? DOWN : 'var(--color-text-dim)' }}>
        {delta == null ? 'no trend data'
          : <>{dir > 0 ? '▲' : dir < 0 ? '▼' : '•'} {delta > 0 ? '+' : ''}{fmtNum(delta, d)} {ul} <span style={{ color: 'var(--color-text-dim)' }}>vs {ago}</span></>}
      </div>
      {entry.buoys > 0 && (
        <div style={{ fontSize: '0.625rem', color: 'var(--color-text-dim)', marginTop: '0.2rem' }}>
          network mean · {entry.buoys.toLocaleString()} readings/hr
        </div>
      )}
    </div>
  )
}

function Row({ rank, row, section, useMetric, onOpen }) {
  const ul = units.unitLabel(section.unit, useMetric)
  const d = digitsFor(section.unit, useMetric)
  const isChange = section.kind === 'delta' || section.kind === 'gap' || section.kind === 'spread'
  const v = isChange
    ? units.convertDelta(row.value, section.unit, useMetric)
    : units.convert(row.value, section.unit, useMetric)
  const signed = section.kind === 'delta' || section.kind === 'gap'
  const color = section.kind === 'gap' ? (row.value >= 0 ? UP : DOWN) : section.color
  const fmtAbs = (x, asDelta = false) =>
    `${fmtNum(asDelta ? units.convertDelta(x, section.unit, useMetric) : units.convert(x, section.unit, useMetric), d)} ${ul}`
  const extra = section.extra ? section.extra(row, fmtAbs) : null
  const latest = row.latest != null ? units.convert(row.latest, section.unit, useMetric) : null

  return (
    <button onClick={() => onOpen(row.id)} title={`Open ${row.id} on the map`}
      style={{ display: 'block', width: '100%', padding: '0.5rem 0.25rem', background: 'none', border: 'none', borderBottom: '1px solid var(--color-border)', cursor: 'pointer', textAlign: 'left', color: 'inherit' }}>
      {/* Line 1: rank + full station name — the location is the point of the list */}
      <span style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
        <span className="mono" style={{ width: 14, fontSize: '0.625rem', color: 'var(--color-text-dim)', flexShrink: 0 }}>{rank}</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: '0.8125rem', color: 'var(--color-text-bright)', lineHeight: 1.3, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
          {displayName(row)}
        </span>
      </span>
      {/* Line 2: id + details, sparkline, value chip */}
      <span style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginTop: 4, paddingLeft: 22 }}>
        <span className="mono" style={{ flex: 1, minWidth: 0, fontSize: '0.625rem', color: 'var(--color-text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span style={{ color: 'var(--color-text)' }}>{row.id}</span>
          {section.kind !== 'now' && latest != null && <> · now {fmtNum(latest, d)} {ul}</>}
          {extra && <> · {extra}</>}
          {section.kind === 'delta' && row.spanHours != null && <> · {row.n} pts / {Math.round(row.spanHours)}h</>}
        </span>
        <MiniSpark series={row.series} color={color} />
        <span className="mono" style={{ fontSize: '0.75rem', padding: '0.15rem 0.5rem', borderRadius: 10, whiteSpace: 'nowrap', color, border: `1px solid ${color}`, flexShrink: 0 }}>
          {signed && v > 0 ? '+' : ''}{fmtNum(v, d)} {ul}
          {section.kind === 'delta' && (v > 0 ? ' ▲' : ' ▼')}
        </span>
      </span>
    </button>
  )
}

function Section({ section, rows, useMetric, onOpen }) {
  return (
    <div className="chart-container" style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div className="ops-section-title" style={{ marginBottom: '0.15rem', color: 'var(--color-text)' }}>
        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: section.color, marginRight: 6 }} />
        {section.title}
      </div>
      <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-dim)', marginBottom: '0.5rem', lineHeight: 1.4 }}>{section.blurb}</div>
      {(!rows || rows.length === 0) && (
        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-dim)', padding: '0.5rem 0' }}>Nothing stands out in this window.</div>
      )}
      {rows && rows.map((row, i) => (
        <Row key={row.id} rank={i + 1} row={row} section={section} useMetric={useMetric} onOpen={onOpen} />
      ))}
    </div>
  )
}

function QuietSection({ rows, hours, onOpen }) {
  return (
    <div className="chart-container" style={{ minWidth: 0 }}>
      <div className="ops-section-title" style={{ marginBottom: '0.15rem', color: 'var(--color-text)' }}>
        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: 'var(--color-text-dim)', marginRight: 6 }} />
        Went quiet
      </div>
      <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-dim)', marginBottom: '0.5rem', lineHeight: 1.4 }}>
        Stations that stopped reporting within the last {hours}h after being live. Most recent silence first.
      </div>
      {(!rows || rows.length === 0) && (
        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-dim)', padding: '0.5rem 0' }}>No station went quiet in this window.</div>
      )}
      {rows && rows.map((row) => (
        <button key={row.id} onClick={() => onOpen(row.id)} title={`Open ${row.id} on the map`}
          style={{ display: 'block', width: '100%', padding: '0.5rem 0.25rem', background: 'none', border: 'none', borderBottom: '1px solid var(--color-border)', cursor: 'pointer', textAlign: 'left', color: 'inherit' }}>
          <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-bright)', lineHeight: 1.3, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
            {displayName(row)}
          </span>
          <span className="mono" style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', marginTop: 3, fontSize: '0.625rem', color: 'var(--color-text-dim)' }}>
            <span style={{ color: 'var(--color-text)' }}>{row.id}</span>
            <span style={{ whiteSpace: 'nowrap' }}>last seen {timeAgo(row.lastSeen)}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

export default function Trends({ buoys, useMetric, onSelectBuoy }) {
  const [hours, setHours] = useState(72)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [slow, setSlow] = useState(false)
  // Per-window results, so flipping between windows is instant after first load.
  const byWindow = useRef({})

  useEffect(() => {
    if (byWindow.current[hours]) { setData(byWindow.current[hours]); setError(null); return }
    let alive = true
    setLoading(true); setError(null); setSlow(false)
    // The server keeps this warm; the only slow case is right after a backend restart.
    const slowTimer = setTimeout(() => { if (alive) setSlow(true) }, 3000)
    fetchHighlights(hours)
      .then((r) => { if (alive) { byWindow.current[hours] = r; setData(r) } })
      .catch((e) => { if (alive) setError(String(e)) })
      .finally(() => { clearTimeout(slowTimer); if (alive) setLoading(false) })
    return () => { alive = false; clearTimeout(slowTimer) }
  }, [hours])

  const openBuoy = (id) => {
    const b = buoys.find((x) => x.id === id)
    if (b) onSelectBuoy(b)
  }

  const win = WINDOWS.find((w) => w.hours === hours)
  const sections = data?.sections || {}

  return (
    <div className="ops-page">
      <div className="ops-section" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: '0.9375rem', color: 'var(--color-text-bright)', fontFamily: 'var(--font-display)' }}>Interesting trends</div>
          <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-dim)', marginTop: 2 }}>
            What stands out across the network over the last {win?.label}
            {data && <> · {data.stationsWithTrend.toLocaleString()} of {data.stationsScanned.toLocaleString()} stations dense enough to trend · updated {timeAgo(data.generatedAt)}</>}
          </div>
        </div>
        <div className="header-spacer" style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: '0.25rem' }}>
          {WINDOWS.map((w) => (
            <button key={w.hours} onClick={() => setHours(w.hours)}
              className={`btn${hours === w.hours ? ' btn-amber' : ''}`} style={{ padding: '0.375rem 0.625rem' }}>
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="ops-section"><div className="chart-container">
          <div className="loading-veil" style={{ height: 160, flexDirection: 'column', gap: '0.4rem' }}>
            <div>Loading trends…</div>
            {slow && <div style={{ fontSize: '0.75rem' }}>Scanning every station's recent history — this takes a moment right after a restart.</div>}
          </div>
        </div></div>
      )}
      {error && (
        <div className="ops-section"><div className="chart-container">
          <div className="loading-veil" style={{ height: 120, color: 'var(--color-error)' }}>{error}</div>
        </div></div>
      )}

      {!loading && !error && data && (
        <>
          <div className="ops-section">
            <div className="ops-section-title">Network pulse</div>
            <div className="stat-cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: 0 }}>
              {(data.pulse || []).map((p) => <PulseCard key={p.field} entry={p} hours={hours} useMetric={useMetric} />)}
            </div>
          </div>

          <div className="ops-section">
            <div className="ops-section-title">Station highlights — tap a row to open it on the map</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(360px, 100%), 1fr))', gap: '1rem' }}>
              {SECTIONS.map((s) => (
                <Section key={s.key} section={s} rows={sections[s.key]} useMetric={useMetric} onOpen={openBuoy} />
              ))}
              <QuietSection rows={sections.wentQuiet} hours={hours} onOpen={openBuoy} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
