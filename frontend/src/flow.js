// Flow overlay: live wind or swell drawn as glowing particle streams.
//
// Leaflet comes from the CDN <script> tags in index.html (see MapView.jsx). Never
// `import L from 'leaflet'`: Leaflet's ES-module build overwrites window.L when
// imported, replacing the CDN instance that leaflet.markercluster patched -- which
// broke the main map ("L.markerClusterGroup is not a function") on 2026-10-20.
const L = window.L

// Honest by construction. A classic flow map interpolates a continuous field
// across the whole ocean, which over open water is mostly invented. Every grid
// cell here also carries SUPPORT -- how close the nearest real buoy is -- and
// particles are born where support is high and fade as it falls. The map glows
// where the network is measuring and goes dark where it is not.
//
// Pipeline: buoys -> setBuoys() splats each fresh vector onto a 0.5° grid (once
// per data refresh) -> particles sample it every frame -> trails come from fading
// the canvas a little each frame instead of clearing it.

const RES = 0.5
const LAT0 = -80
const ROWS = Math.round((85 - LAT0) / RES)
const COLS = Math.round(360 / RES)
const INFLUENCE_KM = 450
const SUPPORT_NEAR_KM = 80
const SUPPORT_FAR_KM = 450
const FRESH_SECS = 3 * 3600
const PX_PER_MS = 0.11 // on-screen pixels per frame per m/s of motion
const BUCKETS = 10
const FRAME_MS = 1000 / 30 // trails read as continuous at 30 fps; half the work of 60
const MAX_PARTICLES = 2500

// Each kind says how a buoy becomes a vector: `dir` is where it comes FROM
// (degrees true), `speed` drives motion (m/s), `mag` drives colour.
export const FLOW_KINDS = {
  wind: {
    label: 'Wind',
    vector: (w) => (w.windSpeed == null || w.windDirection == null ? null
      : { dir: w.windDirection, speed: w.windSpeed, mag: w.windSpeed, ts: w.windTs }),
    // calm teal -> cyan -> violet -> pink -> warm white for gales (m/s)
    stops: [[0, '#2dd4bf'], [5, '#67e8f9'], [10, '#a78bfa'], [15, '#f472b6'], [22, '#fef3c7']],
    magMax: 22,
    unit: 'wind',
    fade: 0.965,
  },
  swell: {
    label: 'Swell',
    // Particles move at the swell's real relative travel speed: deep-water
    // group velocity c_g = gT/4π ≈ 0.78·T m/s. Long-period swell -- energy from
    // distant storms -- visibly outruns short swell. Colour is swell height.
    vector: (w) => (w.swellDirection == null || w.swellPeriod == null || w.swellHeight == null ? null
      : { dir: w.swellDirection, speed: 0.78 * w.swellPeriod, mag: w.swellHeight, ts: w.swellTs }),
    // deep blue -> blue -> cyan -> ice -> white (metres); distinct from wind
    stops: [[0, '#1e40af'], [0.6, '#2563eb'], [1.5, '#06b6d4'], [3, '#a5f3fc'], [5, '#ffffff']],
    magMax: 5,
    unit: 'wave',
    fade: 0.975, // swell is long-crested: longer, smoother trails
  },
}

