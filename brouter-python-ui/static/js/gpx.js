function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseTrkPoints(doc) {
  const pts = [];
  const trkpts = Array.from(doc.getElementsByTagNameNS('*', 'trkpt'));
  trkpts.forEach(el => {
    const lat = toNum(el.getAttribute('lat'));
    const lon = toNum(el.getAttribute('lon'));
    if (lat == null || lon == null) return;
    const eleEl = el.querySelector('ele');
    const ele = eleEl ? toNum(eleEl.textContent?.trim()) : null;
    pts.push({ lat, lon, ele });
  });
  return pts;
}

function cumulativeGeometry(points) {
  const out = [];
  let cum = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) {
      const a = points[i - 1];
      const b = points[i];
      const dLat = (b.lat - a.lat) * 111320;
      const dLon = (b.lon - a.lon) * 111320 * Math.cos((a.lat + b.lat) / 2 * Math.PI / 180);
      cum += Math.sqrt(dLat * dLat + dLon * dLon);
    }
    out.push({ ...points[i], cumDist: cum });
  }
  return out;
}

function nearestIndexByDist(geom, target) {
  let lo = 0;
  let hi = geom.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (geom[mid].cumDist < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return 0;
  const a = geom[lo - 1];
  const b = geom[lo];
  return Math.abs(a.cumDist - target) <= Math.abs(b.cumDist - target) ? lo - 1 : lo;
}

export function parseGpxString(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const parserErr = doc.querySelector('parsererror');
  if (parserErr) throw new Error('Invalid GPX file');

  const pts = parseTrkPoints(doc);
  if (pts.length < 2) throw new Error('GPX contains no usable track geometry');

  const coords = pts.map(p => p.ele == null ? [p.lon, p.lat] : [p.lon, p.lat, p.ele]);
  const geojson = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: {},
    }],
  };

  const metadata = doc.getElementsByTagNameNS('*', 'metadata')[0] || null;
  const trk = doc.getElementsByTagNameNS('*', 'trk')[0] || null;
  const nameEl =
    (metadata && metadata.getElementsByTagNameNS('*', 'name')[0]) ||
    (trk && trk.getElementsByTagNameNS('*', 'name')[0]) ||
    null;
  const name = nameEl?.textContent?.trim() || null;
  return { geojson, name };
}

export function buildRegularWaypointsFromGeoJson(geojson, intervalKm = 10) {
  const coords = geojson?.features?.[0]?.geometry?.coordinates;
  if (!coords || coords.length < 2) return [];

  const points = coords.map(c => ({ lat: c[1], lon: c[0] }));
  const geom = cumulativeGeometry(points);
  const total = geom[geom.length - 1].cumDist;
  const intervalM = Math.max(1000, (Number(intervalKm) || 10) * 1000);

  const pickedIdx = [];
  const pushIdx = idx => {
    if (!pickedIdx.length || pickedIdx[pickedIdx.length - 1] !== idx) pickedIdx.push(idx);
  };

  pushIdx(0);
  for (let d = intervalM; d < total; d += intervalM) {
    pushIdx(nearestIndexByDist(geom, d));
  }
  pushIdx(geom.length - 1);

  const MIN_SPACING_M = 250;
  const cleaned = [];
  for (const idx of pickedIdx) {
    if (!cleaned.length) {
      cleaned.push(idx);
      continue;
    }
    const prev = geom[cleaned[cleaned.length - 1]].cumDist;
    const cur = geom[idx].cumDist;
    if (cur - prev >= MIN_SPACING_M || idx === geom.length - 1) cleaned.push(idx);
  }

  return cleaned.map((idx, i) => ({
    lat: geom[idx].lat,
    lon: geom[idx].lon,
    auto: i > 0 && i < cleaned.length - 1,
  }));
}
