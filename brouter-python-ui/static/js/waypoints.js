import { state } from './state.js';
import { makeIcon, refreshAllIcons, highlightWaypoint, unhighlightWaypoint } from './icons.js';
import { setStatus, clearSavedRoute } from './utils.js';
import { scheduleRoute } from './route.js';         // circular — safe, only called at runtime
import { clearElevationProfile, removeSelectionOverlay } from './elevation.js'; // circular — safe

// ── Undo stack ─────────────────────────────────────────────────────────────

function snapshot() {
  return { wps: state.waypoints.map(w => ({ lat: w.lat, lon: w.lon })), legs: [...state.legCache] };
}

function ensureRoutedMode() {
  if (state.routeSource === 'brouter') return;
  state.routeSource = 'brouter';
  state.legCache = new Array(Math.max(0, state.waypoints.length - 1)).fill(null);
  setStatus('Switched to routed mode after waypoint edit.', 'info');
}

export function pushUndo() {
  state.undoStack.push(snapshot());
  if (state.undoStack.length > 50) state.undoStack.shift();
}

export function undo() {
  if (!state.undoStack.length) return;
  const snap = state.undoStack.pop();
  state.waypoints.forEach(w => state.map.removeLayer(w.marker));
  state.waypoints = [];
  for (const { lat, lon } of snap.wps) _addWaypointRaw(lat, lon);
  state.legCache = snap.legs.slice(0, Math.max(0, state.waypoints.length - 1));
  refreshAllIcons();
  renderWaypointList();
  scheduleRoute();
}

// ── Core waypoint operations ───────────────────────────────────────────────

/** Internal: add a waypoint without touching the undo stack. */
export function _addWaypointRaw(lat, lon) {
  const wp = { lat, lon, marker: null };
  state.waypoints.push(wp);
  const marker = L.marker([lat, lon], {
    icon: makeIcon('#64748b', 10), // refreshed afterwards
    draggable: true,
  }).addTo(state.map);
  marker.on('dragend', () => {
    pushUndo();
    ensureRoutedMode();
    const ll = marker.getLatLng();
    wp.lat = ll.lat;
    wp.lon = ll.lng;
    const idx = state.waypoints.indexOf(wp);
    if (idx > 0)                          state.legCache[idx - 1] = null;
    if (idx < state.waypoints.length - 1) state.legCache[idx]     = null;
    refreshAllIcons();
    renderWaypointList();
    scheduleRoute();
  });
  marker.on('mouseover', () => {
    const i = state.waypoints.indexOf(wp);
    if (i >= 0) highlightWaypoint(i);
  });
  marker.on('mouseout', () => {
    const i = state.waypoints.indexOf(wp);
    if (i >= 0) unhighlightWaypoint(i);
  });
  wp.marker = marker;
  return wp;
}

export function addWaypoint(lat, lon) {
  pushUndo();
  ensureRoutedMode();
  _addWaypointRaw(lat, lon);
  state.legCache.push(null);
  if (state.waypoints.length > 2) state.wpListExpanded = true;
  refreshAllIcons();
  renderWaypointList();
  scheduleRoute();
}

export function removeWaypoint(i) {
  pushUndo();
  ensureRoutedMode();
  const n = state.waypoints.length;
  if (i === 0)        state.legCache.splice(0, 1);
  else if (i === n-1) state.legCache.splice(n - 2, 1);
  else { state.legCache.splice(i, 1); state.legCache[i - 1] = null; }
  state.map.removeLayer(state.waypoints[i].marker);
  state.waypoints.splice(i, 1);
  refreshAllIcons();
  renderWaypointList();
  scheduleRoute();
}

export function reverseWaypoints() {
  if (state.waypoints.length < 2) return;
  pushUndo();
  ensureRoutedMode();
  state.waypoints.reverse();
  state.legCache = new Array(state.waypoints.length - 1).fill(null);
  state.waypoints.forEach(w => w.marker.setLatLng([w.lat, w.lon]));
  refreshAllIcons();
  renderWaypointList();
  scheduleRoute();
}

