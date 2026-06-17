// Point-in-polygon via ray casting. poly is [[lat, lon], ...]; treats lon as x,
// lat as y. Good enough for regional selection (no antimeridian handling).
export function pointInPolygon(lat, lon, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i][0], xi = poly[i][1]
    const yj = poly[j][0], xj = poly[j][1]
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)
    if (intersect) inside = !inside
  }
  return inside
}

export function polygonCentroid(poly) {
  let lat = 0, lon = 0
  for (const p of poly) { lat += p[0]; lon += p[1] }
  return [lat / poly.length, lon / poly.length]
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.asin(Math.sqrt(a))
}
