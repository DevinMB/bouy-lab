import React, { useEffect, useState } from 'react'
import { fetchBuoyDetail, fetchSeries, units as U } from '../api'
import { thermalColor, onThermalText } from '../thermal'
import Sparkline from './Sparkline'

const STREAM_FIELDS = {
  standard: { field: 'waterTemperature', label: 'Water Temp', unit: 'temp' },
  ocean: { field: 'waterTemperature', label: 'Subsurface Temp', unit: 'temp' },
  spec: { field: 'waveHeight', label: 'Wave Ht', unit: 'wave' },
  srad: { field: 'solarRadiation', label: 'Solar Rad', unit: '' },
}

// Series come from the API in SI units (°C, m). Convert for display.
function convertSeries(v, unit, useMetric) {
  if (v == null) return null
  if (useMetric) return v
  switch (unit) {
    case 'temp': return v * 9 / 5 + 32
    case 'wave': return v * 3.28084
    default: return v
  }
}

function seriesUnitLabel(unit, useMetric) {
  switch (unit) {
    case 'temp': return useMetric ? '°C' : '°F'
    case 'wave': return useMetric ? 'm' : 'ft'
    default: return ''
  }
}

// Format an ISO timestamp into a local time string + relative age.
function formatObserved(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  const ageMs = Date.now() - d.getTime()
  const ageMin = ageMs / 60000
  let ago
  if (ageMin < 60) ago = `${Math.max(1, Math.round(ageMin))} min ago`
  else if (ageMin < 60 * 48) ago = `${Math.round(ageMin / 60)} h ago`
  else ago = `${Math.round(ageMin / 1440)} d ago`
  const local = d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
  return { local, ago, stale: ageMin > 24 * 60 }
}

