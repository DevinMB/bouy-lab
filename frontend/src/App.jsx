import React, { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { fetchBuoys, fetchStats } from './api'

const MapView = lazy(() => import('./components/MapView'))
const Trends = lazy(() => import('./components/Trends'))
const Operations = lazy(() => import('./components/Operations'))
const Nearby = lazy(() => import('./components/Nearby'))
const Research = lazy(() => import('./components/Research'))

const REFRESH_INTERVAL = 60_000
const TABS = ['map', 'trends', 'operations', 'nearby', 'research']

// A moored buoy in plan: hull ring, mast light. Amber = the app's signal colour.
function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 28 28" aria-hidden="true">
      <circle cx="14" cy="14" r="13" fill="var(--color-surface)" stroke="var(--color-border-2)" />
      <path d="M4 18.5c2.5 0 2.5-1.5 5-1.5s2.5 1.5 5 1.5 2.5-1.5 5-1.5 2.5 1.5 5 1.5" fill="none" stroke="#3b82f6" strokeWidth="1.4" strokeLinecap="round" opacity="0.8" />
      <path d="M10.5 16.5 14 7l3.5 9.5z" fill="var(--color-text-bright)" />
      <circle cx="14" cy="6.5" r="2" fill="var(--color-amber)" />
    </svg>
  )
}

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
  const [fetchFailed, setFetchFailed] = useState(false)
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
      setFetchFailed(false)
    } catch (e) {
      console.error('Failed to fetch buoys:', e)
      setFetchFailed(true)
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
        <div className="brand">
          <BrandMark />
          <h1>
            World of <span>Buoys</span>
          </h1>
        </div>

        <nav className="segmented nav-tabs" role="tablist" aria-label="Sections">
          {TABS.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>

        <div className="header-right">
          {!loading && (
            <div className="live-status" title={fetchFailed ? 'Last refresh failed — showing cached data' : 'Live — refreshes every minute'}>
              <span className={`pulse${fetchFailed ? ' stale' : ''}`} />
              <span><b>{reporting}</b> reporting</span>
              <span className="detail">of {buoys.length} stations</span>
            </div>
          )}
          <div className="segmented small" role="group" aria-label="Units">
            <button aria-pressed={!useMetric} onClick={() => setUseMetric(false)}>°F</button>
            <button aria-pressed={useMetric} onClick={() => setUseMetric(true)}>°C</button>
          </div>
        </div>
      </header>

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

        {tab === 'trends' && (
          <Suspense fallback={<div className="loading-veil">Loading trends…</div>}>
            <Trends buoys={buoys} useMetric={useMetric} onSelectBuoy={handleSelectBuoy} />
          </Suspense>
        )}

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
