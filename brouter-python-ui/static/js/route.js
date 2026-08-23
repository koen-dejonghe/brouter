import { state } from './state.js';
import { buildSurfaceLines, showStats } from './stats.js';
import { drawElevationProfile, clearElevationProfile, removeSelectionOverlay, hideSelStats,
         onRouteMouseMove, onRouteMouseOut } from './elevation.js'; // circular — safe
import { setStatus, saveRoute } from './utils.js';
import { makeIcon, refreshAllIcons } from './icons.js';
import { renderWaypointList, pushUndo, _addWaypointRaw } from './waypoints.js'; // circular — safe

// ── Profile overrides (read from DOM) ─────────────────────────────────────

export function getProfileOverrides() {
  const overrides = [];
  document.querySelectorAll('[data-param]').forEach(input => {
    if (!isParamChanged(input)) return;
    const value = input.type === 'checkbox' ? (input.checked ? '1' : '0') : input.value;
    overrides.push([`profile:${input.dataset.param}`, value]);
  });
  return overrides.sort((a, b) => a[0].localeCompare(b[0]));
}

function isParamChanged(input) {
  if (input.type === 'checkbox')
    return input.checked !== (input.dataset.default === 'true');
  return String(input.value) !== String(input.dataset.default);
}

function headingDeg(a, b) {
  const dLat = (b[0] - a[0]) * 111320;
  const dLon = (b[1] - a[1]) * 111320 * Math.cos((a[0] + b[0]) / 2 * Math.PI / 180);
  if (dLat === 0 && dLon === 0) return 0;
  return Math.atan2(dLon, dLat) * 180 / Math.PI;
}

function pointAtDistance(routeGeom, targetDist) {
  if (!routeGeom || !routeGeom.length) return null;
  if (targetDist <= 0) return routeGeom[0];
  const last = routeGeom[routeGeom.length - 1];
  if (targetDist >= last.cumDist) return last;

  let lo = 0, hi = routeGeom.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (routeGeom[mid].cumDist < targetDist) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(1, lo);
  const a = routeGeom[i - 1], b = routeGeom[i];
  const span = b.cumDist - a.cumDist;
  const t = span > 0 ? (targetDist - a.cumDist) / span : 0;
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + (b.lon - a.lon) * t,
    cumDist: targetDist,
    heading: headingDeg([a.lat, a.lon], [b.lat, b.lon]),
  };
}

function metersPerPixelAt(lat, zoom) {
  return (156543.03392 * Math.cos(lat * Math.PI / 180)) / Math.pow(2, zoom);
}

function dynamicSteps(routeGeom) {
  if (!routeGeom || routeGeom.length < 2) return { markerStep: 1000, distanceStep: 1000 };
  const total = routeGeom[routeGeom.length - 1].cumDist;
  const mid = routeGeom[(routeGeom.length / 2) | 0];
  const zoom = state.map.getZoom();
  const mpp = metersPerPixelAt(mid.lat, zoom);

  const targetPx = 120;
  const rawStep = Math.max(1000, mpp * targetPx);
  const options = [1000, 2000, 3000, 5000, 7500, 10000, 15000, 20000, 30000, 50000];
  let markerStep = options[options.length - 1];
  for (const v of options) {
    if (v >= rawStep) { markerStep = v; break; }
  }
  if (total < markerStep * 1.8) markerStep = Math.max(1000, Math.floor(total / 3));

  const distanceStep = Math.max(1000, markerStep * 2);
  return { markerStep: Math.max(1000, markerStep), distanceStep };
}

function buildRouteInfoMarkers(routeGeom) {
  if (!routeGeom || routeGeom.length < 2) return null;
  const total = routeGeom[routeGeom.length - 1].cumDist;
  if (total < 1500) return null;

  const layer = L.layerGroup();

  const { markerStep, distanceStep } = dynamicSteps(routeGeom);

  let markerCount = 0;
  for (let d = markerStep, n = 1; d < total && markerCount < 120; d += markerStep, n += 1) {
    const p = pointAtDistance(routeGeom, d);
    if (!p) continue;
    const isDistance = Math.round(d) % Math.round(distanceStep) === 0;
    if (isDistance) {
      const label = `${Math.round(d / 1000)}`;
      layer.addLayer(L.marker([p.lat, p.lon], {
        icon: L.divIcon({
          className: 'route-dist-icon',
          html: `<div class="route-dist-pill">${label}</div>`,
          iconSize: [38, 32],
          iconAnchor: [19, 30],
        }),
        interactive: false,
        keyboard: false,
      }));
    } else {
      layer.addLayer(L.marker([p.lat, p.lon], {
        icon: L.divIcon({
          className: 'route-dir-icon',
          html: `<div class="route-dir-arrow" style="transform: rotate(${p.heading}deg)">▲</div>`,
          iconSize: [14, 14],
          iconAnchor: [7, 7],
        }),
        interactive: false,
        keyboard: false,
      }));
    }
    markerCount += 1;
  }

  return layer;
}

