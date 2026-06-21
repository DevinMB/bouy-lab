import React, { useEffect, useRef, useState, lazy, Suspense } from 'react'
import { thermalColor } from '../thermal'
import { corrColor, corrGradient } from '../correlation'
import { pointInPolygon } from '../geo'
import { useIsNarrow } from '../hooks'
import FilterRail from './FilterRail'

// Active correlation overlay (module-scoped so the cluster icon function, which
// is registered once at map init, can read the current value). null = off.
let _overlay = null

// Leaflet and leaflet.markercluster are loaded from CDN via synchronous <script>
// tags in index.html — they run before this ES-module bundle, so window.L is
// fully initialized (including markerClusterGroup) when this module evaluates.
const L = window.L

const DetailPanel = lazy(() => import('./DetailPanel'))

const NOW = () => Date.now() / 1000
const FRESH_SECS = 24 * 3600

function isRecent(buoy) {
  const obs = buoy.latest?.observedAt
  if (!obs) return false
  try {
    const ts = new Date(obs).getTime() / 1000
    return NOW() - ts < FRESH_SECS
  } catch {
    return false
  }
}

function createMarkerIcon(color, size = 10, ring = false) {
  const border = ring ? '2.5px solid #fff' : '1.5px solid rgba(255,255,255,0.35)'
  const glow = ring ? 'box-shadow:0 0 6px 2px rgba(255,255,255,0.55);' : ''
  return L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:${border};${glow}"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

function createClusterIcon(cluster) {
  const childMarkers = cluster.getAllChildMarkers()
  let color
  if (_overlay) {
    const rs = childMarkers.map((m) => _overlay.byId[m.options._buoyData?.id]).filter((r) => r != null)
    const mean = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null
    color = corrColor(mean)
  } else {
    const temps = childMarkers
      .map((m) => m.options._buoyData?.latest?.waterTempC)
      .filter((t) => t != null)
    const mean = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null
    color = thermalColor(mean)
  }
  const count = cluster.getChildCount()
  const size = count < 10 ? 30 : count < 50 ? 36 : 42
  return L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid rgba(255,255,255,0.4);display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);font-size:11px;color:rgba(255,255,255,0.9);">${count}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

function applyFilters(buoys, filters) {
  return buoys.filter((b) => {
    if (filters.text) {
      const q = filters.text.toLowerCase()
      if (!b.id.toLowerCase().includes(q) && !(b.name || '').toLowerCase().includes(q)) return false
    }
    if (filters.streams?.length) {
      if (!filters.streams.some((s) => b.available?.includes(s))) return false
    }
    if (filters.reportingOnly) {
      if (!isRecent(b)) return false
    }
    return true
  })
}

export default function MapView({ buoys, useMetric, selectedBuoy, onSelectBuoy, onNearbyRequest, researchRegion, onRegionChange, onOpenResearch, correlationOverlay, onExitOverlay, autoLocate, propagationOverlay, onShowPropagationMap, onOpenPropagation }) {
  const mapRef = useRef(null)
  const mapInstanceRef = useRef(null)
  const clusterGroupRef = useRef(null)
  const markersRef = useRef({})
  const regionLayerRef = useRef(null)
  const propagationLayerRef = useRef(null)
  const [filters, setFilters] = useState({ text: '', streams: [], reportingOnly: false })
  const [drawing, setDrawing] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false) // mobile drawer toggle
  const isNarrow = useIsNarrow()

  // Initialize map once
  useEffect(() => {
    if (mapInstanceRef.current) return
    const map = L.map(mapRef.current, {
      center: [30, -60],
      zoom: 4,
      zoomControl: false,
    })
    // Bottom-left keeps the zoom buttons clear of the FilterRail (top-left)
    // and the attribution control (bottom-right).
    L.control.zoom({ position: 'bottomleft' }).addTo(map)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://carto.com">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(map)

    const clusterGroup = L.markerClusterGroup({
      iconCreateFunction: createClusterIcon,
      maxClusterRadius: 40,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
    })
    map.addLayer(clusterGroup)

    mapInstanceRef.current = map
    clusterGroupRef.current = clusterGroup

    // Center near the user's location if available (secure context only — works
    // over the Cloudflare tunnel / localhost). Falls back to the default view.
    if (autoLocate && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (mapInstanceRef.current) {
            mapInstanceRef.current.setView([pos.coords.latitude, pos.coords.longitude], 6)
          }
        },
        () => {},
        { timeout: 8000, maximumAge: 600000 },
      )
    }

    return () => {
      map.remove()
      mapInstanceRef.current = null
    }
  }, [])

  // Update markers when buoys or filters change
  useEffect(() => {
    const clusterGroup = clusterGroupRef.current
    if (!clusterGroup) return

    const visible = applyFilters(buoys, filters)
    const visibleIds = new Set(visible.map((b) => b.id))

    // Remove markers not in visible set
    Object.keys(markersRef.current).forEach((id) => {
      if (!visibleIds.has(id)) {
        clusterGroup.removeLayer(markersRef.current[id])
        delete markersRef.current[id]
      }
    })

    // Add/update markers. When a correlation overlay is active, color by r and
    // ring the reference buoy; otherwise color by water temperature.
    const ov = correlationOverlay
    const prop = propagationOverlay
    visible.forEach((buoy) => {
      if (buoy.lat == null || buoy.lon == null) return
      const isRef = ov && buoy.id === ov.refId
      const ringed = isRef || (prop && buoy.id === prop.targetId)
      const color = ov
        ? (isRef ? '#ffffff' : corrColor(ov.byId[buoy.id]))
        : thermalColor(buoy.latest?.waterTempC)
      const icon = createMarkerIcon(color, ringed ? 14 : 10, ringed)

      if (!markersRef.current[buoy.id]) {
        const marker = L.marker([buoy.lat, buoy.lon], { icon, _buoyData: buoy })
        marker.on('click', () => onSelectBuoy(buoy))
        markersRef.current[buoy.id] = marker
        clusterGroup.addLayer(marker)
      } else {
        markersRef.current[buoy.id].options._buoyData = buoy
        markersRef.current[buoy.id].setIcon(icon)
      }
    })
  }, [buoys, filters, correlationOverlay, propagationOverlay])

  // Keep the module-scoped overlay in sync and recolor existing clusters.
  useEffect(() => {
    _overlay = correlationOverlay || null
    const cg = clusterGroupRef.current
    if (cg && cg.refreshClusters) cg.refreshClusters()
  }, [correlationOverlay])

  // Draw propagation arrows (leader → target) when that overlay is active.
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map) return
    if (!propagationLayerRef.current) {
      propagationLayerRef.current = L.layerGroup().addTo(map)
    }
    const layer = propagationLayerRef.current
    layer.clearLayers()
    const prop = propagationOverlay
    if (prop && prop.target && prop.target.lat != null) {
      const t = [prop.target.lat, prop.target.lon]
      prop.leaders.forEach((ldr) => {
        if (ldr.lat == null || ldr.lon == null) return
        const a = [ldr.lat, ldr.lon]
        const color = corrColor(ldr.r)
        const weight = 1.5 + 3 * Math.min(1, Math.abs(ldr.r))
        L.polyline([a, t], { color, weight, opacity: 0.85 }).addTo(layer)
        const mid = [a[0] + (t[0] - a[0]) * 0.62, a[1] + (t[1] - a[1]) * 0.62]
        L.marker(mid, {
          interactive: false,
          icon: L.divIcon({
            className: '',
            html: `<div style="transform:translate(-50%,-50%);background:rgba(8,19,24,0.92);border:1px solid ${color};border-radius:8px;padding:0 4px;font-family:var(--font-mono);font-size:10px;color:#e8f4f8;white-space:nowrap;">+${ldr.lagHours}h</div>`,
            iconSize: [0, 0],
          }),
        }).addTo(layer)
      })
    }
  }, [propagationOverlay])

  // Fly to selected buoy
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !selectedBuoy) return
    if (selectedBuoy.lat != null && selectedBuoy.lon != null) {
      // Never zoom out on select — keep the current zoom, only zoom in if the
      // user is far out, so the buoy stays in a recognizable context.
      const targetZoom = Math.max(map.getZoom(), 9)
      map.flyTo([selectedBuoy.lat, selectedBuoy.lon], targetZoom, { duration: 1.2 })
    }
  }, [selectedBuoy?.id])

  // Draw the persistent research-region polygon from shared state.
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map) return
    if (regionLayerRef.current) {
      map.removeLayer(regionLayerRef.current)
      regionLayerRef.current = null
    }
    if (researchRegion?.points?.length >= 3) {
      regionLayerRef.current = L.polygon(researchRegion.points, {
        color: '#ffb627', weight: 1.5, fillColor: '#ffb627', fillOpacity: 0.07,
      }).addTo(map)
    }
  }, [researchRegion])

  // Freehand lasso via pointer events (so it works with both mouse and touch):
  // pointerdown starts the path, drag traces it, pointerup commits.
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !drawing) return
    const container = map.getContainer()
    map.dragging.disable()
    let pts = null
    let temp = null
    const toLatLng = (ev) => {
      const rect = container.getBoundingClientRect()
      return map.containerPointToLatLng(L.point(ev.clientX - rect.left, ev.clientY - rect.top))
    }
    const onDown = (ev) => {
      ev.preventDefault()
      container.setPointerCapture?.(ev.pointerId)
      const ll = toLatLng(ev)
      pts = [[ll.lat, ll.lng]]
      temp = L.polyline(pts, { color: '#ffb627', weight: 1.75, dashArray: '4' }).addTo(map)
    }
    const onMove = (ev) => {
      if (!pts || !temp) return
      const ll = toLatLng(ev)
      const last = pts[pts.length - 1]
      // Skip near-duplicate points to keep the path light.
      if (Math.abs(last[0] - ll.lat) + Math.abs(last[1] - ll.lng) < 0.02) return
      pts.push([ll.lat, ll.lng])
      temp.setLatLngs(pts)
    }
    const onUp = () => {
      if (temp) { map.removeLayer(temp); temp = null }
      if (pts && pts.length >= 3) {
        onRegionChange({ type: 'polygon', points: pts })
      }
      pts = null
      setDrawing(false)
    }
    container.addEventListener('pointerdown', onDown)
    container.addEventListener('pointermove', onMove)
    container.addEventListener('pointerup', onUp)
    return () => {
      container.removeEventListener('pointerdown', onDown)
      container.removeEventListener('pointermove', onMove)
      container.removeEventListener('pointerup', onUp)
      if (temp) map.removeLayer(temp)
      map.dragging.enable()
    }
  }, [drawing])

  const regionCount = researchRegion?.points?.length >= 3
    ? buoys.filter((b) => b.lat != null && b.lon != null
        && pointInPolygon(b.lat, b.lon, researchRegion.points)).length
    : 0

  return (
    <div style={{ position: 'relative', height: '100%' }}>
      <div ref={mapRef} style={{ position: 'absolute', inset: 0, cursor: drawing ? 'crosshair' : '' }} />

      {/* Correlation overlay banner + legend */}
      {correlationOverlay && (
        <div style={{ position: 'absolute', top: '0.75rem', left: '50%', transform: 'translateX(-50%)', zIndex: 600, width: 280, maxWidth: 'calc(100% - 1.5rem)', background: 'rgba(13,33,41,0.95)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '0.625rem 0.75rem', backdropFilter: 'blur(6px)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.5rem' }}>
            <div style={{ fontSize: '0.6875rem', color: 'var(--color-text)' }}>
              Correlation vs <b className="mono" style={{ color: 'var(--color-text-bright)' }}>{correlationOverlay.refName || correlationOverlay.refId}</b>
              <div style={{ color: 'var(--color-text-dim)' }}>{correlationOverlay.label}</div>
            </div>
            <button className="btn" style={{ padding: '0.2rem 0.55rem', flex: 'none' }} onClick={onExitOverlay}>Exit</button>
          </div>
          <div style={{ height: 8, borderRadius: 4, background: corrGradient(), marginTop: '0.5rem' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.625rem', fontFamily: 'var(--font-mono)', color: 'var(--color-text-dim)', marginTop: '0.2rem' }}>
            <span>−1 inverse</span><span>0</span><span>+1 together</span>
          </div>
        </div>
      )}

      {/* Propagation overlay banner */}
      {propagationOverlay && (
        <div style={{ position: 'absolute', top: '0.75rem', left: '50%', transform: 'translateX(-50%)', zIndex: 600, width: 300, maxWidth: 'calc(100% - 1.5rem)', background: 'rgba(13,33,41,0.95)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '0.625rem 0.75rem', backdropFilter: 'blur(6px)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.5rem' }}>
            <div style={{ fontSize: '0.6875rem', color: 'var(--color-text)' }}>
              Propagation → <b className="mono" style={{ color: 'var(--color-text-bright)' }}>{propagationOverlay.targetName || propagationOverlay.targetId}</b>
              <div style={{ color: 'var(--color-text-dim)' }}>{propagationOverlay.label} · arrows from upstream leaders</div>
            </div>
            <button className="btn" style={{ padding: '0.2rem 0.55rem', flex: 'none' }} onClick={onExitOverlay}>Exit</button>
          </div>
          <div style={{ fontSize: '0.625rem', color: 'var(--color-text-dim)', fontFamily: 'var(--font-mono)', marginTop: '0.4rem' }}>
            line color = correlation · label = lead time to target
          </div>
        </div>
      )}

      {/* Mobile-only toggle for the controls drawer. Hidden while a buoy detail
          is open, since that panel goes full-screen on mobile. */}
      {!selectedBuoy && (
        <button className="map-controls-toggle" onClick={() => setFiltersOpen((o) => !o)} aria-label="Toggle controls">
          {filtersOpen ? '✕' : '☰'} Filters
        </button>
      )}
      {filtersOpen && !selectedBuoy && <div className="map-backdrop" onClick={() => setFiltersOpen(false)} />}

      {/* Left control column: filter rail + research region (drawer on mobile).
          Kept on the left so the right-side detail panel never covers it. */}
      <div className={`map-overlay-left${filtersOpen && !selectedBuoy ? ' open' : ''}`} style={{ position: 'absolute', top: '0.75rem', left: '0.75rem', width: 220, maxHeight: 'calc(100% - 1.5rem)', overflowY: 'auto', zIndex: 400, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <FilterRail
          buoys={buoys}
          filters={filters}
          onFiltersChange={setFilters}
          useMetric={useMetric}
        />

        {/* Research region control */}
        <div style={{ background: 'rgba(13, 33, 41, 0.92)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '0.625rem 0.75rem', backdropFilter: 'blur(6px)', fontSize: '0.6875rem' }}>
          <div style={{ textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-text-dim)', marginBottom: '0.5rem' }}>Research Region</div>
          {isNarrow ? (
            <div style={{ color: 'var(--color-text-dim)' }}>Region drawing is available on <b style={{ color: 'var(--color-text)' }}>desktop only</b> — it needs a larger screen to lasso an area.</div>
          ) : drawing ? (
            <>
              <div style={{ color: 'var(--color-amber)', marginBottom: '0.5rem' }}>Click &amp; drag to lasso an area on the map…</div>
              <button className="btn" style={{ width: '100%', justifyContent: 'center' }} onClick={() => setDrawing(false)}>Cancel</button>
            </>
          ) : researchRegion?.points?.length >= 3 ? (
            <>
              <div className="mono" style={{ color: 'var(--color-text-bright)', marginBottom: '0.4rem' }}>
                {regionCount} buoys in selection
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={onOpenResearch}>Open in Research →</button>
                <div style={{ display: 'flex', gap: '0.35rem' }}>
                  <button className="btn" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setDrawing(true)}>Redraw</button>
                  <button className="btn" style={{ flex: 1, justifyContent: 'center' }} onClick={() => onRegionChange(null)}>Clear</button>
                </div>
              </div>
            </>
          ) : (
            <>
              <div style={{ color: 'var(--color-text-dim)', marginBottom: '0.5rem' }}>Lasso an area to analyze a localized trend.</div>
              <button className="btn" style={{ width: '100%', justifyContent: 'center' }} onClick={() => setDrawing(true)}>✏ Draw region</button>
            </>
          )}
        </div>
      </div>

      {/* Detail panel */}
      {selectedBuoy && (
        <Suspense fallback={null}>
          <DetailPanel
            buoy={selectedBuoy}
            useMetric={useMetric}
            onClose={() => onSelectBuoy(null)}
            onNearbyRequest={onNearbyRequest}
            onShowPropagationMap={onShowPropagationMap}
            onOpenPropagation={onOpenPropagation}
          />
        </Suspense>
      )}
    </div>
  )
}
