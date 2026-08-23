import { state } from './state.js';
import { initControls } from './controls.js';

import { renderWaypointList, addWaypoint, removeWaypoint, reverseWaypoints, clearAllWaypoints, closeLoop, insertWaypointAt, undo, _addWaypointRaw, replaceWaypoints } from './waypoints.js';
import { makeLocationIcon, refreshAllIcons } from './icons.js';
import { buildRouteParams, currentLonlats, scheduleRoute, renderRoute, stitchLegs, getProfileOverrides, clearRenderedRouteOnly, getRouteContextInsertion, routeContextKey, invalidateRouteWork } from './route.js';
import { renderChart, initElevModeButtons } from './elevation.js';
import { initGeocoder } from './geocoder.js';
import { setStatus, saveRoute, clearSavedRoute, storageKey } from './utils.js';
import { parseGpxString, buildSmartWaypointsFromGeoJson } from './gpx.js';
import { geometryLengthMeters, geometryParts } from './geometry.js';

// ── Map setup ──────────────────────────────────────────────────────────────

state.map = L.map('map', { doubleClickZoom: true }).setView([51.0, 10.0], 6);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
}).addTo(state.map);

state.map.locate({ setView: true, maxZoom: 13 });
state.map.on('locationerror', () => { /* keep default view on error */ });

// ── Controls ───────────────────────────────────────────────────────────────

initControls();

if (!(state.poiStore instanceof Map)) state.poiStore = new Map();
if (!(state.poiTypes instanceof Set)) state.poiTypes = new Set(['water', 'food', 'shelter']);
if (!Array.isArray(state.selectedPois)) state.selectedPois = [];
if (typeof state.poiEnabled !== 'boolean') state.poiEnabled = false;

// ── Location marker (updated on every locate) ────────────────────────────

state.map.on('locationfound', e => {
  if (state.locationMarker) {
    state.locationMarker.setLatLng(e.latlng);
    state.locationAccCircle.setLatLng(e.latlng).setRadius(e.accuracy / 2);
  } else {
    state.locationAccCircle = L.circle(e.latlng, {
      radius: e.accuracy / 2,
      color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.08, weight: 1,
    }).addTo(state.map);
    state.locationMarker = L.marker(e.latlng, {
      icon: makeLocationIcon(),
      zIndexOffset: -100,
      interactive: false,
    }).addTo(state.map);
  }
});

// ── Map click — add waypoint (with dblclick guard) ────────────────────────

state.map.on('click', e => {
  if (!state.addingMode) return;
  if (state.clickTimer) {
    clearTimeout(state.clickTimer);
    state.clickTimer = null;
    return;
  }
  const { lat, lng } = e.latlng;
  state.clickTimer = setTimeout(() => {
    state.clickTimer = null;
    addWaypoint(lat, lng);
    updateAddPreview(e.latlng);
  }, 250);
});

state.map.on('mousemove', e => {
  updateAddPreview(e.latlng);
});

state.map.on('dblclick', () => {
  if (state.clickTimer) { clearTimeout(state.clickTimer); state.clickTimer = null; }
});

const ctxMenu = document.getElementById('context-menu');

function hideContextMenu() {
  ctxMenu.style.display = 'none';
  ctxMenu.innerHTML = '';
}

function clearAddPreview() {
  if (state.addPreviewLine) {
    state.map.removeLayer(state.addPreviewLine);
    state.addPreviewLine = null;
  }
  if (state.addPreviewLabel) {
    state.map.removeLayer(state.addPreviewLabel);
    state.addPreviewLabel = null;
  }
}

function clipLineToViewport(startPx, endPx, size) {
  const dx = endPx.x - startPx.x;
  const dy = endPx.y - startPx.y;
  const p = [-dx, dx, -dy, dy];
  const q = [startPx.x, size.x - startPx.x, startPx.y, size.y - startPx.y];
  let t0 = 0;
  let t1 = 1;

  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
      continue;
    }
    const r = q[i] / p[i];
    if (p[i] < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return null;
  }

  return [
    L.point(startPx.x + t0 * dx, startPx.y + t0 * dy),
    L.point(startPx.x + t1 * dx, startPx.y + t1 * dy),
  ];
}