// ── Route query building ───────────────────────────────────────────────────

export function captureRouteContext() {
  return {
    profile: document.getElementById('profile').value,
    alternativeidx: document.getElementById('alternativeidx').value,
    overrides: getProfileOverrides(),
  };
}

export function routeContextKey(context = captureRouteContext()) {
  return `${context.profile}|${context.alternativeidx}|${context.overrides.map(([k, v]) => `${k}=${v}`).join(',')}`;
}

export function waypointKey(points = state.waypoints) {
  return points.map(w => `${Number(w.lon).toFixed(6)},${Number(w.lat).toFixed(6)}`).join('|');
}

export function buildRouteParams(lonlats, fmt, context = captureRouteContext()) {
  const params = new URLSearchParams({
    lonlats,
    profile: context.profile,
    alternativeidx: context.alternativeidx,
  });
  if (fmt) params.set('format', fmt);
  for (const [k, v] of context.overrides) params.append(k, v);
  return params;
}

export function currentLonlats() {
  return state.waypoints.map(w => `${w.lon.toFixed(6)},${w.lat.toFixed(6)}`).join('|');
}

export function routeKey() {
  return routeContextKey();
}

// ── Fetch a single leg (wp[i] → wp[i+1]) ─────────────────────────────────

export async function fetchLeg(i, waypoints = state.waypoints, context = captureRouteContext(), signal = null) {
  const lonlats = `${waypoints[i].lon.toFixed(6)},${waypoints[i].lat.toFixed(6)}|${waypoints[i+1].lon.toFixed(6)},${waypoints[i+1].lat.toFixed(6)}`;
  const resp = await fetch(`/route?${buildRouteParams(lonlats, null, context)}`, { signal });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Routing failed');
  return data;
}

// ── Stitch cached legs into one GeoJSON-like object ───────────────────────

export function stitchLegs(legs) {
  if (legs.length === 1) return legs[0];

  let allCoords   = [];
  let allMessages = null;
  let totalLength = 0, totalTime = 0, totalEnergy = 0;

  for (let i = 0; i < legs.length; i++) {
    const feat   = legs[i].features[0];
    const coords = feat.geometry.coordinates;
    const msgs   = feat.properties.messages;
    const props  = feat.properties;

    allCoords = i === 0 ? [...coords] : [...allCoords, ...coords.slice(1)];

    if (msgs && msgs.length > 1) {
      if (!allMessages) allMessages = [msgs[0]];
      allMessages.push(...msgs.slice(1));
    }

    totalLength += parseFloat(props['track-length']) || 0;
    totalTime   += parseFloat(props['total-time'])   || 0;
    totalEnergy += parseFloat(props['total-energy']) || 0;
  }

  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: allCoords },
      properties: {
        messages:       allMessages,
        'track-length': totalLength,
        'total-time':   totalTime,
        'total-energy': totalEnergy,
      },
    }],
  };
}

// ── Render a complete stitched route onto the map ─────────────────────────