function hexRgb(h) {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function rampColor(stops, x) {
  for (let i = 1; i < stops.length; i++) {
    const [s1, c1] = stops[i]
    const [s0, c0] = stops[i - 1]
    if (x <= s1) {
      const f = (x - s0) / (s1 - s0)
      const a = hexRgb(c0); const b = hexRgb(c1)
      return a.map((v, k) => Math.round(v + (b[k] - v) * f))
    }
  }
  return hexRgb(stops[stops.length - 1][1])
}
function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export const FlowLayer = L.Layer.extend({

  initialize(kind = 'wind') {
    this._u = new Float32Array(ROWS * COLS)
    this._v = new Float32Array(ROWS * COLS)
    this._mag = new Float32Array(ROWS * COLS)
    this._support = new Float32Array(ROWS * COLS)
    this._spawn = []
    this._particles = []
    this._stations = 0
    this._buoys = []
    this._reduceMotion = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    this.setKind(kind)
  },

  setKind(kind) {
    this._kind = FLOW_KINDS[kind] || FLOW_KINDS.wind
    const k = this._kind
    this._rgb = Array.from({ length: BUCKETS }, (_, i) => rampColor(k.stops, (i + 0.5) * (k.magMax / BUCKETS)).join(','))
    if (this._buoys.length) this.setBuoys(this._buoys)
    return this
  },

  // ── field ───────────────────────────────────────────────────────────────
  setBuoys(buoys) {
    this._buoys = buoys
    const N = ROWS * COLS
    const U = new Float32Array(N), V = new Float32Array(N), M = new Float32Array(N), W = new Float32Array(N)
    const D = new Float32Array(N).fill(Infinity)
    const now = Date.now() / 1000
    let used = 0
    for (const b of buoys) {
      if (b.lat == null || b.lon == null) continue
      const vec = this._kind.vector(b.latest || {})
      if (!vec || !vec.ts || now - vec.ts > FRESH_SECS) continue
      used++
      const rad = (vec.dir * Math.PI) / 180 // FROM direction; motion points the other way
      const u = -vec.speed * Math.sin(rad)
      const v = -vec.speed * Math.cos(rad)
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
          const wt = 1 / (d * d + 2500)
          U[k] += wt * u; V[k] += wt * v; M[k] += wt * vec.mag; W[k] += wt
          if (d < D[k]) D[k] = d
        }
      }
    }
    for (let k = 0; k < N; k++) {
      if (W[k] > 0) {
        this._u[k] = U[k] / W[k]; this._v[k] = V[k] / W[k]; this._mag[k] = M[k] / W[k]
        this._support[k] = 1 - smoothstep(SUPPORT_NEAR_KM, SUPPORT_FAR_KM, D[k])
      } else {
        this._u[k] = 0; this._v[k] = 0; this._mag[k] = 0; this._support[k] = 0
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
    return { u: lerp(this._u), v: lerp(this._v), m: lerp(this._mag), s: lerp(this._support) }
  },

  // ── Leaflet plumbing ──────────────────────────────────────────────────────
  onAdd(map) {
    this._map = map
    this._canvas = L.DomUtil.create('canvas', 'leaflet-zoom-hide')
    this._canvas.style.pointerEvents = 'none'
    map.getPanes().overlayPane.appendChild(this._canvas) // under the markers
    this._ctx = this._canvas.getContext('2d')
    map.on('movestart', this._onMoveStart, this)
    map.on('moveend', this._onMoveEnd, this)
    map.on('resize', this._reset, this)
    map.on('zoomstart', this._clear, this)
    this._moving = false
    this._reset()
    this._last = performance.now()
    this._raf = requestAnimationFrame(this._frame.bind(this))
  },

  onRemove(map) {
    cancelAnimationFrame(this._raf)
    map.off('movestart', this._onMoveStart, this)
    map.off('moveend', this._onMoveEnd, this)
    map.off('resize', this._reset, this)
    map.off('zoomstart', this._clear, this)
    this._canvas.remove()
    this._map = null
  },

  // The canvas sits in the overlay pane, which Leaflet translates while the map
  // is dragged -- but particles are drawn at CONTAINER positions, so drawing
  // mid-drag landed every stroke offset by the drag distance. Freeze while
  // moving (the image slides with the map like the tiles), realign on moveend.
  _onMoveStart() { this._moving = true },
  _onMoveEnd() { this._moving = false; this._reset() },

  _clear() {
    if (this._ctx) this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height)
  },

  _reset() {
    const map = this._map
    if (!map) return
    const size = map.getSize()
    // Rendered at CSS-pixel resolution even on retina screens: up to 4x fewer
    // pixels to fade and stroke each frame, and the glow hides the softening.
    const dpr = 1
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
    const cSpan = Math.min(COLS, Math.ceil((b.getEast() - b.getWest()) / RES) + 1)
    const cStart = Math.floor((b.getWest() + 180) / RES)
    for (let r = r0; r <= r1; r++) {
      for (let i = 0; i < cSpan; i++) {
        const c = (((cStart + i) % COLS) + COLS) % COLS
        // (row, unwrapped column) pairs: the column can be negative or past 360°
        // when the view crosses the dateline, so it is never packed into one number.
        if (this._support[r * COLS + c] > 0.25) spawn.push(r, cStart + i)
      }
    }
    this._spawn = spawn
    // Density follows how much MEASURED ocean is in view, not screen size --
    // zoomed into one storm, a screen-sized count piled every particle onto a
    // few buoys and additive blending whited the area out.
    const cells = spawn.length / 2
    const count = Math.round(Math.max(250, Math.min(MAX_PARTICLES, cells * 2.2, (size.x * size.y) / 380)))
    this._particles = Array.from({ length: spawn.length ? count : 0 }, () => this._newParticle(true))
    if (this._reduceMotion) for (let i = 0; i < 40; i++) this._step(1, false)
  },

  _newParticle(randomAge) {
    const i = ((Math.random() * (this._spawn.length / 2)) | 0) * 2
    const r = this._spawn[i]; const cc = this._spawn[i + 1]
    const maxAge = 50 + Math.random() * 90
    return { lat: LAT0 + (r + Math.random()) * RES, lon: -180 + (cc + Math.random()) * RES,
      age: randomAge ? Math.random() * maxAge : 0, maxAge, p: null }
  },

  _visible() {
    const el = this._map?.getContainer()
    return el && el.offsetParent !== null && !document.hidden
  },

  _frame(t) {
    this._raf = requestAnimationFrame(this._frame.bind(this))
    if (!this._map || this._reduceMotion || this._moving || !this._visible()) { this._last = t; return }
    if (t - this._last < FRAME_MS - 1) return
    const dt = Math.min(4, (t - this._last) / 16.67) // in 60 fps units, so motion speed is unchanged
    this._last = t
    this._step(dt, true)
  },

  // Web Mercator to container pixels, inlined. map.latLngToContainerPoint
  // allocates a LatLng and two Points per call -- ~5,000 allocations a frame,
  // which kept the garbage collector busy. Same formula as Leaflet's EPSG3857.
  _projector() {
    const map = this._map
    const scale = 256 * Math.pow(2, map.getZoom())
    const po = map.getPixelOrigin()
    const pane = map._getMapPanePos()
    const ox = pane.x - po.x
    const oy = pane.y - po.y
    const MAXLAT = 85.0511287798
    return (lat, lon) => {
      const la = Math.max(-MAXLAT, Math.min(MAXLAT, lat)) * Math.PI / 180
      return [
        scale * (0.5 + lon / 360) + ox,
        scale * (0.5 - Math.log(Math.tan(Math.PI / 4 + la / 2)) / (2 * Math.PI)) + oy,
      ]
    }
  },

  _step(dt, fade) {
    const ctx = this._ctx
    const map = this._map
    const size = map.getSize()
    const kind = this._kind
    if (fade) {
      ctx.globalCompositeOperation = 'destination-in'
      ctx.fillStyle = `rgba(0,0,0,${Math.pow(kind.fade, dt)})`
      ctx.fillRect(0, 0, size.x, size.y)
    }
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineWidth = map.getZoom() >= 6 ? 1.6 : 1.1
    ctx.lineCap = 'round'
    const degPerPx = 360 / (256 * Math.pow(2, map.getZoom()))
    const k = PX_PER_MS * degPerPx * dt // degrees per frame per m/s, constant on screen
    const paths = Array.from({ length: BUCKETS * 3 }, () => new Path2D())
    const proj = this._projector()
    for (let i = 0; i < this._particles.length; i++) {
      const pt = this._particles[i]
      const f = this._sample(pt.lat, pt.lon)
      pt.age += dt
      if (!f || f.s < 0.04 || pt.age > pt.maxAge) { this._particles[i] = this._newParticle(false); continue }
      const cos = Math.max(0.05, Math.cos((pt.lat * Math.PI) / 180))
      const nlat = pt.lat + f.v * k
      const nlon = pt.lon + (f.u * k) / cos
      const a = pt.p || proj(pt.lat, pt.lon)
      const bpt = proj(nlat, nlon)
      pt.lat = nlat; pt.lon = nlon; pt.p = bpt
      if (bpt[0] < -20 || bpt[1] < -20 || bpt[0] > size.x + 20 || bpt[1] > size.y + 20) {
        this._particles[i] = this._newParticle(false); continue
      }
      const alpha = f.s * Math.min(1, pt.age / 10, (pt.maxAge - pt.age) / 15)
      if (alpha < 0.05) continue
      const cb = Math.min(BUCKETS - 1, Math.max(0, Math.floor(f.m / (kind.magMax / BUCKETS))))
      const ab = alpha > 0.66 ? 2 : alpha > 0.33 ? 1 : 0
      const path = paths[cb * 3 + ab]
      path.moveTo(a[0], a[1])
      path.lineTo(bpt[0], bpt[1])
    }
    for (let cb = 0; cb < BUCKETS; cb++) {
      for (let ab = 0; ab < 3; ab++) {
        ctx.strokeStyle = `rgba(${this._rgb[cb]},${[0.2, 0.42, 0.68][ab]})`
        ctx.stroke(paths[cb * 3 + ab])
      }
    }
  },
})