export default function DetailPanel({ buoy, useMetric, onClose, onNearbyRequest }) {
  const [detail, setDetail] = useState(null)
  const [seriesData, setSeriesData] = useState({})
  const [loadingSeries, setLoadingSeries] = useState(false)
  const [copied, setCopied] = useState(false)

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

  if (!buoy) return null

  const wtc = buoy.latest?.waterTempC
  const bgColor = thermalColor(wtc)
  const textColor = onThermalText(wtc)
  const std = detail?.streams?.standard?.values || {}
  const observed = formatObserved(detail?.latest?.observedAt || buoy.latest?.observedAt)
  const ownerName = detail?.owner || buoy.owner
  const stationType = detail?.ttype || detail?.type || buoy.type

  return (
    <div className="detail-panel" style={{
      position: 'absolute', top: 0, right: 0, width: 340, height: '100%',
      background: 'var(--color-bg-3)', borderLeft: '1px solid var(--color-border)',
      display: 'flex', flexDirection: 'column', zIndex: 500, overflowY: 'auto',
    }}>
      {/* Header */}
      <div style={{ padding: '0.875rem 1rem', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="mono" style={{ fontSize: '0.75rem', color: 'var(--color-text-dim)' }}>{buoy.id}</div>
          <div style={{ fontSize: '0.875rem', color: 'var(--color-text-bright)', fontWeight: 500, marginTop: 2, lineHeight: 1.3 }}>{buoy.name || buoy.id}</div>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--color-text-dim)', cursor: 'pointer', fontSize: '1.125rem', padding: '0 0.25rem', flex: 'none' }}>×</button>
      </div>

      {/* Water temp gauge + observation time */}
      <div style={{ padding: '1rem', borderBottom: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.625rem' }}>
        <div style={{
          width: 100, height: 100, borderRadius: '50%',
          background: bgColor,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          boxShadow: `0 0 20px ${bgColor}55`,
        }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1.375rem', color: textColor, lineHeight: 1 }}>
            {wtc != null ? U.formatTemp(wtc, useMetric).split(' ')[0] : '—'}
          </div>
          <div style={{ fontSize: '0.625rem', color: textColor, opacity: 0.8, marginTop: 2 }}>
            {wtc != null ? (useMetric ? '°C' : '°F') : ''} WATER
          </div>
        </div>
        <div style={{ textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: '0.6875rem', lineHeight: 1.5 }}>
          {observed ? (
            <>
              <span style={{ color: 'var(--color-text-dim)' }}>OBSERVED </span>
              <span style={{ color: observed.stale ? 'var(--color-text-dim)' : 'var(--color-text-bright)' }}>{observed.local}</span>
              <span style={{ color: observed.stale ? 'var(--color-error)' : 'var(--color-green)' }}> · {observed.ago}</span>
            </>
          ) : (
            <span style={{ color: 'var(--color-text-dim)' }}>No recent observation</span>
          )}
        </div>
      </div>

      {/* Owner / station type */}
      {(ownerName || stationType) && (
        <div style={{ padding: '0.625rem 1rem', borderBottom: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
          {ownerName && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6875rem' }}>
              <span style={{ color: 'var(--color-text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Owner</span>
              <span style={{ color: 'var(--color-text-bright)', textAlign: 'right', maxWidth: '70%' }}>{ownerName}</span>
            </div>
          )}
          {stationType && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6875rem' }}>
              <span style={{ color: 'var(--color-text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Type</span>
              <span style={{ color: 'var(--color-text-bright)', textAlign: 'right', maxWidth: '70%' }}>{stationType}</span>
            </div>
          )}
        </div>
      )}

      {/* Readings grid */}
      <div style={{ padding: '0.875rem 1rem', borderBottom: '1px solid var(--color-border)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
          {[
            { label: 'Wind', value: U.formatWind(std.windSpeed, useMetric) },
            { label: 'Gust', value: U.formatWind(std.gustSpeed, useMetric) },
            { label: 'Wave Ht', value: U.formatWave(buoy.latest?.waveHeight, useMetric) },
            { label: 'Pressure', value: U.formatPressure(buoy.latest?.pressure, useMetric) },
            { label: 'Air Temp', value: U.formatTemp(std.airTemperature, useMetric) },
            { label: 'Dew Point', value: U.formatTemp(std.dewPoint, useMetric) },
          ].map(({ label, value }) => (
            <div key={label} style={{ background: 'var(--color-bg-4)', border: '1px solid var(--color-border)', borderRadius: 4, padding: '0.5rem 0.625rem' }}>
              <div style={{ fontSize: '0.625rem', color: 'var(--color-text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
              <div className="mono" style={{ fontSize: '0.875rem', color: 'var(--color-text-bright)', marginTop: 2 }}>{value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Available streams */}
      {buoy.available?.length > 0 && (
        <div style={{ padding: '0.625rem 1rem', borderBottom: '1px solid var(--color-border)' }}>
          <div style={{ fontSize: '0.625rem', color: 'var(--color-text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.375rem' }}>Streams</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
            {buoy.available.map((s) => (
              <span key={s} className="mono" style={{ fontSize: '0.625rem', padding: '0.15rem 0.4rem', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 3, color: 'var(--color-text-dim)' }}>{s}</span>
            ))}
          </div>
        </div>
      )}

      {/* History charts */}
      <div style={{ padding: '0.875rem 1rem', flex: 1 }}>
        <div style={{ fontSize: '0.625rem', color: 'var(--color-text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.625rem' }}>History (4 days)</div>
        {loadingSeries && <div style={{ color: 'var(--color-text-dim)', fontSize: '0.75rem' }}>Loading…</div>}
        {Object.entries(STREAM_FIELDS)
          .filter(([stream]) => buoy.available?.includes(stream) && seriesData[stream])
          .map(([stream, { label, unit }]) => {
            const raw = seriesData[stream] || []
            const data = raw.map((d) => ({ ...d, value: convertSeries(d.value, unit, useMetric) }))
            return (
              <div key={stream} style={{ marginBottom: '0.75rem' }}>
                <Sparkline
                  data={data}
                  label={label}
                  color={thermalColor(raw[0]?.value)}
                  unitLabel={seriesUnitLabel(unit, useMetric)}
                />
              </div>
            )
          })}
      </div>

      {/* Actions */}
      <div style={{ padding: '0.875rem 1rem', borderTop: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <button
          className="btn"
          style={{ width: '100%', justifyContent: 'center' }}
          onClick={() => onNearbyRequest({ lat: buoy.lat, lon: buoy.lon, stationId: buoy.id })}
        >
          Compare nearby water temps
        </button>
        <button
          className={`btn${copied ? ' btn-amber' : ''}`}
          style={{ width: '100%', justifyContent: 'center' }}
          onClick={copyLink}
        >
          {copied ? 'Link copied!' : 'Copy share link'}
        </button>
      </div>
    </div>
  )
}
