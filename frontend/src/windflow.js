// Leaflet comes from the CDN <script> tags in index.html (see MapView.jsx). Never
// `import L from 'leaflet'`: Leaflet's ES-module build overwrites window.L when
// imported, replacing the CDN instance that leaflet.markercluster patched -- which
// broke the main map ("L.markerClusterGroup is not a function") on 2026-10-20.
const L = window.L

// Wind flow overlay: live wind drawn as glowing particle streams.
//
// Honest by construction. A classic flow map interpolates a continuous field
// across the whole ocean, which over open water is mostly invented. Here every
// grid cell also carries SUPPORT -- how close the nearest real buoy is -- and
// particles are born where support is high and fade as it falls. The map glows
// where the network is measuring and goes dark where it is not.
//
// Pipeline: buoys -> setBuoys() splats each fresh wind vector onto a 0.5° grid
// (once per data refresh) -> particles sample that grid every frame -> trails
// come from fading the canvas a little each frame instead of clearing it.

const RES = 0.5 // grid resolution, degrees
const LAT0 = -80
const ROWS = Math.round((85 - LAT0) / RES)
const COLS = Math.round(360 / RES)
const INFLUENCE_KM = 450 // a buoy's wind reaches this far into the field
const SUPPORT_NEAR_KM = 80 // full brightness within this distance of a buoy
const SUPPORT_FAR_KM = 450 // fully faded by this distance
const FRESH_SECS = 3 * 3600 // wind older than this is not drawn
const TRAIL_FADE = 0.965 // alpha retained per frame; higher = longer trails (~30 frames)
const PX_PER_MS = 0.11 // on-screen pixels per frame per m/s of wind

// Calm teal -> cyan -> violet -> pink -> warm white for gales.
const SPEED_STOPS = [[0, '#2dd4bf'], [5, '#67e8f9'], [10, '#a78bfa'], [15, '#f472b6'], [22, '#fef3c7']]
export const WIND_LEGEND = SPEED_STOPS
const BUCKETS = 10 // colour buckets per frame (batching keeps stroke calls low)

