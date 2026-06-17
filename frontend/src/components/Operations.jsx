import React from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'
import { thermalColor } from '../thermal'

const STREAM_COLORS = {
  standard: '#3b82f6',
  ocean: '#14b8a6',
  spec: '#a855f7',
  srad: '#eab308',
  dart: '#f97316',
}

const darkTooltipStyle = {
  contentStyle: {
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: 4,
    fontSize: '0.75rem',
    fontFamily: 'var(--font-mono)',
    color: 'var(--color-text)',
  },
  itemStyle: { color: 'var(--color-text-bright)' },
  labelStyle: { color: 'var(--color-text-dim)' },
}

function HBar({ data, color }) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(data.length * 22, 44)}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="name"
          width={110}
          tick={{ fontSize: 10, fill: 'var(--color-text-dim)', fontFamily: 'var(--font-mono)' }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip {...darkTooltipStyle} />
        <Bar dataKey="count" radius={[0, 3, 3, 0]}>
          {data.map((entry, i) => (
            <Cell key={i} fill={color || '#3b82f6'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

export default function Operations({ stats, useMetric }) {
  if (!stats) {
    return <div className="loading-veil">Loading fleet data…</div>
  }

  const histData = (stats.waterTempHistogram || []).map((d) => ({
    temp: useMetric ? d.tempC : Math.round(d.tempC * 9 / 5 + 32),
    count: d.count,
    color: thermalColor(d.tempC),
  }))

  const ownerData = Object.entries(stats.byOwner || {})
    .slice(0, 12)
    .map(([name, count]) => ({ name, count }))

  const typeData = Object.entries(stats.byType || {})
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }))

  const coverageData = Object.entries(stats.coverage || {})
    .map(([name, count]) => ({ name, count, color: STREAM_COLORS[name] || '#888' }))

  return (
    <div className="ops-page">
      {/* Stat cards */}
      <div className="ops-section">
        <div className="stat-cards">
          <div className="stat-card">
            <div className="label">Total Stations</div>
            <div className="value">{stats.total?.toLocaleString()}</div>
          </div>
          <div className="stat-card">
            <div className="label">Reporting (24h)</div>
            <div className="value" style={{ color: 'var(--color-green)' }}>{stats.reporting?.toLocaleString()}</div>
          </div>
          <div className="stat-card">
            <div className="label">Located</div>
            <div className="value">{stats.located?.toLocaleString()}</div>
          </div>
        </div>
      </div>

      {/* Water temp histogram */}
      {histData.length > 0 && (
        <div className="ops-section">
          <div className="ops-section-title">Network Water Temperature Distribution</div>
          <div className="chart-container">
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={histData} margin={{ top: 4, right: 4, left: -8, bottom: 0 }}>
                <XAxis
                  dataKey="temp"
                  tick={{ fontSize: 9, fill: 'var(--color-text-dim)', fontFamily: 'var(--font-mono)' }}
                  tickLine={false}
                  axisLine={false}
                  label={{ value: useMetric ? '°C' : '°F', position: 'insideRight', offset: -4, fontSize: 9, fill: 'var(--color-text-dim)' }}
                />
                <YAxis hide />
                <Tooltip
                  {...darkTooltipStyle}
                  formatter={(v, n, p) => [v, 'stations']}
                  labelFormatter={(l) => `${l}${useMetric ? ' °C' : ' °F'}`}
                />
                <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                  {histData.map((d, i) => (
                    <Cell key={i} fill={d.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* By Owner */}
      {ownerData.length > 0 && (
        <div className="ops-section">
          <div className="ops-section-title">By Owner</div>
          <div className="chart-container">
            <HBar data={ownerData} color="#3b82f6" />
          </div>
        </div>
      )}

      {/* By Type */}
      {typeData.length > 0 && (
        <div className="ops-section">
          <div className="ops-section-title">By Station Type</div>
          <div className="chart-container">
            <HBar data={typeData} color="#8b5cf6" />
          </div>
        </div>
      )}

      {/* Stream coverage */}
      {coverageData.length > 0 && (
        <div className="ops-section">
          <div className="ops-section-title">Stream Coverage</div>
          <div className="chart-container">
            <ResponsiveContainer width="100%" height={80}>
              <BarChart data={coverageData} margin={{ top: 4, right: 4, left: -8, bottom: 0 }}>
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 10, fill: 'var(--color-text-dim)', fontFamily: 'var(--font-mono)' }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis hide />
                <Tooltip {...darkTooltipStyle} formatter={(v) => [v, 'stations']} />
                <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                  {coverageData.map((d, i) => (
                    <Cell key={i} fill={d.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  )
}