export function clearAllWaypoints() {
  if (!state.waypoints.length) return;
  pushUndo();
  state.waypoints.forEach(w => state.map.removeLayer(w.marker));
  state.waypoints = [];
  state.routeSource = 'brouter';
  state.legCache = [];
  state.wpListExpanded = false;
  renderWaypointList();
  if (state.routeLayer)    { state.map.removeLayer(state.routeLayer);    state.routeLayer    = null; }
  if (state.routeInfoLayer){ state.map.removeLayer(state.routeInfoLayer); state.routeInfoLayer = null; }
  if (state.routeInfoHandler) {
    state.map.off('zoomend', state.routeInfoHandler);
    state.routeInfoHandler = null;
  }
  if (state.routeHitLayer) { state.map.removeLayer(state.routeHitLayer); state.routeHitLayer = null; }
  state.routeGeom = null; state.routeWpSegs = null;
  removeSelectionOverlay();
  state.elevSelection = null; state.routeBounds = null; state.routeSegments = null;
  state.fitRouteControl.setEnabled(false);
  document.getElementById('stats').style.display = 'none';
  setStatus('', '');
  clearElevationProfile();
  clearSavedRoute();
}

export function replaceWaypoints(points, expand = false) {
  state.waypoints.forEach(w => state.map.removeLayer(w.marker));
  state.waypoints = [];
  state.legCache = new Array(Math.max(0, points.length - 1)).fill(null);
  for (const { lat, lon } of points) _addWaypointRaw(lat, lon);
  state.wpListExpanded = expand;
  refreshAllIcons();
  renderWaypointList();
}

// ── Waypoint list rendering ────────────────────────────────────────────────

export function makeWpRow(w, i) {
  const n = state.waypoints.length;
  const color = i === 0 ? '#16a34a' : i === n - 1 ? '#dc2626' : '#64748b';
  const large = (i === 0 || i === n - 1);
  const row = document.createElement('div');
  row.className = 'wp-row';
  row.dataset.idx = i;
  row.draggable = true;
  row.innerHTML = `
    <div class="wp-handle" title="Drag to reorder">⠿</div>
    <div class="wp-dot${large ? ' large' : ''}" style="background:${color}"></div>
    <div class="wp-coords">${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}</div>
    <div class="wp-btns">
      <button data-action="rm" data-idx="${i}" title="Remove">✕</button>
    </div>`;

  row.addEventListener('mouseenter', () => { if (state.dragSrcIdx === null) highlightWaypoint(i); });
  row.addEventListener('mouseleave', () => unhighlightWaypoint(i));

  row.addEventListener('dragstart', e => {
    state.dragSrcIdx = i;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', i);
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    document.querySelectorAll('.wp-row.drag-over').forEach(r => r.classList.remove('drag-over'));
    state.dragSrcIdx = null;
  });
  row.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.wp-row.drag-over').forEach(r => r.classList.remove('drag-over'));
    if (i !== state.dragSrcIdx) row.classList.add('drag-over');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
  row.addEventListener('drop', e => {
    e.preventDefault();
    row.classList.remove('drag-over');
    if (state.dragSrcIdx === null || state.dragSrcIdx === i) return;
    pushUndo();
    ensureRoutedMode();
    const [moved] = state.waypoints.splice(state.dragSrcIdx, 1);
    state.waypoints.splice(i, 0, moved);
    state.legCache = new Array(state.waypoints.length - 1).fill(null);
    refreshAllIcons();
    renderWaypointList();
    scheduleRoute();
  });

  return row;
}

export function renderWaypointList() {
  const list = document.getElementById('waypoint-list');
  list.innerHTML = '';
  const n = state.waypoints.length;
  const viaCount = Math.max(0, n - 2);
  const collapsed = viaCount > 0 && !state.wpListExpanded;

  const indices = collapsed
    ? [0, n - 1]
    : state.waypoints.map((_, i) => i);

  indices.forEach((i, pos) => {
    list.appendChild(makeWpRow(state.waypoints[i], i));

    if (collapsed && pos === 0) {
      const pill = document.createElement('div');
      pill.className = 'wp-via-pill';
      pill.title = 'Click to expand via points';
      pill.innerHTML = `<span class="pill-dots">···</span><span>${viaCount} via point${viaCount > 1 ? 's' : ''}</span><span class="pill-dots">···</span>`;
      pill.addEventListener('click', () => { state.wpListExpanded = true; renderWaypointList(); });
      list.appendChild(pill);
    }
  });

  if (!collapsed && viaCount > 0) {
    const pill = document.createElement('div');
    pill.className = 'wp-via-pill';
    pill.title = 'Click to collapse via points';
    pill.innerHTML = `<span class="pill-dots">···</span><span>collapse</span><span class="pill-dots">···</span>`;
    pill.addEventListener('click', () => { state.wpListExpanded = false; renderWaypointList(); });
    list.appendChild(pill);
  }

  document.getElementById('btn-reverse').disabled   = n < 2;
  document.getElementById('btn-clear-all').disabled = n === 0;
}
