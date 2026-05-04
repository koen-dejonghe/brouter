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
  return overrides;
}

function isParamChanged(input) {
  if (input.type === 'checkbox')
    return input.checked !== (input.dataset.default === 'true');
  return String(input.value) !== String(input.dataset.default);
}

// ── Route query building ───────────────────────────────────────────────────

export function buildRouteParams(lonlats, fmt) {
  const params = new URLSearchParams({
    lonlats,
    profile:        document.getElementById('profile').value,
    alternativeidx: document.getElementById('alternativeidx').value,
  });
  if (fmt) params.set('format', fmt);
  for (const [k, v] of getProfileOverrides()) params.append(k, v);
  return params;
}

export function currentLonlats() {
  return state.waypoints.map(w => `${w.lon.toFixed(6)},${w.lat.toFixed(6)}`).join('|');
}

export function routeKey() {
  const overrides = [...getProfileOverrides()].map(([k, v]) => `${k}=${v}`).join(',');
  return `${document.getElementById('profile').value}|${document.getElementById('alternativeidx').value}|${overrides}`;
}

// ── Fetch a single leg (wp[i] → wp[i+1]) ─────────────────────────────────

export async function fetchLeg(i) {
  const lonlats = `${state.waypoints[i].lon.toFixed(6)},${state.waypoints[i].lat.toFixed(6)}|${state.waypoints[i+1].lon.toFixed(6)},${state.waypoints[i+1].lat.toFixed(6)}`;
  const resp = await fetch(`/route?${buildRouteParams(lonlats, null)}`);
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
  if (state.routeHitLayer) { state.map.removeLayer(state.routeHitLayer); state.routeHitLayer = null; }

  const segments   = buildSurfaceLines(data);
  state.routeSegments = segments;
  const geomCoords = data.features?.[0]?.geometry?.coordinates;
  const allLatLngs = geomCoords ? geomCoords.map(c => [c[1], c[0]]) : [];
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
    state.routeWpSegs = state.waypoints.map(w => {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < state.routeGeom.length; i++) {
        const d = (state.routeGeom[i].lat - w.lat) ** 2 + (state.routeGeom[i].lon - w.lon) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    });
  }

  if (allLatLngs.length) {
    state.routeHitLayer = L.polyline(allLatLngs, { weight: 20, opacity: 0.001, interactive: true }).addTo(state.map);
    state.routeHitLayer.on('mousemove', onRouteMouseMove);
    state.routeHitLayer.on('mouseout',  onRouteMouseOut);
    state.routeHitLayer.on('mousedown', onRouteMouseDown);
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
  if (state.routeHitLayer) { state.map.removeLayer(state.routeHitLayer); state.routeHitLayer = null; }
  state.routeGeom = null;
  state.routeWpSegs = null;
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

  if (state.routeSource !== 'brouter') {
    state.routeSource = 'brouter';
    state.legCache = new Array(Math.max(0, state.waypoints.length - 1)).fill(null);
    setStatus('Switched to routed mode after waypoint edit.', 'info');
  }

  const { lat, lng } = e.latlng;

  let bestIdx = 0, bestDist = Infinity;
  for (let i = 0; i < state.routeGeom.length; i++) {
    const p = state.routeGeom[i];
    const d = (p.lat - lat) ** 2 + (p.lon - lng) ** 2;
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }

  let insertIdx = state.waypoints.length - 1;
  for (let i = 0; i < state.routeWpSegs.length - 1; i++) {
    if (bestIdx <= state.routeWpSegs[i + 1]) { insertIdx = i + 1; break; }
  }

  pushUndo();

  if (state.hoverMarker) { state.map.removeLayer(state.hoverMarker); state.hoverMarker = null; }

  const snapLat = state.routeGeom[bestIdx].lat;
  const snapLon = state.routeGeom[bestIdx].lon;
  const wp = { lat: snapLat, lon: snapLon, marker: null };
  state.waypoints.splice(insertIdx, 0, wp);
  state.legCache.splice(insertIdx, 0, null);
  if (insertIdx > 0) state.legCache[insertIdx - 1] = null;

  const marker = L.marker([snapLat, snapLon], {
    icon: makeIcon('#64748b', 10),
    draggable: true,
  }).addTo(state.map);
  marker.on('dragend', () => {
    pushUndo();
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

// ── Auto-route with debounce ───────────────────────────────────────────────

export function scheduleRoute() {
  if (state.routeTimer) { clearTimeout(state.routeTimer); state.routeTimer = null; }
  if (state.routeSource !== 'brouter') return;
  if (state.waypoints.length < 2) {
    clearRenderedRouteOnly();
    return;
  }
  state.routeTimer = setTimeout(calculateRoute, 300);
}

export async function calculateRoute() {
  if (state.routeSource !== 'brouter') return;
  const n = state.waypoints.length;
  if (n < 2) return;

  const key = routeKey();
  if (key !== state.lastRouteKey) { state.lastRouteKey = key; state.legCache = new Array(n - 1).fill(null); }

  while (state.legCache.length < n - 1) state.legCache.push(null);
  state.legCache.length = n - 1;

  const nullIdxs = state.legCache.reduce((acc, v, i) => { if (v === null) acc.push(i); return acc; }, []);
  if (!nullIdxs.length) {
    renderRoute(stitchLegs(state.legCache), false);
    setStatus('Route calculated.', 'ok');
    return;
  }

  const wasEmpty = !state.routeLayer;
  setStatus(`Calculating… (${nullIdxs.length} leg${nullIdxs.length > 1 ? 's' : ''})`, 'info');
  removeSelectionOverlay();
  state.elevSelection = null; state.routeSegments = null;
  hideSelStats();

  try {
    await Promise.all(nullIdxs.map(async i => {
      state.legCache[i] = await fetchLeg(i);
    }));
    renderRoute(stitchLegs(state.legCache), wasEmpty);
    saveRoute();
    setStatus('Route calculated.', 'ok');
  } catch (err) {
    nullIdxs.forEach(i => { if (state.legCache[i] === null) state.legCache[i] = null; });
    setStatus('Network error: ' + err.message, 'error');
  }
}
