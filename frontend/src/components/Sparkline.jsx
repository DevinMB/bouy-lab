import React from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

// Full timestamp for the tooltip.
function formatTs(ts) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  return `${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

// Compact label for the axis ticks (e.g. "6/16 3p") so they don't collide.
function formatTsAxis(ts) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const h = d.getHours()
  const h12 = h % 12 || 12
  return `${d.getMonth() + 1}/${d.getDate()} ${h12}${h < 12 ? 'a' : 'p'}`
}

export default function Sparkline({ data, label, color = '#3b82f6', unitLabel = '' }) {
  if (!data || data.length === 0) {
    return (
      <div style={{ height: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-dim)', fontSize: '0.75rem' }}>
        No data
      </div>
    )
  }

  const CustomTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null
    const d = payload[0].payload
    return (
      <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 4, padding: '4px 8px', fontSize: '0.6875rem', fontFamily: 'var(--font-mono)' }}>
        <div style={{ color: 'var(--color-text-dim)' }}>{formatTs(d.ts)}</div>
        <div style={{ color: 'var(--color-text-bright)' }}>{payload[0].value?.toFixed(1)} {unitLabel}</div>
      </div>
    )
  }

  return (
    <div>
      {label && <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-dim)', marginBottom: 2, fontFamily: 'var(--font-mono)' }}>{label}</div>}
      <ResponsiveContainer width="100%" height={72}>
        <LineChart data={[...data].reverse()} margin={{ top: 2, right: 4, left: -24, bottom: 0 }}>
          <XAxis
            dataKey="ts"
            tickFormatter={formatTsAxis}
            tick={{ fontSize: 9, fill: 'var(--color-text-dim)', fontFamily: 'var(--font-mono)' }}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
            minTickGap={45}
          />
          <YAxis
            tick={{ fontSize: 9, fill: 'var(--color-text-dim)', fontFamily: 'var(--font-mono)' }}
            tickLine={false}
            axisLine={false}
            tickCount={3}
          />
          <Tooltip content={<CustomTooltip />} />
          <Line
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
