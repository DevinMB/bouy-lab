import React from 'react'
import { thermalGradient } from '../thermal'

const STREAMS = ['standard', 'ocean', 'spec', 'srad', 'dart']
const STREAM_COLORS = {
  standard: '#3b82f6',
  ocean: '#14b8a6',
  spec: '#a855f7',
  srad: '#eab308',
  dart: '#f97316',
}
const STREAM_LABELS = {
  standard: 'Met',
  ocean: 'Ocean',
  spec: 'Waves',
  srad: 'Solar',
  dart: 'DART',
}

export default function FilterRail({ buoys, filters, onFiltersChange, useMetric }) {
  const streamCounts = {}
  STREAMS.forEach((s) => {
    streamCounts[s] = buoys.filter((b) => b.available?.includes(s)).length
  })

  const toggleStream = (stream) => {
    const cur = filters.streams || []
    const next = cur.includes(stream) ? cur.filter((s) => s !== stream) : [...cur, stream]
    onFiltersChange({ ...filters, streams: next })
  }

  return (
    <div style={{
      background: 'rgba(13, 33, 41, 0.92)',
      border: '1px solid var(--color-border)',
      borderRadius: 8,
      padding: '0.75rem',
      display: 'flex',
      flexDirection: 'column',
      gap: '0.625rem',
      backdropFilter: 'blur(6px)',
    }}>
      {/* Search */}
      <input
        className="input"
        placeholder="Search station…"
        value={filters.text || ''}
        onChange={(e) => onFiltersChange({ ...filters, text: e.target.value })}
        style={{ fontSize: '0.75rem' }}
      />

      {/* Stream toggles */}
      <div>
        <div style={{ fontSize: '0.625rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-text-dim)', marginBottom: '0.375rem' }}>Streams</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
          {STREAMS.map((stream) => {
            const active = !filters.streams?.length || filters.streams.includes(stream)
            return (
              <button
                key={stream}
                onClick={() => toggleStream(stream)}
                style={{
                  padding: '0.2rem 0.5rem',
                  borderRadius: 12,
                  border: `1px solid ${active ? STREAM_COLORS[stream] : 'var(--color-border)'}`,
                  background: active ? `${STREAM_COLORS[stream]}22` : 'transparent',
                  color: active ? STREAM_COLORS[stream] : 'var(--color-text-dim)',
                  fontSize: '0.6875rem',
                  fontFamily: 'var(--font-mono)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.25rem',
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: STREAM_COLORS[stream], display: 'inline-block' }} />
                {STREAM_LABELS[stream]}
                <span style={{ opacity: 0.6 }}>{streamCounts[stream]}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Reporting toggle */}
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.75rem', color: 'var(--color-text-dim)' }}>
        <input
          type="checkbox"
          checked={filters.reportingOnly || false}
          onChange={(e) => onFiltersChange({ ...filters, reportingOnly: e.target.checked })}
          style={{ accentColor: 'var(--color-amber)' }}
        />
        Reporting only (24h)
      </label>

      {/* Thermal legend */}
      <div>
        <div style={{ fontSize: '0.625rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-text-dim)', marginBottom: '0.25rem' }}>SST</div>
        <div style={{ height: 8, borderRadius: 4, background: thermalGradient(20) }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.625rem', fontFamily: 'var(--font-mono)', color: 'var(--color-text-dim)', marginTop: '0.2rem' }}>
          <span>{useMetric ? '−2 °C' : '28 °F'}</span>
          <span>{useMetric ? '31 °C' : '88 °F'}</span>
        </div>
      </div>
    </div>
  )
}
