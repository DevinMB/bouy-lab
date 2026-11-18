import React, { useId } from 'react'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

// Full timestamp for the tooltip.
function formatTs(ts) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  return d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

// Compact label for the axis ticks (e.g. "Tue 3p") so they don't collide.
function formatTsAxis(ts) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const h = d.getHours()
  const h12 = h % 12 || 12
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${h12}${h < 12 ? 'a' : 'p'}`
}

const TICK = { fontSize: 9, fill: 'var(--color-text-dim)', fontFamily: 'var(--font-mono)' }

export default function Sparkline({ data, label, color = '#3b82f6', unitLabel = '', height = 72, dashed = false }) {
  const gid = useId().replace(/:/g, '')

  if (!data || data.length === 0) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-dim)', fontSize: '0.75rem' }}>
        No data in this window
      </div>
    )
  }

  const CustomTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null
    const d = payload[0].payload
    return (
      <div className="glass" style={{ padding: '5px 9px', fontSize: '0.6875rem', borderRadius: 8 }}>
        <div style={{ color: 'var(--color-text-dim)' }}>{formatTs(d.ts)}</div>
        <div className="num" style={{ color: 'var(--color-text-bright)', fontSize: '0.875rem' }}>{payload[0].value?.toFixed(1)} {unitLabel}</div>
      </div>
    )
  }

  return (
    <div>
      {label && <div className="eyebrow" style={{ marginBottom: 4 }}>{label}</div>}
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={[...data].reverse()} margin={{ top: 4, right: 6, left: -22, bottom: 0 }}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.32} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="ts"
            tickFormatter={formatTsAxis}
            tick={TICK}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
            minTickGap={48}
          />
          <YAxis tick={TICK} tickLine={false} axisLine={false} tickCount={3} domain={['auto', 'auto']} />
          <Tooltip content={<CustomTooltip />} cursor={{ stroke: 'var(--color-border-2)', strokeWidth: 1 }} />
          <Area
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={1.75}
            strokeDasharray={dashed ? '4 3' : undefined}
            fill={`url(#${gid})`}
            dot={false}
            activeDot={{ r: 3.5, fill: color, stroke: 'var(--color-bg)', strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
