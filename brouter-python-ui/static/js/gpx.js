function toNum(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function elementsByLocalName(root, name) {
  const out = [];
  const all = root.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    if ((all[i].localName || '').toLowerCase() === name) out.push(all[i]);
  }
  return out;
}

function firstChildByLocalName(el, name) {
  if (!el) return null;
  for (let i = 0; i < el.children.length; i++) {
    if ((el.children[i].localName || '').toLowerCase() === name) return el.children[i];
  }
  return null;
}

function parsePoints(elements) {
  const pts = [];
  elements.forEach(el => {
    const lat = toNum(el.getAttribute('lat'));
    const lon = toNum(el.getAttribute('lon'));
    if (lat == null || lon == null || lat < -90 || lat > 90 || lon < -180 || lon > 180) return;
    const eleEl = firstChildByLocalName(el, 'ele');
    const ele = eleEl ? toNum(eleEl.textContent?.trim()) : null;
    pts.push({ lat, lon, ele });
  });
  return pts;
}

function parseParts(doc) {
  const parts = [];
  for (const seg of elementsByLocalName(doc, 'trkseg')) {
    const points = parsePoints(elementsByLocalName(seg, 'trkpt'));
    if (points.length >= 2) parts.push(points);
  }
  if (parts.length) return parts;
  for (const rte of elementsByLocalName(doc, 'rte')) {
    const points = parsePoints(elementsByLocalName(rte, 'rtept'));
    if (points.length >= 2) parts.push(points);
  }
  return parts;
}

function cumulativeGeometry(points) {
  return measureCoordinates(points.map(point => [point.lon, point.lat])).map(point => ({
    lat: point.lat, lon: point.lon, cumDist: point.measureM,
  }));
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

const headingDeg = (a, b) => headingDegrees([a.lon, a.lat], [b.lon, b.lat]);
const angleDiffDeg = angleDifferenceDegrees;

function addCandidate(map, idx, score, critical = false) {
  const cur = map.get(idx);
  if (!cur) {
    map.set(idx, { score, critical });
    return;
  }
  cur.score = Math.max(cur.score, score);
  cur.critical = cur.critical || critical;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function adaptiveDefaults(totalM, turnCount, majorTurnCount) {
  const totalKm = Math.max(0.1, totalM / 1000);
  const turnDensity = turnCount / totalKm;

  let spacingM;
  if (totalM < 60_000) spacingM = 4_000;
  else if (totalM < 150_000) spacingM = 6_000;
  else if (totalM < 300_000) spacingM = 8_000;
  else spacingM = 10_000;

  if (turnDensity > 1.5) spacingM *= 0.7;
  else if (turnDensity > 1.0) spacingM *= 0.8;
  else if (turnDensity > 0.6) spacingM *= 0.9;
  else if (turnDensity < 0.25) spacingM *= 1.15;
  spacingM = clamp(Math.round(spacingM), 2_500, 12_000);

  const capByDistance = Math.round(totalKm / 3) + 18;
  const capByTurns = 18 + Math.round(turnCount * 0.7) + Math.round(majorTurnCount * 0.8);
  const maxWaypoints = clamp(Math.max(capByDistance, capByTurns), 30, 90);

  return { spacingM, maxWaypoints };
}

function selectAnchorsWithCap(geom, candidates, maxWaypoints) {
  const last = geom.length - 1;
  const selected = new Set([0, last]);

  const ordered = [...candidates.entries()]
    .filter(([idx]) => idx !== 0 && idx !== last)
    .sort((a, b) => b[1].score - a[1].score);

  const distanceOf = idx => geom[idx].cumDist;
  const canAdd = (idx, critical) => {
    const minSpacing = critical ? 90 : 180;
    const d = distanceOf(idx);
    for (const s of selected) {
      if (Math.abs(distanceOf(s) - d) < minSpacing) return false;
    }
    return true;
  };

  for (const [idx, meta] of ordered) {
    if (selected.size >= maxWaypoints) break;
    if (canAdd(idx, meta.critical)) selected.add(idx);
  }

  const out = [...selected].sort((a, b) => a - b);
  return out;
}

export function parseGpxString(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const parserErr = doc.querySelector('parsererror');
  if (parserErr) throw new Error('Invalid GPX file');

  const parts = parseParts(doc);
  if (!parts.length) throw new Error('GPX contains no usable track geometry');
  const coords = parts.map(part => part.map(p => p.ele == null ? [p.lon, p.lat] : [p.lon, p.lat, p.ele]));
  const geometry = coords.length === 1
    ? { type: 'LineString', coordinates: coords[0] }
    : { type: 'MultiLineString', coordinates: coords };
  const geojson = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry,
      properties: {},
    }],
  };

  const metadata = elementsByLocalName(doc, 'metadata')[0] || null;
  const trk = elementsByLocalName(doc, 'trk')[0] || null;
  const nameEl =
    firstChildByLocalName(metadata, 'name') ||
    firstChildByLocalName(trk, 'name') ||
    null;
  const name = nameEl?.textContent?.trim() || null;
  return { geojson, name };
}

