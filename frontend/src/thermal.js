// Sea-surface temperature color ramp. Input always °C. Range: -2 to 31.
const RAMP = [
  [-2,  [20,  20, 100]],
  [5,   [30,  60, 160]],
  [10,  [30, 120, 180]],
  [15,  [20, 160, 150]],
  [18,  [40, 185, 110]],
  [22,  [120, 200,  60]],
  [25,  [220, 200,  30]],
  [28,  [240, 130,  20]],
  [31,  [220,  40,  20]],
]

function lerp(a, b, t) {
  return a + (b - a) * t
}

export function thermalColor(c) {
  if (c == null || isNaN(c)) return '#666'
  const clamped = Math.max(-2, Math.min(31, c))
  for (let i = 1; i < RAMP.length; i++) {
    const [t0, rgb0] = RAMP[i - 1]
    const [t1, rgb1] = RAMP[i]
    if (clamped <= t1) {
      const t = (clamped - t0) / (t1 - t0)
      const r = Math.round(lerp(rgb0[0], rgb1[0], t))
      const g = Math.round(lerp(rgb0[1], rgb1[1], t))
      const b = Math.round(lerp(rgb0[2], rgb1[2], t))
      return `rgb(${r},${g},${b})`
    }
  }
  const last = RAMP[RAMP.length - 1][1]
  return `rgb(${last[0]},${last[1]},${last[2]})`
}

export function thermalGradient(steps = 10) {
  const stops = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const c = -2 + t * 33
    stops.push(`${thermalColor(c)} ${(t * 100).toFixed(0)}%`)
  }
  return `linear-gradient(to right, ${stops.join(', ')})`
}

export function onThermalText(c) {
  if (c == null || isNaN(c)) return '#fff'
  return c > 18 ? '#111' : '#fff'
}

export function thermalRampRange() {
  return { min: -2, max: 31 }
}
