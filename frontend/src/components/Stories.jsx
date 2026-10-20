import React, { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { units as U } from '../api'
import { useIsNarrow } from '../hooks'

// Stories: precomputed storm narratives (backend/tools/build_story.py) played
// back as an animation on a map. Playback never touches the API -- each story is
// one static JSON file under /stories/.
//
// What is drawn, deliberately: every buoy's deviation from its OWN normal, never
// an interpolated field. The ocean between buoys is mostly unmeasured, and a
// smooth colour wash across it would be invented. The track is "where the
// network felt the storm most" (a weighted centroid of the deepest buoys), drawn
// with its uncertainty, not a claimed storm centre.

const CARTO_KEY = import.meta.env.VITE_CARTO_API_KEY || ''
const CARTO_TILES =
  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png' +
  (CARTO_KEY ? `?key=${encodeURIComponent(CARTO_KEY)}` : '')

const LAYERS = [
  ['auto', 'Story'],
  ['p', 'Pressure'],
  ['g', 'Wind'],
  ['t', 'Sea temp'],
]
const SPEEDS = [6, 12, 24] // story hours per real second
const EVENT_SHOW_HOURS = 18 // how long an annotation stays on the map

// ── colour ramps (dark basemap: more intense = brighter) ─────────────────────
function lerpColor(stops, x) {
  const t = Math.max(0, Math.min(1, x))
  for (let i = 1; i < stops.length; i++) {
    const [p1, c1] = stops[i]
    const [p0, c0] = stops[i - 1]
    if (t <= p1) {
      const f = (t - p0) / (p1 - p0 || 1)
      const a = hex(c0); const b = hex(c1)
      return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`
    }
  }
  return stops[stops.length - 1][1]
}
function hex(c) {
  const n = parseInt(c.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const NEUTRAL = '#334155'
const P_STOPS = [[0, NEUTRAL], [0.15, '#4f46e5'], [0.4, '#a855f7'], [0.7, '#ec4899'], [1, '#fde047']]
const COLD_STOPS = [[0, NEUTRAL], [0.25, '#0369a1'], [0.6, '#0ea5e9'], [1, '#e0f2fe']]
const WARM_STOPS = [[0, NEUTRAL], [1, '#f59e0b']]
const G_STOPS = [[0, NEUTRAL], [0.28, '#14b8a6'], [0.55, '#eab308'], [0.8, '#ef4444'], [1, '#fdf4ff']]

const P_FULL = 45 // hPa below normal for the brightest colour
const T_FULL = 2.2 // °C below trend for the brightest colour
const G_FULL = 38 // m/s gust for the brightest colour

function styleFor(layer, p, t, g) {
  if (layer === 'p') {
    if (p == null) return { color: NEUTRAL, strength: 0, missing: true }
    const s = Math.max(0, -p) / P_FULL
    return { color: p < 0 ? lerpColor(P_STOPS, s) : NEUTRAL, strength: s }
  }
  if (layer === 't') {
    if (t == null) return { color: NEUTRAL, strength: 0, missing: true }
    if (t < 0) { const s = -t / T_FULL; return { color: lerpColor(COLD_STOPS, s), strength: s } }
    return { color: lerpColor(WARM_STOPS, t / 1.5), strength: 0 }
  }
  if (g == null) return { color: NEUTRAL, strength: 0, missing: true }
  const s = g / G_FULL
  return { color: lerpColor(G_STOPS, s), strength: s }
}

function radiusFor(g, w) {
  const v = g ?? w
  return v == null ? 4 : 4 + Math.min(40, v) * 0.32
}

// Linear interpolation between hourly frames so colours glide rather than tick.
function sample(series, x) {
  const i = Math.floor(x)
  const f = x - i
  const a = series[i]
  const b = series[i + 1]
  if (a != null && b != null) return a + (b - a) * f
  if (a != null) return f < 0.5 ? a : null
  if (b != null) return f >= 0.5 ? b : null
  return null
}

// Event text arrives with unit tokens ({hPa:959.4}, {ms:31}, ...) from the
// builder, so narration follows the viewer's unit setting instead of being
// baked in as metric next to imperial stat chips.
function formatTokens(text, useMetric) {
  return text.replace(/\{(hPa|dhPa|ms|m|dC):(-?[\d.]+)\}/g, (_, kind, raw) => {
    const v = parseFloat(raw)
    switch (kind) {
      case 'hPa': return U.formatPressure(v, useMetric)
      case 'dhPa': return useMetric ? `${v.toFixed(0)} hPa` : `${(v * 0.02953).toFixed(2)} inHg`
      case 'ms': return useMetric ? `${v.toFixed(0)} m/s` : `${(v * 2.23694).toFixed(0)} mph`
      case 'm': return U.formatWave(v, useMetric)
      case 'dC': return useMetric ? `${v.toFixed(1)} °C` : `${(v * 1.8).toFixed(1)} °F`
      default: return raw
    }
  })
}

function fmtUTC(ts) {
  const d = new Date(ts * 1000)
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' })
  return `${day} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`
}

export default function Stories({ useMetric }) {
  const isNarrow = useIsNarrow()
  const [index, setIndex] = useState(null)
  const [storyId, setStoryId] = useState(null)
  const [story, setStory] = useState(null)
  const [error, setError] = useState(null)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(12)
  const [layer, setLayer] = useState('auto')
  const [x, setX] = useState(0) // playhead, fractional hour index (UI copy)
  const [showMethod, setShowMethod] = useState(false)
  const [panelOpen, setPanelOpen] = useState(!isNarrow)

  const mapEl = useRef(null)
  const mapRef = useRef(null)
  const layersRef = useRef(null)
  const xRef = useRef(0)
  const playingRef = useRef(false)
  const speedRef = useRef(speed)
  const layerRef = useRef(layer)
  const drawRef = useRef(() => {})
  speedRef.current = speed
  layerRef.current = layer

  // ── load ────────────────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/stories/index.json').then((r) => r.json())
      .then((idx) => { setIndex(idx); setStoryId(idx[0]?.id ?? null) })
      .catch((e) => setError(`Could not load stories: ${e}`))
  }, [])
  useEffect(() => {
    if (!storyId) return
    setStory(null); setPlaying(false); xRef.current = 0; setX(0)
    fetch(`/stories/${storyId}.json`).then((r) => r.json()).then(setStory)
      .catch((e) => setError(`Could not load story: ${e}`))
  }, [storyId])

  const n = story?.hours.n ?? 0
  const tsAt = (xi) => (story ? story.hours.t0 + xi * story.hours.step : 0)
  const deepest = story?.stats?.deepest
  // "Story" mode: watch pressure until the low has passed, then the cold wake.
  const autoSwitch = deepest ? deepest.t + 9 * 3600 : Infinity
  const activeLayer = (xi) => (layerRef.current === 'auto'
    ? (tsAt(xi) < autoSwitch ? 'p' : 't') : layerRef.current)

  // ── map setup (once per story) ──────────────────────────────────────────
  useEffect(() => {
    if (!story || !mapEl.current) return
    const map = L.map(mapEl.current, {
      center: story.view.center, zoom: story.view.zoom,
      zoomControl: false, preferCanvas: true, worldCopyJump: false,
    })
    map.attributionControl.setPrefix(false)
    // Default top-left zoom sat on top of the story title; bottom-right instead,
    // lifted clear of the timeline by the .story-map rule below.
    if (!isNarrow) L.control.zoom({ position: 'bottomright' }).addTo(map)
    L.tileLayer(CARTO_TILES, {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com">CARTO</a> · NOAA NDBC',
      subdomains: 'abcd', maxZoom: 12,
    }).addTo(map)
    const renderer = L.canvas({ padding: 0.3 })

    const path = L.polyline([], { color: '#f8fafc', weight: 1.5, opacity: 0.55, dashArray: '4 6', renderer }).addTo(map)
    const cone = L.circle(story.view.center, { radius: 1, color: '#f8fafc', weight: 1, opacity: 0.5, dashArray: '3 5', fillOpacity: 0.05, renderer }).addTo(map)
    const eye = L.circleMarker(story.view.center, { radius: 4, color: '#f8fafc', weight: 2, fillOpacity: 0, renderer }).addTo(map)

    const marks = story.stations.map((s) => {
      const halo = L.circleMarker([s.lat, s.lon], { radius: 8, stroke: false, fillOpacity: 0, renderer, interactive: false }).addTo(map)
      const dot = L.circleMarker([s.lat, s.lon], { radius: 5, weight: 1, color: '#0f172a', fillOpacity: 0.95, renderer }).addTo(map)
      dot.bindTooltip('', { direction: 'top', offset: [0, -6], className: 'story-tip' })
      return { s, halo, dot }
    })
    const callout = L.circleMarker([0, 0], { radius: 18, color: '#fde047', weight: 2, fillOpacity: 0, renderer, interactive: false })
    const calloutTip = L.tooltip({ permanent: true, direction: 'right', offset: [16, 0], className: 'story-callout' })

    mapRef.current = map
    layersRef.current = { path, cone, eye, marks, callout, calloutTip }
    // Frame the buoys in the part of the map the panels leave visible -- a plain
    // centre put the storm behind the narrative panel.
    const fit = () => {
      map.invalidateSize()
      const b = L.latLngBounds(story.stations.map((s) => [s.lat, s.lon]))
      map.fitBounds(b, isNarrow
        ? { paddingTopLeft: [40, 150], paddingBottomRight: [24, 150] }
        : { paddingTopLeft: [372, 24], paddingBottomRight: [24, 84] })
    }
    setTimeout(fit, 0)
    drawRef.current(xRef.current)
    return () => { map.remove(); mapRef.current = null; layersRef.current = null }
  }, [story]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── per-frame drawing (imperative; React only renders the panels) ──────
  function draw(xi) {
    const ly = layersRef.current
    if (!ly || !story) return
    const lay = activeLayer(xi)
    const now = tsAt(xi)
    for (const { s, halo, dot } of ly.marks) {
      const p = sample(s.frames.p, xi)
      const t = sample(s.frames.t, xi)
      const g = sample(s.frames.g, xi)
      const w = sample(s.frames.w, xi)
      const st = styleFor(lay, p, t, g)
      const r = radiusFor(g, w)
      // A buoy without the current variable (46035 has wind but no barometer)
      // is a hollow ring, still sized by its gust -- visible, and honestly empty,
      // rather than a vanishing dot an annotation can end up circling.
      if (st.missing) dot.setStyle({ fillOpacity: 0, color: '#94a3b8', opacity: 0.7, weight: 1.5 })
      else dot.setStyle({ fillColor: st.color, fillOpacity: 0.95, color: '#0f172a', opacity: 1, weight: 1 })
      dot.setRadius(r)
      halo.setStyle({ fillColor: st.color, fillOpacity: Math.min(0.45, st.strength * 0.5) })
      halo.setRadius(r * (1.8 + st.strength * 1.6))
      if (dot.isTooltipOpen()) dot.setTooltipContent(tipHtml(s, p, t, g))
      else dot.getTooltip().setContent(tipHtml(s, p, t, g))
    }
    // track drawn up to the playhead
    const past = story.track.filter((c) => c.t <= now)
    ly.path.setLatLngs(past.map((c) => [c.lat, c.lon]))
    const cur = past[past.length - 1]
    const live = cur && now - cur.t <= 2 * 3600
    ly.cone.setStyle({ opacity: live ? 0.5 : 0, fillOpacity: live ? 0.05 : 0 })
    ly.eye.setStyle({ opacity: live ? 0.9 : 0 })
    if (cur) { ly.cone.setLatLng([cur.lat, cur.lon]); ly.cone.setRadius(cur.r_km * 1000); ly.eye.setLatLng([cur.lat, cur.lon]) }
    // event callout
    const ev = [...story.events].reverse().find((e) => e.t <= now && now < e.t + EVENT_SHOW_HOURS * 3600)
    const m = ev && ly.marks.find((mk) => mk.s.id === ev.station)
    if (m) {
      ly.callout.setLatLng([m.s.lat, m.s.lon]).addTo(mapRef.current)
      ly.calloutTip.setLatLng([m.s.lat, m.s.lon]).setContent(isNarrow ? ev.station : formatTokens(ev.text, useMetric))
      if (!mapRef.current.hasLayer(ly.calloutTip)) ly.calloutTip.addTo(mapRef.current)
    } else {
      ly.callout.remove(); ly.calloutTip.remove()
    }
  }

  drawRef.current = draw

  function tipHtml(s, p, t, g) {
    const f = (v, d) => (v == null ? '—' : v.toFixed(d))
    const pd = U.convertDelta(p, 'pressure', useMetric)
    const td = U.convertDelta(t, 'temp', useMetric)
    const gd = U.convert(g, 'wind', useMetric)
    return `<b>${s.id}</b> ${s.name}<br/>pressure ${f(pd, useMetric ? 1 : 2)} ${U.unitLabel('pressure', useMetric)} vs normal`
      + `<br/>sea temp ${f(td, 2)} ${U.unitLabel('temp', useMetric)} vs trend`
      + `<br/>gust ${f(gd, 0)} ${U.unitLabel('wind', useMetric)}`
  }

  // ── animation loop ──────────────────────────────────────────────────────
  useEffect(() => { playingRef.current = playing }, [playing])
  useEffect(() => {
    if (!story) return
    let raf; let last = performance.now(); let lastUi = -1
    const tick = (nowMs) => {
      const dt = (nowMs - last) / 1000
      last = nowMs
      if (playingRef.current) {
        let nx = xRef.current + dt * speedRef.current
        if (nx >= n - 1) { nx = n - 1; playingRef.current = false; setPlaying(false) }
        xRef.current = nx
        drawRef.current(nx)
      }
      const q = Math.floor(xRef.current * 4) / 4
      if (q !== lastUi) { lastUi = q; setX(q) }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [story, n]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { drawRef.current(xRef.current) }, [layer, useMetric])

  const seek = (xi) => {
    const v = Math.max(0, Math.min(n - 1, xi))
    xRef.current = v; setX(v); drawRef.current(v)
  }
  const togglePlay = () => {
    if (!playing && xRef.current >= n - 1) seek(0)
    setPlaying((p) => !p)
  }

  // ── derived UI state ────────────────────────────────────────────────────
  const now = tsAt(x)
  const lay = story ? activeLayer(x) : 'p'
  const current = story ? [...story.events].reverse().find((e) => e.t <= now) : null
  const statChips = useMemo(() => {
    if (!story) return []
    const s = story.stats
    const out = []
    if (s.deepest) out.push(['Deepest', U.formatPressure(s.deepest.hPa, useMetric)])
    if (s.fastestFall24h) out.push(['24h fall', `${U.convertDelta(s.fastestFall24h.hPa, 'pressure', useMetric).toFixed(useMetric ? 0 : 2)} ${U.unitLabel('pressure', useMetric)}`])
    if (s.peakGust) out.push(['Gust at sea', U.formatWind(s.peakGust.value, useMetric)])
    if (s.peakWave) out.push(['Seas', U.formatWave(s.peakWave.value, useMetric)])
    if (s.coldWake?.[0]) out.push(['Cold wake', `${U.convertDelta(s.coldWake[0].coolingC, 'temp', useMetric).toFixed(1)} ${U.unitLabel('temp', useMetric)}`])
    return out
  }, [story, useMetric])

  if (error) return <div className="loading-veil" style={{ color: 'var(--color-error)' }}>{error}</div>
  if (!story) return <div className="loading-veil">Loading story…</div>

  const legend = lay === 'p'
    ? { title: `Pressure below the buoy's own normal`, stops: P_STOPS, lo: '0', hi: `−${useMetric ? P_FULL : (P_FULL * 0.02953).toFixed(1)} ${U.unitLabel('pressure', useMetric)}` }
    : lay === 't'
      ? { title: 'Sea temperature below its seasonal trend', stops: COLD_STOPS, lo: '0', hi: `−${U.convertDelta(T_FULL, 'temp', useMetric).toFixed(1)} ${U.unitLabel('temp', useMetric)}` }
      : { title: 'Gust speed', stops: G_STOPS, lo: '0', hi: `${U.convert(G_FULL, 'wind', useMetric).toFixed(0)} ${U.unitLabel('wind', useMetric)}` }
  const gradient = `linear-gradient(90deg, ${legend.stops.map(([p, c]) => `${c} ${p * 100}%`).join(', ')})`

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <style>{`
        .story-tip { background: var(--color-surface); color: var(--color-text); border: 1px solid var(--color-border); font: 11px var(--font-mono); }
        .story-callout { background: rgba(15,23,42,0.92); color: #fde047; border: 1px solid #fde047; font: 600 12px/1.35 system-ui, sans-serif; width: ${isNarrow ? 'auto' : '240px'}; white-space: ${isNarrow ? 'nowrap' : 'normal'}; box-shadow: 0 0 24px rgba(253,224,71,0.25); }
        .story-map .leaflet-bottom.leaflet-right { margin-bottom: 76px; }
        .story-callout::before { display: none; }
        .story-panel { position: absolute; z-index: 500; background: rgba(15,23,42,0.88); backdrop-filter: blur(6px); border: 1px solid var(--color-border); border-radius: 8px; color: var(--color-text); }
        .story-ev { display: block; width: 100%; text-align: left; background: none; border: none; padding: 0.35rem 0.25rem; cursor: pointer; font: 12px/1.35 system-ui, sans-serif; border-left: 2px solid transparent; }
        .story-ev:hover { background: rgba(148,163,184,0.08); }
      `}</style>
      <div ref={mapEl} className="story-map" style={{ position: 'absolute', inset: 0, background: '#0b1220' }} />

      {/* Narrative panel */}
      <div className="story-panel" style={isNarrow
        ? { top: 8, left: 8, right: 8, padding: '0.6rem 0.75rem', maxHeight: panelOpen ? '55%' : 'auto', overflowY: 'auto' }
        : { top: 12, left: 12, width: 340, maxHeight: 'calc(100% - 120px)', overflowY: 'auto', padding: '0.9rem 1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 8 }}>
          <div>
            <div style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--color-text-bright)' }}>{story.title}</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--color-text-dim)', marginTop: 2 }}>{story.subtitle}</div>
          </div>
          {isNarrow && (
            <button className="btn" onClick={() => setPanelOpen((o) => !o)} style={{ padding: '0.2rem 0.5rem' }}>{panelOpen ? '▴' : '▾'}</button>
          )}
        </div>

        {index && index.length > 1 && (
          <select value={storyId} onChange={(e) => setStoryId(e.target.value)} className="input" style={{ marginTop: 8, width: '100%' }}>
            {index.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
        )}

        <div className="mono" style={{ fontSize: '1.35rem', marginTop: 10, color: 'var(--color-text-bright)' }}>{fmtUTC(now)}</div>
        <div style={{ fontSize: '0.875rem', lineHeight: 1.45, marginTop: 6, minHeight: '2.6em', color: current ? '#fde047' : 'var(--color-text)' }}>
          {current ? formatTokens(current.text, useMetric) : story.intro}
        </div>

        {(panelOpen || !isNarrow) && (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
              {statChips.map(([k, v]) => (
                <span key={k} className="count-chip" title={k}><span style={{ color: 'var(--color-text-dim)' }}>{k}</span> {v}</span>
              ))}
            </div>

            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-dim)', marginBottom: 4 }}>{legend.title}</div>
              <div style={{ height: 8, borderRadius: 4, background: gradient }} />
              <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.625rem', color: 'var(--color-text-dim)', marginTop: 2 }}>
                <span>{legend.lo}</span><span>{legend.hi}</span>
              </div>
              <div style={{ fontSize: '0.625rem', color: 'var(--color-text-dim)', marginTop: 4 }}>
                Dot size = gust. Hollow = this buoy doesn&apos;t measure the variable shown. Dashed ring = where the network felt the storm most, with its uncertainty.
              </div>
            </div>

            <div style={{ marginTop: 12, borderTop: '1px solid var(--color-border)', paddingTop: 8 }}>
              {story.events.map((e) => {
                const passed = e.t <= now
                const isCur = current && e === current
                return (
                  <button key={`${e.t}-${e.kind}`} className="story-ev"
                    onClick={() => { setPlaying(false); seek((e.t - story.hours.t0) / story.hours.step - 3) }}
                    style={{ color: isCur ? '#fde047' : passed ? 'var(--color-text)' : 'var(--color-text-dim)',
                      borderLeftColor: isCur ? '#fde047' : 'transparent', opacity: passed ? 1 : 0.6 }}>
                    <span className="mono" style={{ fontSize: '0.6875rem', color: 'var(--color-text-dim)' }}>{fmtUTC(e.t)}</span><br />{formatTokens(e.text, useMetric)}
                  </button>
                )
              })}
            </div>

            <button className="btn" onClick={() => setShowMethod((v) => !v)} style={{ marginTop: 8, fontSize: '0.6875rem', padding: '0.25rem 0.5rem' }}>
              {showMethod ? 'Hide' : 'How to read this'}
            </button>
            {showMethod && (
              <div style={{ fontSize: '0.6875rem', lineHeight: 1.5, color: 'var(--color-text-dim)', marginTop: 6 }}>
                <p style={{ margin: '0 0 6px' }}>Each dot is a real instrument. Colours show its deviation from <i>its own</i> normal, so a mis-calibrated barometer cannot pose as a storm. Nothing is drawn between buoys: that ocean was not measured.</p>
                <p style={{ margin: '0 0 6px' }}>Sea temperature is compared with each buoy&apos;s seasonal trend, fitted over the two weeks before the storm, because northern water cools through autumn on its own. The cold wake is cooling beyond that trend.</p>
                <p style={{ margin: 0 }}>The track is a weighted centre of the deepest buoys each hour. It always lies inside the network, so if the true low crossed open water it shows the nearest edge. {story.excluded.length ? `${story.excluded.length} readings were excluded as faults.` : 'No readings were excluded as faults.'}</p>
              </div>
            )}
          </>
        )}
      </div>

      {/* Layer switch */}
      <div className="story-panel" style={{ top: isNarrow ? 'auto' : 12, bottom: isNarrow ? 92 : 'auto', right: 12, padding: 4, display: 'flex', gap: 2 }}>
        {LAYERS.map(([k, label]) => (
          <button key={k} className={`btn${layer === k ? ' btn-amber' : ''}`} onClick={() => setLayer(k)}
            style={{ padding: '0.3rem 0.55rem', fontSize: '0.75rem' }}>{label}</button>
        ))}
      </div>

      {/* Timeline */}
      <div className="story-panel" style={{ left: isNarrow ? 8 : 364, right: isNarrow ? 8 : 12, bottom: 12, padding: '0.6rem 0.8rem', display: 'flex', alignItems: 'center', gap: 10 }}>
        <button className="btn btn-amber" onClick={togglePlay} style={{ minWidth: 72 }}>
          {playing ? '❚❚ Pause' : (x >= n - 1 ? '↺ Replay' : '▶ Play')}
        </button>
        <div style={{ position: 'relative', flex: 1, height: 28 }}>
          {story.events.map((e) => (
            <div key={`tick-${e.t}-${e.kind}`} title={formatTokens(e.text, useMetric)}
              style={{ position: 'absolute', top: 0, width: 2, height: 8, background: '#fde047', opacity: 0.8,
                left: `${((e.t - story.hours.t0) / story.hours.step) / (n - 1) * 100}%` }} />
          ))}
          <input type="range" min={0} max={n - 1} step={0.25} value={x}
            onChange={(e) => { setPlaying(false); seek(parseFloat(e.target.value)) }}
            style={{ position: 'absolute', left: 0, right: 0, top: 10, width: '100%', accentColor: '#fde047' }} />
        </div>
        {!isNarrow && (
          <div style={{ display: 'flex', gap: 2 }}>
            {SPEEDS.map((s) => (
              <button key={s} className={`btn${speed === s ? ' btn-amber' : ''}`} onClick={() => setSpeed(s)}
                style={{ padding: '0.25rem 0.45rem', fontSize: '0.6875rem' }} title={`${s} story hours per second`}>{s}h/s</button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