function hexRgb(h) {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function speedColor(s) {
  for (let i = 1; i < SPEED_STOPS.length; i++) {
    const [s1, c1] = SPEED_STOPS[i]
    const [s0, c0] = SPEED_STOPS[i - 1]
    if (s <= s1) {
      const f = (s - s0) / (s1 - s0)
      const a = hexRgb(c0); const b = hexRgb(c1)
      return a.map((v, k) => Math.round(v + (b[k] - v) * f))
    }
  }
  return hexRgb(SPEED_STOPS[SPEED_STOPS.length - 1][1])
}
const BUCKET_RGB = Array.from({ length: BUCKETS }, (_, i) =>
  speedColor((i + 0.5) * (22 / BUCKETS)).join(','))

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export const WindFlowLayer = L.Layer.extend({
  initialize() {
    this._u = new Float32Array(ROWS * COLS)
    this._v = new Float32Array(ROWS * COLS)
    this._support = new Float32Array(ROWS * COLS)
    this._spawn = [] // supported cell indices inside the current view
    this._particles = []
    this._stations = 0
    this._reduceMotion = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  },

  // ── field ───────────────────────────────────────────────────────────────
  setBuoys(buoys) {
    const U = new Float32Array(ROWS * COLS)
    const V = new Float32Array(ROWS * COLS)
    const W = new Float32Array(ROWS * COLS)
    const D = new Float32Array(ROWS * COLS).fill(Infinity)
    const now = Date.now() / 1000
    let used = 0
    for (const b of buoys) {
      const w = b.latest || {}
      if (b.lat == null || b.lon == null || w.windSpeed == null || w.windDirection == null) continue
      if (!w.windTs || now - w.windTs > FRESH_SECS) continue
      used++
      // NDBC WDIR is where the wind blows FROM; flow points the other way.
      const rad = (w.windDirection * Math.PI) / 180
      const u = -w.windSpeed * Math.sin(rad) // eastward m/s
      const v = -w.windSpeed * Math.cos(rad) // northward m/s
      const dLat = INFLUENCE_KM / 111
      const r0 = Math.max(0, Math.floor((b.lat - dLat - LAT0) / RES))
      const r1 = Math.min(ROWS - 1, Math.ceil((b.lat + dLat - LAT0) / RES))
      for (let r = r0; r <= r1; r++) {
        const lat = LAT0 + (r + 0.5) * RES
        const cos = Math.max(0.05, Math.cos((lat * Math.PI) / 180))
        const dLon = INFLUENCE_KM / (111 * cos)
        const c0 = Math.floor((b.lon - dLon + 180) / RES)
        const c1 = Math.ceil((b.lon + dLon + 180) / RES)
        for (let cc = c0; cc <= c1; cc++) {
          const c = ((cc % COLS) + COLS) % COLS // wrap across the dateline
          const clon = -180 + (cc + 0.5) * RES
          const dx = (clon - b.lon) * 111 * cos
          const dy = (lat - b.lat) * 111
          const d = Math.sqrt(dx * dx + dy * dy)
          if (d > INFLUENCE_KM) continue
          const k = r * COLS + c
          const wt = 1 / (d * d + 2500) // inverse-distance, softened within ~50 km
          U[k] += wt * u; V[k] += wt * v; W[k] += wt
          if (d < D[k]) D[k] = d
        }
      }
    }
    for (let k = 0; k < U.length; k++) {
      if (W[k] > 0) {
        this._u[k] = U[k] / W[k]; this._v[k] = V[k] / W[k]
        this._support[k] = 1 - smoothstep(SUPPORT_NEAR_KM, SUPPORT_FAR_KM, D[k])
      } else {
        this._u[k] = 0; this._v[k] = 0; this._support[k] = 0
      }
    }
    this._stations = used
    if (this._map) this._reset()
    return used
  },

  _sample(lat, lon) {
    const fr = (lat - LAT0) / RES - 0.5
    const fc = (lon + 180) / RES - 0.5
    const r = Math.floor(fr); const c = Math.floor(fc)
    if (r < 0 || r >= ROWS - 1) return null
    const tr = fr - r; const tc = fc - c
    const c0 = ((c % COLS) + COLS) % COLS; const c1 = (c0 + 1) % COLS
    const k00 = r * COLS + c0, k01 = r * COLS + c1, k10 = (r + 1) * COLS + c0, k11 = (r + 1) * COLS + c1
    const lerp = (a) => (a[k00] * (1 - tc) + a[k01] * tc) * (1 - tr) + (a[k10] * (1 - tc) + a[k11] * tc) * tr
    return { u: lerp(this._u), v: lerp(this._v), s: lerp(this._support) }
  },

  // ── Leaflet plumbing ──────────────────────────────────────────────────────
  onAdd(map) {
    this._map = map
    this._canvas = L.DomUtil.create('canvas', 'leaflet-zoom-hide')
    this._canvas.style.pointerEvents = 'none'
    map.getPanes().overlayPane.appendChild(this._canvas) // under the markers
    this._ctx = this._canvas.getContext('2d')
    map.on('moveend', this._reset, this)
    map.on('resize', this._reset, this)
    map.on('zoomstart', this._clear, this)
    this._reset()
    this._last = performance.now()
    this._raf = requestAnimationFrame(this._frame.bind(this))
  },

  onRemove(map) {
    cancelAnimationFrame(this._raf)
    map.off('moveend', this._reset, this)
    map.off('resize', this._reset, this)
    map.off('zoomstart', this._clear, this)
    this._canvas.remove()
    this._map = null
  },

  _clear() {
    if (this._ctx) this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height)
  },

  // On every pan/zoom: realign the canvas with the viewport, rebuild the spawn
  // list from supported cells in view, and restart the particles.
  _reset() {
    const map = this._map
    if (!map) return
    const size = map.getSize()
    const dpr = window.devicePixelRatio || 1
    this._dpr = dpr
    this._canvas.width = size.x * dpr
    this._canvas.height = size.y * dpr
    this._canvas.style.width = `${size.x}px`
    this._canvas.style.height = `${size.y}px`
    L.DomUtil.setPosition(this._canvas, map.containerPointToLayerPoint([0, 0]))
    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this._clear()

    const b = map.getBounds().pad(0.1)
    const spawn = []
    const r0 = Math.max(0, Math.floor((b.getSouth() - LAT0) / RES))
    const r1 = Math.min(ROWS - 1, Math.ceil((b.getNorth() - LAT0) / RES))
    const west = b.getWest(); const east = b.getEast()
    const cSpan = Math.min(COLS, Math.ceil((east - west) / RES) + 1)
    const cStart = Math.floor((west + 180) / RES)
    for (let r = r0; r <= r1; r++) {
      for (let i = 0; i < cSpan; i++) {
        const c = (((cStart + i) % COLS) + COLS) % COLS
        const k = r * COLS + c
        // Spawn weighting: brighter near buoys, but every supported cell can seed.
        // (row, unwrapped column) pairs: the column can be negative or past 360°
        // when the view crosses the dateline, so it is never packed into one number.
        if (this._support[k] > 0.25) spawn.push(r, cStart + i)
      }
    }
    this._spawn = spawn
    // Density follows how much MEASURED ocean is in view, not screen size --
    // zoomed into one storm, a screen-sized count piled every particle onto a
    // few buoys and additive blending whited the area out.
    const cells = spawn.length / 2
    const count = Math.round(Math.max(250, Math.min(3500, cells * 2.2, (size.x * size.y) / 380)))
    this._particles = Array.from({ length: spawn.length ? count : 0 }, () => this._newParticle(true))
    if (this._reduceMotion) this._stillLife()
  },

  _newParticle(randomAge) {
    const i = ((Math.random() * (this._spawn.length / 2)) | 0) * 2
    const r = this._spawn[i]; const cc = this._spawn[i + 1]
    const lat = LAT0 + (r + Math.random()) * RES
    const lon = -180 + (cc + Math.random()) * RES
    const maxAge = 50 + Math.random() * 90
    return { lat, lon, age: randomAge ? Math.random() * maxAge : 0, maxAge, p: null }
  },

  _visible() {
    const el = this._map?.getContainer()
    return el && el.offsetParent !== null && !document.hidden
  },

  _frame(t) {
    this._raf = requestAnimationFrame(this._frame.bind(this))
    if (!this._map || this._reduceMotion || !this._visible()) return
    const dt = Math.min(3, (t - this._last) / 16.67) // in 60 fps frames
    this._last = t
    this._step(dt, true)
  },

  _step(dt, fade) {
    const ctx = this._ctx
    const map = this._map
    const size = map.getSize()
    if (fade) {
      ctx.globalCompositeOperation = 'destination-in'
      ctx.fillStyle = `rgba(0,0,0,${Math.pow(TRAIL_FADE, dt)})`
      ctx.fillRect(0, 0, size.x, size.y)
    }
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineWidth = map.getZoom() >= 6 ? 1.6 : 1.1
    ctx.lineCap = 'round'
    // Degrees per frame per m/s, so on-screen speed is the same at every zoom.
    const degPerPx = 360 / (256 * Math.pow(2, map.getZoom()))
    const k = PX_PER_MS * degPerPx * dt
    const paths = Array.from({ length: BUCKETS * 3 }, () => new Path2D())
    let drawn = 0
    for (let i = 0; i < this._particles.length; i++) {
      let pt = this._particles[i]
      const f = this._sample(pt.lat, pt.lon)
      pt.age += dt
      if (!f || f.s < 0.04 || pt.age > pt.maxAge) {
        this._particles[i] = this._newParticle(false)
        continue
      }
      const speed = Math.hypot(f.u, f.v)
      const cos = Math.max(0.05, Math.cos((pt.lat * Math.PI) / 180))
      const nlat = pt.lat + f.v * k
      const nlon = pt.lon + (f.u * k) / cos
      const a = pt.p || map.latLngToContainerPoint([pt.lat, pt.lon])
      const bpt = map.latLngToContainerPoint([nlat, nlon])
      pt.lat = nlat; pt.lon = nlon; pt.p = bpt
      if (bpt.x < -20 || bpt.y < -20 || bpt.x > size.x + 20 || bpt.y > size.y + 20) {
        this._particles[i] = this._newParticle(false)
        continue
      }
      // Fade in at birth and out near the end of life, scaled by support.
      const life = Math.min(1, pt.age / 10, (pt.maxAge - pt.age) / 15)
      const alpha = f.s * life
      if (alpha < 0.05) continue
      const cb = Math.min(BUCKETS - 1, Math.floor(speed / (22 / BUCKETS)))
      const ab = alpha > 0.66 ? 2 : alpha > 0.33 ? 1 : 0
      const path = paths[cb * 3 + ab]
      path.moveTo(a.x, a.y)
      path.lineTo(bpt.x, bpt.y)
      drawn++
    }
    for (let cb = 0; cb < BUCKETS; cb++) {
      for (let ab = 0; ab < 3; ab++) {
        ctx.strokeStyle = `rgba(${BUCKET_RGB[cb]},${[0.2, 0.42, 0.68][ab]})`
        ctx.stroke(paths[cb * 3 + ab])
      }
    }
    return drawn
  },

  // Reduced motion: lay down a still image of short streamlines, no animation.
  _stillLife() {
    for (let i = 0; i < 40; i++) this._step(1, false)
  },

  stationCount() { return this._stations },
})
