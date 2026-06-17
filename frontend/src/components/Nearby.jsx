import React, { useState, useEffect, useRef } from 'react'
import { fetchNearby, units as U } from '../api'
import { thermalColor, onThermalText } from '../thermal'

const STREAM_COLORS = {
  standard: '#3b82f6',
  ocean: '#14b8a6',
  spec: '#a855f7',
  srad: '#eab308',
  dart: '#f97316',
}

export default function Nearby({ buoys, useMetric, nearbyOrigin, onSelectBuoy }) {
  const [mode, setMode] = useState('geo') // 'geo' | 'station' | 'coords'
  const [lat, setLat] = useState('')
  const [lon, setLon] = useState('')
  const [stationQuery, setStationQuery] = useState('')
  const [pickedStation, setPickedStation] = useState(null)
  const [radiusKm, setRadiusKm] = useState(200)
  const [limit, setLimit] = useState(10)
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [geoError, setGeoError] = useState('')
  const [error, setError] = useState('')
  const initialized = useRef(false)

  // If nearbyOrigin is provided, seed coords and trigger search
  useEffect(() => {
    if (nearbyOrigin && !initialized.current) {
      initialized.current = true
      if (nearbyOrigin.stationId) {
        const st = buoys.find((b) => b.id === nearbyOrigin.stationId)
        if (st) {
          setMode('station')
          setPickedStation(st)
          setStationQuery(st.name || st.id)
        }
      } else {
        setMode('coords')
        setLat(String(nearbyOrigin.lat))
        setLon(String(nearbyOrigin.lon))
      }
    }
  }, [nearbyOrigin])

  const search = async (overrideLat, overrideLon) => {
    let searchLat = overrideLat ?? parseFloat(lat)
    let searchLon = overrideLon ?? parseFloat(lon)

    if (mode === 'station' && pickedStation) {
      searchLat = pickedStation.lat
      searchLon = pickedStation.lon
    }

    if (isNaN(searchLat) || isNaN(searchLon)) {
      setError('Invalid coordinates')
      return
    }

    setLoading(true)
    setError('')
    try {
      const data = await fetchNearby(searchLat, searchLon, radiusKm, limit)
      setResults(data)
      if (data.length === 0) setError(`No buoys found within ${radiusKm} km`)
    } catch (e) {
      setError('Search failed. Is the backend running?')
    } finally {
      setLoading(false)
    }
  }

  const useGeolocation = () => {
    setGeoError('')
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords
        setLat(String(latitude.toFixed(4)))
        setLon(String(longitude.toFixed(4)))
        search(latitude, longitude)
      },
      (err) => setGeoError(`Geolocation failed: ${err.message}`)
    )
  }

  const filteredStations = buoys
    .filter((b) => b.lat != null && (b.name || b.id).toLowerCase().includes(stationQuery.toLowerCase()))
    .slice(0, 8)

  return (
    <div className="nearby-page">
      {/* Controls */}
      <div className="nearby-controls">
        {/* Mode tabs */}
        <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
          {[['geo', 'My Location'], ['station', 'Station'], ['coords', 'Coordinates']].map(([m, label]) => (
            <button
              key={m}
              className={`btn${mode === m ? ' active' : ''}`}
              style={{ fontSize: '0.75rem', padding: '0.25rem 0.625rem', flex: '1', justifyContent: 'center' }}
              onClick={() => setMode(m)}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === 'geo' && (
          <div>
            <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={useGeolocation}>
              Use My Location
            </button>
            {geoError && <div style={{ color: 'var(--color-error)', fontSize: '0.75rem', marginTop: '0.375rem' }}>{geoError}</div>}
            {lat && lon && (
              <div className="mono" style={{ fontSize: '0.6875rem', color: 'var(--color-text-dim)', marginTop: '0.375rem' }}>
                {parseFloat(lat).toFixed(4)}, {parseFloat(lon).toFixed(4)}
              </div>
            )}
          </div>
        )}

        {mode === 'station' && (
          <div style={{ position: 'relative' }}>
            <input
              className="input"
              placeholder="Search station name or ID…"
              value={stationQuery}
              onChange={(e) => { setStationQuery(e.target.value); setPickedStation(null) }}
            />
            {stationQuery && !pickedStation && filteredStations.length > 0 && (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 4, zIndex: 10, maxHeight: 200, overflowY: 'auto' }}>
                {filteredStations.map((b) => (
                  <div
                    key={b.id}
                    style={{ padding: '0.5rem 0.625rem', cursor: 'pointer', fontSize: '0.75rem', borderBottom: '1px solid var(--color-border)' }}
                    onClick={() => { setPickedStation(b); setStationQuery(b.name || b.id) }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--color-surface-2)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    <span className="mono" style={{ color: 'var(--color-amber)', marginRight: '0.375rem' }}>{b.id}</span>
                    {b.name}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {mode === 'coords' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
            <input className="input" placeholder="Latitude" type="number" value={lat} onChange={(e) => setLat(e.target.value)} />
            <input className="input" placeholder="Longitude" type="number" value={lon} onChange={(e) => setLon(e.target.value)} />
          </div>
        )}

        {/* Radius slider */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6875rem', color: 'var(--color-text-dim)', marginBottom: '0.25rem' }}>
            <span>Radius</span>
            <span className="mono">{U.formatDist(radiusKm, useMetric)}</span>
          </div>
          <input
            type="range" min={50} max={5000} step={50}
            value={radiusKm}
            onChange={(e) => setRadiusKm(Number(e.target.value))}
            style={{ width: '100%', accentColor: 'var(--color-amber)' }}
          />
        </div>

        {/* Limit */}
        <div>
          <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-dim)', marginBottom: '0.25rem' }}>Max results</div>
          <div style={{ display: 'flex', gap: '0.25rem' }}>
            {[5, 10, 20, 50].map((n) => (
              <button key={n} className={`btn${limit === n ? ' active' : ''}`} style={{ flex: 1, justifyContent: 'center', padding: '0.25rem 0', fontSize: '0.75rem' }} onClick={() => setLimit(n)}>{n}</button>
            ))}
          </div>
        </div>

        <button className="btn btn-primary" style={{ justifyContent: 'center' }} onClick={() => search()}>
          Search
        </button>
      </div>

      {/* Results */}
      <div className="nearby-results">
        {loading && <div className="loading-veil">Searching…</div>}
        {!loading && error && <div style={{ color: 'var(--color-text-dim)', fontSize: '0.875rem', padding: '1rem' }}>{error}</div>}
        {!loading && !error && results.map((buoy) => {
          const wtc = buoy.latest?.waterTempC
          const bg = thermalColor(wtc)
          const fg = onThermalText(wtc)
          return (
            <div key={buoy.id} className="nearby-result-item" onClick={() => onSelectBuoy(buoy)}>
              <div className="temp-chip" style={{ background: bg, color: fg }}>
                {wtc != null ? U.formatTemp(wtc, useMetric).replace(' ', '\n') : '—'}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-bright)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{buoy.name || buoy.id}</div>
                <div className="mono" style={{ fontSize: '0.6875rem', color: 'var(--color-text-dim)', marginTop: 2 }}>
                  {buoy.id} · {U.formatDist(buoy.distanceKm, useMetric)}
                </div>
                <div style={{ display: 'flex', gap: '0.2rem', marginTop: '0.3rem', flexWrap: 'wrap' }}>
                  {(buoy.available || []).map((s) => (
                    <span key={s} style={{ fontSize: '0.5625rem', padding: '0.1rem 0.3rem', background: `${STREAM_COLORS[s] || '#888'}22`, border: `1px solid ${STREAM_COLORS[s] || '#888'}55`, borderRadius: 3, color: STREAM_COLORS[s] || '#888', fontFamily: 'var(--font-mono)' }}>{s}</span>
                  ))}
                </div>
              </div>
            </div>
          )
        })}
        {!loading && !error && results.length === 0 && !error && (
          <div style={{ color: 'var(--color-text-dim)', fontSize: '0.875rem', padding: '1rem' }}>
            Search for buoys near a location.
          </div>
        )}
      </div>
    </div>
  )
}