function updateAddPreview(latlng) {
  if (!state.addingMode || state.waypoints.length === 0) {
    clearAddPreview();
    return;
  }
  const last = state.waypoints[state.waypoints.length - 1];
  const start = L.latLng(last.lat, last.lon);
  const end = L.latLng(latlng.lat, latlng.lng);
  const distanceKm = (start.distanceTo(end) / 1000).toFixed(1);

  const size = state.map.getSize();
  const startPx = state.map.latLngToContainerPoint(start);
  const endPx = state.map.latLngToContainerPoint(end);
  const clipped = clipLineToViewport(startPx, endPx, size);

  let labelLatLng;
  if (clipped) {
    const midVisiblePx = L.point((clipped[0].x + clipped[1].x) / 2, (clipped[0].y + clipped[1].y) / 2);
    labelLatLng = state.map.containerPointToLatLng(midVisiblePx);
  } else {
    const midPx = L.point((startPx.x + endPx.x) / 2, (startPx.y + endPx.y) / 2);
    const clampedPx = L.point(
      Math.max(16, Math.min(size.x - 16, midPx.x)),
      Math.max(16, Math.min(size.y - 16, midPx.y)),
    );
    labelLatLng = state.map.containerPointToLatLng(clampedPx);
  }

  if (!state.addPreviewLine) {
    state.addPreviewLine = L.polyline([start, end], {
      color: '#0f172a',
      weight: 2,
      opacity: 0.85,
      dashArray: '6, 6',
      interactive: false,
    }).addTo(state.map);
  } else {
    state.addPreviewLine.setLatLngs([start, end]);
  }

  const labelHtml = `<div class="add-preview-label">${distanceKm} km</div>`;
  if (!state.addPreviewLabel) {
    state.addPreviewLabel = L.marker(labelLatLng, {
      icon: L.divIcon({ className: 'add-preview-icon', html: labelHtml, iconSize: null }),
      interactive: false,
      keyboard: false,
      zIndexOffset: 900,
    }).addTo(state.map);
  } else {
    state.addPreviewLabel.setLatLng(labelLatLng);
    state.addPreviewLabel.setIcon(L.divIcon({ className: 'add-preview-icon', html: labelHtml, iconSize: null }));
  }
}

async function copyCoords(lat, lon) {
  const txt = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  try {
    await navigator.clipboard.writeText(txt);
    setStatus(`Copied coordinates: ${txt}`, 'ok');
  } catch {
    setStatus('Could not copy coordinates to clipboard.', 'error');
  }
}

function showContextMenu(clientX, clientY, items) {
  ctxMenu.innerHTML = '';
  for (const item of items) {
    const btn = document.createElement('button');
    btn.className = 'ctx-menu-item';
    btn.textContent = item.label;
    btn.addEventListener('click', async () => {
      hideContextMenu();
      await item.action();
    });
    ctxMenu.appendChild(btn);
  }
  ctxMenu.style.display = 'block';
  ctxMenu.style.left = `${clientX}px`;
  ctxMenu.style.top = `${clientY}px`;
}

function updatePoiMarkedHint() {
  const el = document.getElementById('poi-marked');
  if (!el) return;
  el.textContent = `Marked POIs: ${state.selectedPois.length}`;
}