function primaryCoords(geojson) {
  return longestGeometryPart(geojson);
}

export function buildRegularWaypointsFromGeoJson(geojson, intervalKm = 10) {
  const coords = primaryCoords(geojson);
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

export function buildSmartWaypointsFromGeoJson(geojson) {
  const coords = primaryCoords(geojson);
  if (!coords || coords.length < 2) return [];

  const points = coords.map(c => ({ lat: c[1], lon: c[0] }));
  const geom = cumulativeGeometry(points);
  const total = geom[geom.length - 1].cumDist;

  let turnCount = 0;
  let majorTurnCount = 0;
  for (let i = 1; i < geom.length - 1; i++) {
    const a = geom[i - 1], b = geom[i], c = geom[i + 1];
    const segIn = b.cumDist - a.cumDist;
    const segOut = c.cumDist - b.cumDist;
    if (segIn < 8 || segOut < 8) continue;
    const turn = angleDiffDeg(headingDeg(a, b), headingDeg(b, c));
    if (turn >= 30) turnCount += 1;
    if (turn >= 55) majorTurnCount += 1;
  }

  const { spacingM, maxWaypoints } = adaptiveDefaults(total, turnCount, majorTurnCount);

  const candidates = new Map();
  addCandidate(candidates, 0, 1e6, true);
  addCandidate(candidates, geom.length - 1, 1e6, true);

  for (let d = spacingM; d < total; d += spacingM) {
    addCandidate(candidates, nearestIndexByDist(geom, d), 30, false);
  }

  for (let i = 1; i < geom.length - 1; i++) {
    const a = geom[i - 1], b = geom[i], c = geom[i + 1];
    const segIn = b.cumDist - a.cumDist;
    const segOut = c.cumDist - b.cumDist;
    if (segIn < 8 || segOut < 8) continue;

    const h1 = headingDeg(a, b);
    const h2 = headingDeg(b, c);
    const turn = angleDiffDeg(h1, h2);

    if (turn >= 30) {
      const major = turn >= 55;
      addCandidate(candidates, i, 120 + turn * 2, major);
      if (major) {
        const beforeDist = Math.max(0, b.cumDist - 100);
        const afterDist = Math.min(total, b.cumDist + 100);
        addCandidate(candidates, nearestIndexByDist(geom, beforeDist), 90 + turn, true);
        addCandidate(candidates, nearestIndexByDist(geom, afterDist), 90 + turn, true);
      }
    }
  }

  const selectedIdx = selectAnchorsWithCap(geom, candidates, Math.max(2, maxWaypoints));
  const waypoints = selectedIdx.map((idx, i) => ({
    lat: geom[idx].lat,
    lon: geom[idx].lon,
    auto: i > 0 && i < selectedIdx.length - 1,
  }));
  waypoints.meta = {
    totalDistanceM: Math.round(total),
    adaptiveSpacingM: spacingM,
    adaptiveCap: maxWaypoints,
    selectedCount: selectedIdx.length,
    turnCount,
    majorTurnCount,
  };
  return waypoints;
}
import { angleDifferenceDegrees, headingDegrees, longestGeometryPart, measureCoordinates } from './geometry.js';
