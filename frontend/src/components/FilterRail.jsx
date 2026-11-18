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
    <div className="glass" style={{ padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
      {/* Search */}
      <div className="search-field">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" />
        </svg>
        <input
          className="input"
          type="search"
          placeholder="Search station or ID"
          aria-label="Search stations"
          value={filters.text || ''}
          onChange={(e) => onFiltersChange({ ...filters, text: e.target.value })}
        />
      </div>

      {/* Stream toggles */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.45rem' }}>
          <span className="eyebrow">Sensors</span>
          {filters.streams?.length > 0 && (
            <button className="eyebrow" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-amber)' }}
              onClick={() => onFiltersChange({ ...filters, streams: [] })}>Show all</button>
          )}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
          {STREAMS.map((stream) => {
            const on = filters.streams?.includes(stream)
            const c = STREAM_COLORS[stream]
            return (
              <button
                key={stream}
                className="chip"
                aria-pressed={!!on}
                onClick={() => toggleStream(stream)}
                style={on ? { borderColor: c, background: `color-mix(in srgb, ${c} 16%, transparent)`, color: 'var(--color-text-bright)' } : undefined}
              >
                <span className="dot" style={{ background: c }} />
                {STREAM_LABELS[stream]}
                <span className="count">{streamCounts[stream]}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Reporting toggle */}
      <label className="switch">
        <span>Reporting in last 24h</span>
        <input
          type="checkbox"
          checked={filters.reportingOnly || false}
          onChange={(e) => onFiltersChange({ ...filters, reportingOnly: e.target.checked })}
        />
      </label>

      {/* Thermal legend */}
      <div>
        <div className="eyebrow" style={{ marginBottom: '0.4rem' }}>Sea surface temp</div>
        <div style={{ height: 6, borderRadius: 999, background: thermalGradient(20) }} />
        <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.625rem', color: 'var(--color-text-dim)', marginTop: '0.3rem' }}>
          <span>{useMetric ? '−2°C' : '28°F'}</span>
          <span>{useMetric ? '14.5°' : '58°'}</span>
          <span>{useMetric ? '31°C' : '88°F'}</span>
        </div>
      </div>
    </div>
  )
}