function poiIcon(category) {
  const cls = category === 'food' ? 'poi-food' : category === 'shelter' ? 'poi-shelter' : 'poi-water';
  return L.divIcon({
    className: 'poi-icon',
    html: `<div class="poi-pin ${cls}"></div>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  });
}

function isPoiMarked(poi) {
  return state.selectedPois.some(p => p.id === poi.id);
}

function toggleMarkPoi(poi) {
  const idx = state.selectedPois.findIndex(p => p.id === poi.id);
  if (idx >= 0) state.selectedPois.splice(idx, 1);
  else state.selectedPois.push({
    id: poi.id,
    name: poi.name,
    category: poi.category,
    lat: poi.lat,
    lon: poi.lon,
  });
  updatePoiMarkedHint();
}

function bindPoiPopup(marker, poi) {
  const marked = isPoiMarked(poi);
  const markLabel = marked ? 'Unmark for GPX' : 'Mark for GPX';
  const root = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'poi-popup-title';
  title.textContent = poi.name;
  root.appendChild(title);
  const meta = document.createElement('div');
  meta.className = 'poi-popup-meta';
  meta.textContent = poi.category;
  root.appendChild(meta);
  const makeButton = (action, label) => {
    const button = document.createElement('button');
    button.className = 'poi-popup-btn';
    button.dataset.action = action;
    button.textContent = label;
    root.appendChild(button);
    return button;
  };
  const markBtn = makeButton('mark', markLabel);
  const copyBtn = makeButton('copy', 'Copy coords');
  const addWpBtn = makeButton('add-waypoint', 'Add as waypoint');
  markBtn.addEventListener('click', () => {
      toggleMarkPoi(poi);
      marker.closePopup();
    });
  copyBtn.addEventListener('click', () => {
      copyCoords(poi.lat, poi.lon);
      marker.closePopup();
    });
  addWpBtn.addEventListener('click', () => {
      if (!isPoiMarked(poi)) toggleMarkPoi(poi);
      addWaypoint(poi.lat, poi.lon);
      marker.closePopup();
    });
  marker.bindPopup(root);
}

function clearPoiLayer() {
  if (!state.poiLayer) return;
  state.map.removeLayer(state.poiLayer);
  state.poiLayer = null;
}

function normalizePoiFeature(f) {
  const coords = f?.geometry?.coordinates;
  if (!coords || coords.length < 2) return null;
  return {
    id: f.properties?.id || f.id,
    name: f.properties?.name || 'POI',
    category: f.properties?.category || 'water',
    lon: Number(coords[0]),
    lat: Number(coords[1]),
  };
}

function updatePoiStore(fc) {
  for (const f of (fc?.features || [])) {
    const poi = normalizePoiFeature(f);
    if (!poi?.id || !Number.isFinite(poi.lat) || !Number.isFinite(poi.lon)) continue;
    state.poiStore.set(poi.id, poi);
  }
}

function renderPoisFromStore() {
  clearPoiLayer();
  state.poiLayer = L.layerGroup();
  for (const poi of state.poiStore.values()) {
    const m = L.marker([poi.lat, poi.lon], { icon: poiIcon(poi.category) });
    bindPoiPopup(m, poi);
    state.poiLayer.addLayer(m);
  }
  state.poiLayer.addTo(state.map);
}

async function fetchPoisNow(seq) {
  if (!state.poiEnabled) {
    clearPoiLayer();
    return;
  }
  const bounds = state.map.getBounds();
  const zoom = state.map.getZoom();
  const types = [...state.poiTypes].join(',');
  const statusEl = document.getElementById('poi-status');
  const controller = new AbortController();
  state.poiAbortController = controller;
  if (statusEl) statusEl.textContent = 'Loading POIs…';
  try {
    const bbox = [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()].join(',');
    const resp = await fetch(`/pois?bbox=${encodeURIComponent(bbox)}&zoom=${zoom}&types=${encodeURIComponent(types)}`, { signal: controller.signal });
    const payload = await resp.json();
    if (seq !== state.poiRequestSeq || controller.signal.aborted || !state.poiEnabled) return;
    if (!resp.ok) throw new Error(payload.error || 'POI request failed');
    if (payload.zoom_blocked) {
      clearPoiLayer();
      state.poiStore.clear();
      if (statusEl) statusEl.textContent = `Zoom in to at least z${payload.min_zoom} to show POIs.`;
      return;
    }
    state.poiStore.clear();
    updatePoiStore(payload);
    renderPoisFromStore();
    if (statusEl) statusEl.textContent = `POIs visible: ${state.poiStore.size}`;
  } catch (e) {
    if (e.name !== 'AbortError' && seq === state.poiRequestSeq && statusEl) statusEl.textContent = `POI load failed: ${e.message}`;
  } finally {
    if (seq === state.poiRequestSeq) state.poiAbortController = null;
  }
}

function schedulePoiFetch() {
  if (state.poiFetchTimer) clearTimeout(state.poiFetchTimer);
  state.poiAbortController?.abort();
  state.poiRequestSeq += 1;
  const seq = state.poiRequestSeq;
  state.poiFetchTimer = setTimeout(() => fetchPoisNow(seq), 220);
}

const POI_PREFS_KEY = 'brouter-poi-prefs';

function loadPoiPrefs() {
  try {
    const raw = localStorage.getItem(POI_PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function savePoiPrefs() {
  try {
    localStorage.setItem(POI_PREFS_KEY, JSON.stringify({
      enabled: !!state.poiEnabled,
      types: [...state.poiTypes],
    }));
  } catch {
    // ignore localStorage errors (quota/privacy mode)
  }
}

function initPois() {
  const prefs = loadPoiPrefs();
  const enabledEl = document.getElementById('poi-enabled');
  if (enabledEl && typeof prefs.enabled === 'boolean') enabledEl.checked = prefs.enabled;
  state.poiEnabled = !!enabledEl?.checked;
  enabledEl?.addEventListener('change', e => {
    state.poiEnabled = e.target.checked;
    if (!state.poiEnabled) {
      state.poiAbortController?.abort();
      state.poiStore.clear();
      clearPoiLayer();
    }
    savePoiPrefs();
    schedulePoiFetch();
  });

  if (!(state.poiTypes instanceof Set)) state.poiTypes = new Set();
  else state.poiTypes.clear();
  const hasTypePrefs = Array.isArray(prefs.types);
  const prefTypes = hasTypePrefs ? new Set(prefs.types) : null;
  const wireType = (id, t) => {
    const el = document.getElementById(id);
    if (el && hasTypePrefs) el.checked = prefTypes.has(t);
    if (el?.checked) state.poiTypes.add(t);
    el?.addEventListener('change', e => {
      if (e.target.checked) state.poiTypes.add(t);
      else state.poiTypes.delete(t);
      savePoiPrefs();
      schedulePoiFetch();
    });
  };
  wireType('poi-water', 'water');
  wireType('poi-food', 'food');
  wireType('poi-shelter', 'shelter');
  savePoiPrefs();

  state.map.on('moveend', schedulePoiFetch);
  state.map.on('zoomend', schedulePoiFetch);
  updatePoiMarkedHint();
  schedulePoiFetch();
}

document.addEventListener('click', hideContextMenu);
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideContextMenu(); });

state.map.on('contextmenu', e => {
  const { lat, lng } = e.latlng;
  const insert = state.routeGeom ? getRouteContextInsertion(lat, lng) : null;
  const pixel = state.map.latLngToContainerPoint([lat, lng]);

  let nearWpIdx = -1;
  for (let i = 0; i < state.waypoints.length; i++) {
    const wpPx = state.map.latLngToContainerPoint([state.waypoints[i].lat, state.waypoints[i].lon]);
    const dx = wpPx.x - pixel.x;
    const dy = wpPx.y - pixel.y;
    if (dx * dx + dy * dy < 13 * 13) {
      nearWpIdx = i;
      break;
    }
  }

  const onRoute = !!insert && (() => {
    const routePx = state.map.latLngToContainerPoint([insert.snapLat, insert.snapLon]);
    const dx = routePx.x - pixel.x;
    const dy = routePx.y - pixel.y;
    return dx * dx + dy * dy < 14 * 14;
  })();

  let menuLat = lat;
  let menuLon = lng;
  const items = [];

  if (nearWpIdx >= 0) {
    menuLat = state.waypoints[nearWpIdx].lat;
    menuLon = state.waypoints[nearWpIdx].lon;
    items.push({ label: 'Delete waypoint', action: () => removeWaypoint(nearWpIdx) });
    items.push({ label: 'Copy coordinates', action: () => copyCoords(menuLat, menuLon) });
  } else if (onRoute && insert) {
    menuLat = insert.snapLat;
    menuLon = insert.snapLon;
    items.push({ label: 'Insert waypoint here', action: () => insertWaypointAt(insert.insertIdx, insert.snapLat, insert.snapLon) });
    items.push({ label: 'Copy coordinates', action: () => copyCoords(menuLat, menuLon) });
  } else {
    items.push({ label: 'Append waypoint here', action: () => addWaypoint(lat, lng) });
    items.push({ label: 'Copy coordinates', action: () => copyCoords(lat, lng) });
  }

  L.DomEvent.stopPropagation(e.originalEvent);
  L.DomEvent.preventDefault(e.originalEvent);
  showContextMenu(e.originalEvent.clientX, e.originalEvent.clientY, items);
});

document.addEventListener('waypoint-contextmenu', e => {
  const d = e.detail;
  if (!d) return;
  const p = state.map.latLngToContainerPoint([d.lat, d.lon]);
  const mapRect = state.map.getContainer().getBoundingClientRect();
  showContextMenu(mapRect.left + p.x, mapRect.top + p.y, [
    { label: 'Delete waypoint', action: () => removeWaypoint(d.idx) },
    { label: 'Copy coordinates', action: () => copyCoords(d.lat, d.lon) },
  ]);
});

// ── Waypoint control buttons ───────────────────────────────────────────────

document.getElementById('btn-add-waypoint').addEventListener('click', () => {
  state.addingMode = !state.addingMode;
  document.getElementById('btn-add-waypoint').classList.toggle('active', state.addingMode);
  document.getElementById('btn-add-waypoint').setAttribute('aria-pressed', String(state.addingMode));
  state.map.getContainer().classList.toggle('picking-cursor', state.addingMode);
  if (!state.addingMode) clearAddPreview();
  setStatus(state.addingMode ? 'Click on the map to add waypoints. Press Esc to stop.' : '', state.addingMode ? 'info' : '');
});

document.getElementById('btn-reverse').addEventListener('click', reverseWaypoints);
document.getElementById('btn-close-loop').addEventListener('click', closeLoop);
document.getElementById('btn-clear-all').addEventListener('click', clearAllWaypoints);
document.getElementById('btn-toggle-waypoints').addEventListener('click', () => {
  state.wpListVisible = !state.wpListVisible;
  renderWaypointList();
});

// Event delegation for remove button in waypoint list
document.getElementById('waypoint-list').addEventListener('click', e => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const idx = parseInt(btn.dataset.idx, 10);
  if (btn.dataset.action === 'rm') removeWaypoint(idx);
  if (btn.dataset.action === 'up' && idx > 0) {
    state.dragSrcIdx = idx;
    document.querySelector(`.wp-row[data-idx="${idx - 1}"]`)?.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    state.dragSrcIdx = null;
  }
  if (btn.dataset.action === 'down' && idx < state.waypoints.length - 1) {
    state.dragSrcIdx = idx;
    document.querySelector(`.wp-row[data-idx="${idx + 1}"]`)?.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    state.dragSrcIdx = null;
  }
});

// ── Keyboard shortcuts ─────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    state.addingMode = false;
    document.getElementById('btn-add-waypoint').classList.remove('active');
    state.map.getContainer().classList.remove('picking-cursor');
    clearAddPreview();
    setStatus('', '');
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    undo();
  }
});

// ── Profile params ─────────────────────────────────────────────────────────

function isChanged(input) {
  if (input.type === 'checkbox')
    return input.checked !== (input.dataset.default === 'true');
  return String(input.value) !== String(input.dataset.default);
}

function saveProfileOverrides(profile) {
  const saved = {};
  document.querySelectorAll('[data-param]').forEach(input => {
    if (isChanged(input))
      saved[input.dataset.param] = input.type === 'checkbox' ? input.checked : input.value;
  });
  if (Object.keys(saved).length)
    localStorage.setItem(storageKey(profile), JSON.stringify(saved));
  else
    localStorage.removeItem(storageKey(profile));
}

function loadedOverrides(profile) {
  try { return JSON.parse(localStorage.getItem(storageKey(profile))) || {}; }
  catch { return {}; }
}

function updateChangedBadge() {
  document.getElementById('changed-badge').style.display =
    getProfileOverrides().length > 0 ? 'inline' : 'none';
}

async function loadProfileParams(profile) {
  state.profileParamsRequestSeq += 1;
  const seq = state.profileParamsRequestSeq;
  state.profileParamsAbortController?.abort();
  const controller = new AbortController();
  state.profileParamsAbortController = controller;
  state.profileParamsReady = false;
  const body = document.getElementById('profile-settings-body');
  body.replaceChildren();
  const loading = document.createElement('div');
  loading.id = 'params-loading';
  loading.textContent = 'Loading…';
  body.appendChild(loading);
  updateChangedBadge();
  try {
    const resp = await fetch(`/profile-params/${encodeURIComponent(profile)}`, { signal: controller.signal });
    const params = await resp.json();
    if (!resp.ok) throw new Error(params.error || 'Failed to load params');
    if (seq !== state.profileParamsRequestSeq || controller.signal.aborted || document.getElementById('profile').value !== profile) return false;
    state.profileParams = params;
    state.profileParamsProfile = profile;
    state.profileParamsReady = true;
  } catch (err) {
    if (err.name === 'AbortError' || seq !== state.profileParamsRequestSeq) return false;
    loading.style.color = '#fca5a5';
    loading.textContent = 'Failed to load params.';
    return false;
  }
  renderProfileParams(profile);
  return true;
}

function renderProfileParams(profile) {
  const body = document.getElementById('profile-settings-body');
  if (!state.profileParams.length) {
    body.replaceChildren();
    const empty = document.createElement('div');
    empty.id = 'params-loading';
    empty.textContent = 'No configurable parameters.';
    body.appendChild(empty);
    return;
  }
  const saved = loadedOverrides(profile);
  body.replaceChildren();
  for (const p of state.profileParams) {
    const row = document.createElement('div');
    const savedVal = saved[p.name];
    const inputId = `profile-param-${body.children.length}`;
    const label = document.createElement('label');
    label.htmlFor = inputId;
    label.textContent = p.name;
    const addDescription = () => {
      const desc = document.createElement('div');
      desc.className = 'param-desc';
      desc.textContent = p.description;
      row.appendChild(desc);
    };
    let input;
    if (p.kind === 'boolean') {
      const checked = savedVal !== undefined ? savedVal : p.default;
      row.className = 'param-row bool-row';
      label.title = p.description;
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!checked;
    } else if (p.kind === 'number') {
      const val = savedVal !== undefined ? savedVal : p.default;
      row.className = 'param-row';
      input = document.createElement('input');
      input.type = 'number';
      input.step = 'any';
      input.value = val;
    } else if (p.kind === 'enum') {
      const val = savedVal !== undefined ? savedVal : p.default;
      row.className = 'param-row';
      input = document.createElement('select');
      for (const o of p.options) {
        const option = document.createElement('option');
        option.value = o.value;
        option.textContent = `${o.value} — ${o.label}`;
        option.selected = String(o.value) === String(val);
        input.appendChild(option);
      }
    } else {
      const val = savedVal !== undefined ? savedVal : p.default;
      row.className = 'param-row';
      input = document.createElement('input');
      input.type = 'text';
      input.value = val;
    }
    input.id = inputId;
    input.dataset.param = p.name;
    input.dataset.default = p.default;
    row.appendChild(label);
    if (p.kind === 'number' || p.kind === 'enum') addDescription();
    row.appendChild(input);
    body.appendChild(row);
    if (isChanged(input)) row.classList.add('param-changed');
    input.addEventListener('change', () => {
      row.classList.toggle('param-changed', isChanged(input));
      saveProfileOverrides(profile);
      updateChangedBadge();
      scheduleRoute();
    });
  }
  updateChangedBadge();
}

document.getElementById('btn-reset-params').addEventListener('click', () => {
  const profile = document.getElementById('profile').value;
  document.querySelectorAll('[data-param]').forEach(input => {
    if (input.type === 'checkbox') input.checked = input.dataset.default === 'true';
    else input.value = input.dataset.default;
    input.closest('.param-row').classList.remove('param-changed');
  });
  localStorage.removeItem(storageKey(profile));
  updateChangedBadge();
  scheduleRoute();
});

// ── Route persistence ──────────────────────────────────────────────────────

function restoreRoute() {
  try {
    const raw = localStorage.getItem('brouter-route');
    if (!raw) return;
    const saved = JSON.parse(raw);
    const { wps, cache, context } = saved;
    if (saved.version !== 2 || saved.source !== 'brouter' || !context || routeContextKey(context) !== routeContextKey()) return;
    if (!wps || wps.length < 2 || cache.length !== wps.length - 1) return;
    for (const { lat, lon } of wps) _addWaypointRaw(lat, lon);
    state.legCache = cache;
    refreshAllIcons();
    renderWaypointList();
    renderRoute(stitchLegs(state.legCache), true);
    setStatus('Route restored.', 'ok');
  } catch(e) {
    console.warn('restoreRoute failed:', e);
    clearSavedRoute();
  }
}

async function enrichImportedSurface(geojson, signal) {
  const parts = geometryParts(geojson);
  let offset = 0;
  const surfaceSegments = [];
  let high = 0, medium = 0, low = 0;
  for (const coordinates of parts) {
    const body = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: {} }] };
    const resp = await fetch('/surface-enrich', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    const payload = await resp.json();
    if (!resp.ok) throw new Error(payload.error || 'Surface enrichment failed');
    for (const segment of payload.surface_segments || []) {
      surfaceSegments.push({ ...segment, dist_start_m: segment.dist_start_m + offset, dist_end_m: segment.dist_end_m + offset });
    }
    const len = Number(payload.track_length_m) || geometryLengthMeters({ type: 'LineString', coordinates });
    high += len * (payload.surface_stats?.highPct || 0) / 100;
    medium += len * (payload.surface_stats?.mediumPct || 0) / 100;
    low += len * (payload.surface_stats?.lowPct || 0) / 100;
    offset += len;
  }
  const denom = offset || 1;
  return {
    surfaceSegments,
    surfaceStats: { highPct: Math.round(high / denom * 100), mediumPct: Math.round(medium / denom * 100), lowPct: Math.round(low / denom * 100) },
    trackLength: offset,
  };
}

function initGpxImport() {
  const btn = document.getElementById('btn-import-gpx');
  const input = document.getElementById('gpx-file-input');
  const enrichProgress = document.getElementById('surface-enrich-progress');

  btn.addEventListener('click', () => input.click());

  input.addEventListener('change', async () => {
    invalidateRouteWork();
    const seq = state.gpxImportSeq;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setStatus('GPX import failed: file exceeds 2 MB.', 'error');
      input.value = '';
      return;
    }

    try {
      const xml = await file.text();
      if (seq !== state.gpxImportSeq) return;
      const parsed = parseGpxString(xml);
      const waypoints = buildSmartWaypointsFromGeoJson(parsed.geojson);

      if (waypoints.length < 2) throw new Error('Could not derive waypoints from GPX');

      clearRenderedRouteOnly();
      state.routeSource = 'imported';
      state.importedRoute = { originalXml: xml, fileName: file.name, geojson: parsed.geojson };
      state.undoStack = [];
      replaceWaypoints(waypoints, false);
      parsed.geojson.features[0].properties['track-length'] = geometryLengthMeters(parsed.geojson);
      renderRoute(parsed.geojson, true);

      const viaCount = Math.max(0, waypoints.length - 2);
      const name = parsed.name ? ` "${parsed.name}"` : '';
      const sm = waypoints.meta;
      const smartInfo = sm
        ? ` Smart: ${sm.selectedCount} pts (cap ${sm.adaptiveCap}, spacing ${(sm.adaptiveSpacingM / 1000).toFixed(1)} km).`
        : '';
      setStatus(`Loaded GPX${name}: ${waypoints.length} waypoints (${viaCount} via).${smartInfo} Fetching surface details…`, 'info');

      enrichProgress.style.display = 'inline-flex';
      try {
        const controller = new AbortController();
        state.gpxAbortController = controller;
        const enrich = await enrichImportedSurface(parsed.geojson, controller.signal);
        if (seq === state.gpxImportSeq && state.routeSource === 'imported') {
          parsed.geojson.features[0].properties.surface_segments = enrich.surfaceSegments || [];
          parsed.geojson.features[0].properties.surface_stats = enrich.surfaceStats || null;
          parsed.geojson.features[0].properties['track-length'] = enrich.trackLength;
          state.importedRoute.geojson = parsed.geojson;
          renderRoute(parsed.geojson, false);
          setStatus(`Loaded GPX${name}: ${waypoints.length} waypoints (${viaCount} via).${smartInfo}`, 'ok');
        }
      } catch (err) {
        if (err.name !== 'AbortError' && seq === state.gpxImportSeq) setStatus('Surface enrichment failed. Route loaded without detailed surface tags.', 'info');
      } finally {
        if (seq === state.gpxImportSeq) enrichProgress.style.display = 'none';
      }
    } catch (err) {
      if (seq === state.gpxImportSeq) {
        enrichProgress.style.display = 'none';
        setStatus(`GPX import failed: ${err.message}`, 'error');
      }
    } finally {
      input.value = '';
    }
  });
}

// ── Track name ─────────────────────────────────────────────────────────────

function defaultTrackName() {
  const profile = document.getElementById('profile').value;
  const now     = new Date();
  const date    = now.toLocaleDateString('sv');
  const time    = now.toTimeString().slice(0, 5).replace(':', 'h');
  return `${profile}-${date}-${time}`;
}

function refreshTrackName() {
  document.getElementById('trackname').value = defaultTrackName();
}

// ── Profile select ─────────────────────────────────────────────────────────

refreshTrackName();
const savedProfile = localStorage.getItem('brouter-profile');
if (savedProfile && document.querySelector(`#profile option[value="${savedProfile}"]`))
  document.getElementById('profile').value = savedProfile;
const initialProfileLoad = loadProfileParams(document.getElementById('profile').value);

document.getElementById('profile').addEventListener('change', e => {
  localStorage.setItem('brouter-profile', e.target.value);
  refreshTrackName();
  invalidateRouteWork();
  loadProfileParams(e.target.value).then(loaded => { if (loaded) scheduleRoute(); });
});
document.getElementById('alternativeidx').addEventListener('change', scheduleRoute);

// ── Download button ────────────────────────────────────────────────────────

document.getElementById('btn-download').addEventListener('click', () => {
  if (state.waypoints.length < 2) return;
  const fmt       = document.getElementById('format').value;
  const trackname = document.getElementById('trackname').value.trim() || defaultTrackName();
  if (state.routeSource === 'imported' && state.importedRoute && fmt === 'gpx' && !state.selectedPois.length) {
    const blob = new Blob([state.importedRoute.originalXml], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = state.importedRoute.fileName || `${trackname}.gpx`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return;
  }
  const qs = buildRouteParams(currentLonlats(), fmt);
  qs.set('trackname', trackname);
  if (fmt === 'gpx' && state.selectedPois.length) qs.set('selected_pois', JSON.stringify(state.selectedPois));
  window.location.href = `/download?${qs}`;
});

// ── Elevation panel toggle ─────────────────────────────────────────────────

initElevModeButtons();

document.getElementById('btn-toggle-panel').addEventListener('click', () => {
  const panel     = document.getElementById('profile-panel');
  const collapsed = panel.classList.toggle('collapsed');
  document.getElementById('btn-toggle-panel').textContent = collapsed ? '▲ Show' : '▼ Hide';
  document.getElementById('btn-toggle-panel').setAttribute('aria-expanded', String(!collapsed));
  setTimeout(() => { state.map.invalidateSize(); if (!collapsed && state.elevData) renderChart(); }, 50);
});

// ── Sidebar toggle ─────────────────────────────────────────────────────────

document.getElementById('sidebar-toggle').addEventListener('click', () => {
  const sidebar   = document.getElementById('sidebar');
  const collapsed = sidebar.classList.toggle('collapsed');
  document.getElementById('sidebar-toggle').textContent = collapsed ? '›' : '‹';
  document.getElementById('sidebar-toggle').title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  document.getElementById('sidebar-toggle').setAttribute('aria-expanded', String(!collapsed));
  document.getElementById('sidebar-toggle').setAttribute('aria-label', collapsed ? 'Expand route planning controls' : 'Collapse route planning controls');
  setTimeout(() => { state.map.invalidateSize(); if (state.elevData) renderChart(); }, 260);
});

if (window.matchMedia('(max-width: 760px)').matches) {
  document.getElementById('sidebar').classList.add('collapsed');
  document.getElementById('sidebar-toggle').setAttribute('aria-expanded', 'false');
  document.getElementById('sidebar-toggle').setAttribute('aria-label', 'Expand route planning controls');
}

// Re-render chart on resize
window.addEventListener('resize', () => { if (state.elevData) renderChart(); });

// ── Geocoder ───────────────────────────────────────────────────────────────

initGeocoder();
initGpxImport();
initPois();

// ── Restore saved route ────────────────────────────────────────────────────

initialProfileLoad.then(loaded => { if (loaded) restoreRoute(); });
