import React, { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { fetchBuoys, fetchStats } from './api'

const MapView = lazy(() => import('./components/MapView'))
const Operations = lazy(() => import('./components/Operations'))
const Nearby = lazy(() => import('./components/Nearby'))
const Research = lazy(() => import('./components/Research'))

const REFRESH_INTERVAL = 60_000

// Deep-link routing: /buoy/<id> opens that buoy. nginx SPA fallback serves
// index.html for these paths, so no server route is needed.
function buoyIdFromPath() {
  const m = window.location.pathname.match(/^\/buoy\/([^/]+)/)
  return m ? decodeURIComponent(m[1]) : null
}

export default function App() {
  const [tab, setTab] = useState('map')
  const [buoys, setBuoys] = useState([])
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [useMetric, setUseMetric] = useState(false)
  const [selectedBuoy, setSelectedBuoy] = useState(null)
  const [nearbyOrigin, setNearbyOrigin] = useState(null)
  const [researchRegion, setResearchRegion] = useState(null)
  const [researchScope, setResearchScope] = useState('network')
  const [correlationOverlay, setCorrelationOverlay] = useState(null)
  const [propagationOverlay, setPropagationOverlay] = useState(null)
  const [propagationRequest, setPropagationRequest] = useState(null)
  const statsLoadedRef = useRef(false)
  const deepLinkId = useRef(buoyIdFromPath())
  // Auto-center on the user's location at load, unless they opened a shared buoy link.
  const autoLocate = useRef(!buoyIdFromPath())

  const loadBuoys = async () => {
    try {
      const data = await fetchBuoys(true)
      setBuoys(data)
    } catch (e) {
      console.error('Failed to fetch buoys:', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadBuoys()
    const id = setInterval(loadBuoys, REFRESH_INTERVAL)
    return () => clearInterval(id)
  }, [])

  // Open the deep-linked buoy once the buoy list is available (run once).
  useEffect(() => {
    if (!deepLinkId.current || !buoys.length) return
    const match = buoys.find((b) => b.id === deepLinkId.current)
    deepLinkId.current = null
    if (match) {
      setSelectedBuoy(match)
      setTab('map')
    }
  }, [buoys])

  // Keep the URL in sync with the selected buoy so it can be shared / bookmarked.
  useEffect(() => {
    const path = selectedBuoy ? `/buoy/${encodeURIComponent(selectedBuoy.id)}` : '/'
    if (window.location.pathname !== path) {
      window.history.pushState({}, '', path)
    }
  }, [selectedBuoy?.id])

  // Sync selection when the user navigates with the browser back/forward buttons.
  useEffect(() => {
    const onPop = () => {
      const id = buoyIdFromPath()
      const match = id ? buoys.find((b) => b.id === id) : null
      setSelectedBuoy(match || null)
      if (match) setTab('map')
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [buoys])

  useEffect(() => {
    if (tab === 'operations' && !statsLoadedRef.current) {
      statsLoadedRef.current = true
      fetchStats().then(setStats).catch(console.error)
    }
  }, [tab])

  const handleNearbyRequest = (origin) => {
    setNearbyOrigin(origin)
    setTab('nearby')
  }

  const handleSelectBuoy = (buoy) => {
    setSelectedBuoy(buoy)
    setTab('map')
  }

  const handleShowCorrelationMap = (payload) => {
    const byId = {}
    ;(payload.results || []).forEach((r) => { byId[r.id] = r.r })
    setPropagationOverlay(null) // overlays are mutually exclusive
    setCorrelationOverlay({ refId: payload.ref, refName: payload.refName, label: payload.label, byId })
    setSelectedBuoy(null)
    setTab('map')
  }

  const handleShowPropagationMap = (payload) => {
    setCorrelationOverlay(null) // overlays are mutually exclusive
    setPropagationOverlay(payload)
    setSelectedBuoy(null)
    setTab('map')
  }

  const exitOverlays = () => {
    setCorrelationOverlay(null)
    setPropagationOverlay(null)
  }

  // Open the Research → Propagation page for a buoy (preselected + auto-computed).
  const handleOpenPropagation = (req) => {
    setPropagationRequest(req)
    setTab('research')
  }

  const reporting = buoys.filter((b) => b.latest?.waterTempC != null).length

  return (
    <>
      <header className="header">
        <h1>
          World of <span>Buoys</span>
        </h1>
        <div className="header-spacer" />
        {!loading && (
          <div className="count-chip">
            {buoys.length} stations /{' '}
            <span className="alive">{reporting} reporting</span>
          </div>
        )}
        <button
          className="unit-toggle"
          onClick={() => setUseMetric((m) => !m)}
          title="Toggle units"
        >
          {useMetric ? '°C / metric' : '°F / imperial'}
        </button>
      </header>

      <nav className="tab-bar">
        {['map', 'operations', 'nearby', 'research'].map((t) => (
          <div
            key={t}
            className={`tab${tab === t ? ' active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </div>
        ))}
      </nav>

      <div className="app-content">
        {/* MapView always mounted — hidden via CSS when not active */}
        <div style={{ position: 'absolute', inset: 0, display: tab === 'map' ? 'block' : 'none' }}>
          <Suspense fallback={<div className="loading-veil">Loading map…</div>}>
            <MapView
              buoys={buoys}
              useMetric={useMetric}
              selectedBuoy={selectedBuoy}
              onSelectBuoy={setSelectedBuoy}
              onNearbyRequest={handleNearbyRequest}
              researchRegion={researchRegion}
              onRegionChange={setResearchRegion}
              onOpenResearch={() => { setResearchScope('region'); setTab('research') }}
              correlationOverlay={correlationOverlay}
              propagationOverlay={propagationOverlay}
              onExitOverlay={exitOverlays}
              onShowPropagationMap={handleShowPropagationMap}
              onOpenPropagation={handleOpenPropagation}
              autoLocate={autoLocate.current}
            />
          </Suspense>
        </div>

        {tab === 'operations' && (
          <Suspense fallback={<div className="loading-veil">Loading operations…</div>}>
            <Operations stats={stats} useMetric={useMetric} />
          </Suspense>
        )}

        {tab === 'nearby' && (
          <Suspense fallback={<div className="loading-veil">Loading nearby…</div>}>
            <Nearby
              buoys={buoys}
              useMetric={useMetric}
              nearbyOrigin={nearbyOrigin}
              onSelectBuoy={handleSelectBuoy}
            />
          </Suspense>
        )}

        {tab === 'research' && (
          <Suspense fallback={<div className="loading-veil">Loading research…</div>}>
            <Research buoys={buoys} useMetric={useMetric} researchRegion={researchRegion} scope={researchScope} onScopeChange={setResearchScope} onOpenMap={() => setTab('map')} onSelectBuoy={handleSelectBuoy} onShowCorrelationMap={handleShowCorrelationMap} onShowPropagationMap={handleShowPropagationMap} propagationRequest={propagationRequest} onConsumePropagationRequest={() => setPropagationRequest(null)} />
          </Suspense>
        )}
      </div>
    </>
  )
}