export function renderRoute(data, fitBounds) {
  if (state.routeLayer)    { state.map.removeLayer(state.routeLayer);    state.routeLayer    = null; }
  if (state.routeInfoLayer){ state.map.removeLayer(state.routeInfoLayer); state.routeInfoLayer = null; }
  if (state.routeInfoHandler) {
    state.map.off('zoomend', state.routeInfoHandler);
    state.routeInfoHandler = null;
  }
  if (state.routeHitLayer) { state.map.removeLayer(state.routeHitLayer); state.routeHitLayer = null; }

  const segments   = buildSurfaceLines(data);
  state.routeSegments = segments;
  const geometry = data.features?.[0]?.geometry;
  const geomParts = geometry?.type === 'MultiLineString' ? geometry.coordinates : geometry?.type === 'LineString' ? [geometry.coordinates] : [];
  const geomCoords = geomParts.reduce((best, part) => part.length > best.length ? part : best, []);
  const allLatLngs = geomParts.flatMap(part => part.map(c => [c[1], c[0]]));
  if (allLatLngs.length) { state.routeBounds = L.latLngBounds(allLatLngs); state.fitRouteControl.setEnabled(true); }

  if (segments) {
    const casings = segments.map(({ latlngs, category }) => L.polyline(latlngs, {
      color: 'rgba(0,0,0,0.45)', weight: category === 'unpaved' ? 5 : 6,
      opacity: category === 'unknown' ? 0.45 : 1,
      lineCap: 'round', lineJoin: 'round', interactive: false,
    }));
    const fills = segments.map(({ latlngs, category }) => L.polyline(latlngs, {
      color:     category === 'unpaved' ? '#fbbf24' : '#3b82f6',
      weight:    3, opacity: category === 'unknown' ? 0.5 : 0.92,
      dashArray: category === 'unpaved' ? '8, 8' : null,
      lineCap: 'butt', lineJoin: 'round', interactive: false,
    }));
    state.routeLayer = L.layerGroup([...casings, ...fills]).addTo(state.map);
  } else {
    const casing = L.geoJSON(data, { style: { color: 'rgba(0,0,0,0.45)', weight: 6 }, interactive: false });
    const fill   = L.geoJSON(data, { style: { color: '#3b82f6', weight: 3, opacity: 0.92 }, interactive: false });
    state.routeLayer = L.layerGroup([casing, fill]).addTo(state.map);
  }

  state.routeGeom = null;
  if (geomCoords && geomCoords.length >= 2) {
    let cum = 0;
    state.routeGeom = geomCoords.map((c, i) => {
      if (i > 0) {
        const [lon1, lat1] = geomCoords[i - 1], [lon2, lat2] = c;
        const dLat = (lat2 - lat1) * 111320;
        const dLon = (lon2 - lon1) * 111320 * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
        cum += Math.sqrt(dLat * dLat + dLon * dLon);
      }
      return { lat: c[1], lon: c[0], cumDist: cum };
    });
    let minIdx = 0;
    state.routeWpSegs = state.waypoints.map(w => {
      let best = minIdx, bestD = Infinity;
      for (let i = minIdx; i < state.routeGeom.length; i++) {
        const d = (state.routeGeom[i].lat - w.lat) ** 2 + (state.routeGeom[i].lon - w.lon) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
      minIdx = best;
      return best;
    });
    state.routeWpMeasures = state.routeWpSegs.map(i => state.routeGeom[i].cumDist);
  }

  if (geomParts.length) {
    const hitLines = geomParts.map(part => L.polyline(part.map(c => [c[1], c[0]]), { weight: 20, opacity: 0.001, interactive: true }));
    state.routeHitLayer = L.featureGroup(hitLines).addTo(state.map);
    state.routeHitLayer.on('mousemove', onRouteMouseMove);
    state.routeHitLayer.on('mouseout',  onRouteMouseOut);
    state.routeHitLayer.on('mousedown', onRouteMouseDown);
  }

  if (state.routeGeom && state.routeGeom.length >= 2) {
    const info = buildRouteInfoMarkers(state.routeGeom);
    if (info) {
      state.routeInfoLayer = info;
      state.routeInfoLayer.addTo(state.map);

      state.routeInfoHandler = () => {
        if (!state.routeGeom) return;
        if (state.routeInfoLayer) state.map.removeLayer(state.routeInfoLayer);
        state.routeInfoLayer = buildRouteInfoMarkers(state.routeGeom);
        if (state.routeInfoLayer) state.routeInfoLayer.addTo(state.map);
      };
      state.map.on('zoomend', state.routeInfoHandler);
    }
  }

  if (fitBounds && allLatLngs.length) {
    const bounds = L.latLngBounds(allLatLngs);
    state.map.whenReady(() => state.map.fitBounds(bounds, { padding: [30, 30] }));
  }

  showStats(data?.features?.[0]?.properties ?? {}, data);
  document.getElementById('btn-download').disabled = false;
  drawElevationProfile(data);
}

export function clearRenderedRouteOnly() {
  if (state.routeTimer) { clearTimeout(state.routeTimer); state.routeTimer = null; }
  if (state.routeLayer)    { state.map.removeLayer(state.routeLayer);    state.routeLayer    = null; }
  if (state.routeInfoLayer){ state.map.removeLayer(state.routeInfoLayer); state.routeInfoLayer = null; }
  if (state.routeInfoHandler) {
    state.map.off('zoomend', state.routeInfoHandler);
    state.routeInfoHandler = null;
  }
  if (state.routeHitLayer) { state.map.removeLayer(state.routeHitLayer); state.routeHitLayer = null; }
  state.routeGeom = null;
  state.routeWpSegs = null;
  state.routeWpMeasures = null;
  removeSelectionOverlay();
  state.elevSelection = null;
  state.routeBounds = null;
  state.routeSegments = null;
  state.fitRouteControl.setEnabled(false);
  document.getElementById('btn-download').disabled = true;
  document.getElementById('stats').style.display = 'none';
  clearElevationProfile();
}

// ── Route click — insert waypoint at snapped position ────────────────────

function onRouteMouseDown(e) {
  if (!state.routeGeom || !state.routeWpSegs || state.routeGeom.length < 2) return;
  L.DomEvent.stopPropagation(e);

  pushUndo();

  if (state.routeSource !== 'brouter') {
    state.routeSource = 'brouter';
    state.importedRoute = null;
    state.legCache = new Array(Math.max(0, state.waypoints.length - 1)).fill(null);
    setStatus('Switched to routed mode after waypoint edit.', 'info');
  }

  const snap = findNearestRoutePoint(e.latlng.lat, e.latlng.lng);
  if (!snap) return;
  const insertIdx = routeInsertIndexByDistance(snap.routeDist);

  if (state.hoverMarker) { state.map.removeLayer(state.hoverMarker); state.hoverMarker = null; }

  const snapLat = snap.lat;
  const snapLon = snap.lon;
  const wp = { lat: snapLat, lon: snapLon, marker: null };
  state.waypoints.splice(insertIdx, 0, wp);
  state.legCache.splice(insertIdx, 0, null);
  if (insertIdx > 0) state.legCache[insertIdx - 1] = null;

  const marker = L.marker([snapLat, snapLon], {
    icon: makeIcon('#64748b', 10),
    draggable: true,
  }).addTo(state.map);
  marker.on('dragstart', pushUndo);
  marker.on('dragend', () => {
    const ll = marker.getLatLng();
    wp.lat = ll.lat; wp.lon = ll.lng;
    const idx = state.waypoints.indexOf(wp);
    if (idx > 0)                          state.legCache[idx - 1] = null;
    if (idx < state.waypoints.length - 1) state.legCache[idx]     = null;
    refreshAllIcons();
    renderWaypointList();
    scheduleRoute();
  });
  marker.on('mouseover', () => { const i = state.waypoints.indexOf(wp); if (i >= 0) { /* highlight handled by waypoints */ } });
  wp.marker = marker;
  refreshAllIcons();
  renderWaypointList();

  state.map.dragging.disable();
  const container = state.map.getContainer();
  container.style.cursor = 'grabbing';

  function onMove(ev) {
    const pt = state.map.mouseEventToContainerPoint(ev);
    const ll = state.map.containerPointToLatLng(pt);
    wp.lat = ll.lat; wp.lon = ll.lng;
    marker.setLatLng(ll);
  }

  function onUp() {
    container.removeEventListener('mousemove', onMove);
    container.removeEventListener('mouseup',   onUp);
    state.map.dragging.enable();
    container.style.cursor = '';
    refreshAllIcons();
    renderWaypointList();
    scheduleRoute();
  }

  container.addEventListener('mousemove', onMove);
  container.addEventListener('mouseup',   onUp);
}

export function findNearestRoutePoint(lat, lon) {
  if (!state.routeGeom || state.routeGeom.length < 2) return null;
  const target = state.map.latLngToContainerPoint([lat, lon]);
  let bestIdx = 1;
  let bestDist = Infinity;
  let bestT = 0;
  for (let i = 1; i < state.routeGeom.length; i++) {
    const a = state.map.latLngToContainerPoint([state.routeGeom[i - 1].lat, state.routeGeom[i - 1].lon]);
    const b = state.map.latLngToContainerPoint([state.routeGeom[i].lat, state.routeGeom[i].lon]);
    const vx = b.x - a.x, vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    const t = len2 ? Math.max(0, Math.min(1, ((target.x - a.x) * vx + (target.y - a.y) * vy) / len2)) : 0;
    const x = a.x + t * vx, y = a.y + t * vy;
    const d = (x - target.x) ** 2 + (y - target.y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
      bestT = t;
    }
  }
  const a = state.routeGeom[bestIdx - 1];
  const b = state.routeGeom[bestIdx];
  return {
    idx: bestIdx,
    lat: a.lat + (b.lat - a.lat) * bestT,
    lon: a.lon + (b.lon - a.lon) * bestT,
    routeDist: a.cumDist + (b.cumDist - a.cumDist) * bestT,
    distancePx: Math.sqrt(bestDist),
  };
}

function routeInsertIndexByDistance(routeDist) {
  if (!state.routeWpMeasures || !state.routeWpMeasures.length) return Math.max(0, state.waypoints.length - 1);
  let insertIdx = state.waypoints.length - 1;
  for (let i = 0; i < state.routeWpMeasures.length - 1; i++) {
    if (routeDist <= state.routeWpMeasures[i + 1]) {
      insertIdx = i + 1;
      break;
    }
  }
  return insertIdx;
}

export function getRouteContextInsertion(lat, lon) {
  const snap = findNearestRoutePoint(lat, lon);
  if (!snap) return null;
  return {
    snapLat: snap.lat,
    snapLon: snap.lon,
    insertIdx: routeInsertIndexByDistance(snap.routeDist),
  };
}

// ── Auto-route with debounce ───────────────────────────────────────────────

export function invalidateImportedGpxWork() {
  state.gpxImportSeq += 1;
  state.gpxAbortController?.abort();
  state.gpxAbortController = null;
  const progress = document.getElementById('surface-enrich-progress');
  if (progress) progress.style.display = 'none';
}

export function invalidateRouteWork({ invalidateImport = true } = {}) {
  state.routeRequestSeq += 1;
  if (state.routeTimer) { clearTimeout(state.routeTimer); state.routeTimer = null; }
  state.routeAbortController?.abort();
  state.routeAbortController = null;
  if (invalidateImport) invalidateImportedGpxWork();
}

export function scheduleRoute() {
  invalidateRouteWork();
  const seq = state.routeRequestSeq;
  if (state.routeSource !== 'brouter') return;
  if (state.waypoints.length < 2) {
    clearRenderedRouteOnly();
    return;
  }
  state.routeTimer = setTimeout(() => calculateRoute(seq), 300);
}

export async function calculateRoute(seq = state.routeRequestSeq) {
  if (state.routeSource !== 'brouter') return;
  const waypoints = state.waypoints.map(({ lat, lon }) => ({ lat, lon }));
  const n = waypoints.length;
  if (n < 2) return;

  const context = captureRouteContext();
  const key = routeContextKey(context);
  const wKey = waypointKey(waypoints);
  let nextCache = key === state.lastRouteKey ? state.legCache.slice(0, n - 1) : new Array(n - 1).fill(null);

  while (nextCache.length < n - 1) nextCache.push(null);

  const isCurrent = () => seq === state.routeRequestSeq && state.routeSource === 'brouter' && waypointKey() === wKey && routeContextKey() === key;
  const nullIdxs = nextCache.reduce((acc, v, i) => { if (v === null) acc.push(i); return acc; }, []);
  if (!nullIdxs.length) {
    if (!isCurrent()) return;
    state.legCache = nextCache;
    state.lastRouteKey = key;
    renderRoute(stitchLegs(nextCache), false);
    setStatus('Route calculated.', 'ok');
    return;
  }

  const wasEmpty = !state.routeLayer;
  setStatus(`Calculating… (${nullIdxs.length} leg${nullIdxs.length > 1 ? 's' : ''})`, 'info');
  removeSelectionOverlay();
  state.elevSelection = null; state.routeSegments = null;
  hideSelStats();

  try {
    const controller = new AbortController();
    state.routeAbortController = controller;
    await Promise.all(nullIdxs.map(async i => {
      nextCache[i] = await fetchLeg(i, waypoints, context, controller.signal);
    }));
    if (!isCurrent() || controller.signal.aborted) return;
    state.legCache = nextCache;
    state.lastRouteKey = key;
    renderRoute(stitchLegs(nextCache), wasEmpty);
    saveRoute(context);
    setStatus('Route calculated.', 'ok');
  } catch (err) {
    if (err.name !== 'AbortError' && isCurrent()) setStatus('Network error: ' + err.message, 'error');
  } finally {
    if (seq === state.routeRequestSeq) state.routeAbortController = null;
  }
}
