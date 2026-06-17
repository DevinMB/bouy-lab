import React, { useEffect, useRef, useState, lazy, Suspense } from 'react'
import { thermalColor } from '../thermal'
import { pointInPolygon } from '../geo'
import FilterRail from './FilterRail'

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

function createMarkerIcon(color, size = 10) {
  return L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:1.5px solid rgba(255,255,255,0.35);"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

function createClusterIcon(cluster) {
  const childMarkers = cluster.getAllChildMarkers()
  const temps = childMarkers
    .map((m) => m.options._buoyData?.latest?.waterTempC)
    .filter((t) => t != null)
  const mean = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null
  const color = thermalColor(mean)
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

export default function MapView({ buoys, useMetric, selectedBuoy, onSelectBuoy, onNearbyRequest, researchRegion, onRegionChange, onOpenResearch }) {
  const mapRef = useRef(null)
  const mapInstanceRef = useRef(null)
  const clusterGroupRef = useRef(null)
  const markersRef = useRef({})
  const regionLayerRef = useRef(null)
  const [filters, setFilters] = useState({ text: '', streams: [], reportingOnly: false })
  const [drawing, setDrawing] = useState(false)

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

    // Add/update markers
    visible.forEach((buoy) => {
      if (buoy.lat == null || buoy.lon == null) return
      const color = thermalColor(buoy.latest?.waterTempC)

      if (!markersRef.current[buoy.id]) {
        const marker = L.marker([buoy.lat, buoy.lon], {
          icon: createMarkerIcon(color),
          _buoyData: buoy,
        })
        marker.on('click', () => onSelectBuoy(buoy))
        markersRef.current[buoy.id] = marker
        clusterGroup.addLayer(marker)
      } else {
        markersRef.current[buoy.id].options._buoyData = buoy
        markersRef.current[buoy.id].setIcon(createMarkerIcon(color))
      }
    })
  }, [buoys, filters])

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

  // Freehand lasso: mousedown starts the path, drag traces it, mouseup commits.
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !drawing) return
    map.dragging.disable()
    let pts = null
    let temp = null
    const onDown = (e) => {
      pts = [[e.latlng.lat, e.latlng.lng]]
      temp = L.polyline(pts, { color: '#ffb627', weight: 1.75, dashArray: '4' }).addTo(map)
    }
    const onMove = (e) => {
      if (!pts || !temp) return
      const last = pts[pts.length - 1]
      // Skip near-duplicate points to keep the path light.
      if (Math.abs(last[0] - e.latlng.lat) + Math.abs(last[1] - e.latlng.lng) < 0.02) return
      pts.push([e.latlng.lat, e.latlng.lng])
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
    map.on('mousedown', onDown)
    map.on('mousemove', onMove)
    map.on('mouseup', onUp)
    return () => {
      map.off('mousedown', onDown)
      map.off('mousemove', onMove)
      map.off('mouseup', onUp)
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

      {/* Research region control */}
      <div style={{ position: 'absolute', top: '0.75rem', right: '0.75rem', zIndex: 400, width: 200 }}>
        <div style={{ background: 'rgba(13, 33, 41, 0.92)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '0.625rem 0.75rem', backdropFilter: 'blur(6px)', fontSize: '0.6875rem' }}>
          <div style={{ textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-text-dim)', marginBottom: '0.5rem' }}>Research Region</div>
          {drawing ? (
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

      {/* Filter rail */}
      <div style={{ position: 'absolute', top: '0.75rem', left: '0.75rem', width: 220, maxHeight: 'calc(100% - 1.5rem)', overflowY: 'auto', zIndex: 400 }}>
        <FilterRail
          buoys={buoys}
          filters={filters}
          onFiltersChange={setFilters}
          useMetric={useMetric}
        />
      </div>

      {/* Detail panel */}
      {selectedBuoy && (
        <Suspense fallback={null}>
          <DetailPanel
            buoy={selectedBuoy}
            useMetric={useMetric}
            onClose={() => onSelectBuoy(null)}
            onNearbyRequest={onNearbyRequest}
          />
        </Suspense>
      )}
    </div>
  )
}
