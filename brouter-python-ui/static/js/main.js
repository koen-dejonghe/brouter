import { state } from './state.js';
import { initControls } from './controls.js';

import { renderWaypointList, addWaypoint, removeWaypoint, reverseWaypoints, clearAllWaypoints, undo, _addWaypointRaw, replaceWaypoints } from './waypoints.js';
import { makeLocationIcon, refreshAllIcons } from './icons.js';
import { buildRouteParams, currentLonlats, scheduleRoute, renderRoute, stitchLegs, getProfileOverrides, clearRenderedRouteOnly } from './route.js';
import { renderChart, clearElevationProfile, initElevModeButtons } from './elevation.js';
import { initGeocoder } from './geocoder.js';
import { setStatus, saveRoute, clearSavedRoute, storageKey } from './utils.js';
import { parseGpxString, buildRegularWaypointsFromGeoJson } from './gpx.js';

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
  }, 250);
});

state.map.on('dblclick', () => {
  if (state.clickTimer) { clearTimeout(state.clickTimer); state.clickTimer = null; }
});

// ── Waypoint control buttons ───────────────────────────────────────────────

document.getElementById('btn-add-waypoint').addEventListener('click', () => {
  state.addingMode = !state.addingMode;
  document.getElementById('btn-add-waypoint').classList.toggle('active', state.addingMode);
  state.map.getContainer().classList.toggle('picking-cursor', state.addingMode);
  setStatus(state.addingMode ? 'Click on the map to add waypoints. Press Esc to stop.' : '', state.addingMode ? 'info' : '');
});

document.getElementById('btn-reverse').addEventListener('click', reverseWaypoints);
document.getElementById('btn-clear-all').addEventListener('click', clearAllWaypoints);

// Event delegation for remove button in waypoint list
document.getElementById('waypoint-list').addEventListener('click', e => {
  const btn = e.target.closest('button[data-action="rm"]');
  if (!btn) return;
  removeWaypoint(parseInt(btn.dataset.idx, 10));
});

// ── Keyboard shortcuts ─────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    state.addingMode = false;
    document.getElementById('btn-add-waypoint').classList.remove('active');
    state.map.getContainer().classList.remove('picking-cursor');
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
  const body = document.getElementById('profile-settings-body');
  body.innerHTML = '<div id="params-loading">Loading…</div>';
  updateChangedBadge();
  try {
    const resp = await fetch(`/profile-params/${encodeURIComponent(profile)}`);
    state.profileParams = await resp.json();
  } catch {
    body.innerHTML = '<div id="params-loading" style="color:#fca5a5">Failed to load params.</div>';
    return;
  }
  renderProfileParams(profile);
}

function renderProfileParams(profile) {
  const body = document.getElementById('profile-settings-body');
  if (!state.profileParams.length) {
    body.innerHTML = '<div id="params-loading">No configurable parameters.</div>';
    return;
  }
  const saved = loadedOverrides(profile);
  body.innerHTML = '';
  for (const p of state.profileParams) {
    const row = document.createElement('div');
    const savedVal = saved[p.name];
    if (p.kind === 'boolean') {
      const checked = savedVal !== undefined ? savedVal : p.default;
      row.className = 'param-row bool-row';
      row.innerHTML = `
        <label for="param-${p.name}" title="${p.description}">${p.name}</label>
        <input type="checkbox" id="param-${p.name}" data-param="${p.name}" data-default="${p.default}"
          ${checked ? 'checked' : ''} />`;
    } else if (p.kind === 'number') {
      const val = savedVal !== undefined ? savedVal : p.default;
      row.className = 'param-row';
      row.innerHTML = `
        <label for="param-${p.name}">${p.name}</label>
        <div class="param-desc">${p.description}</div>
        <input type="number" id="param-${p.name}" data-param="${p.name}" data-default="${p.default}"
          value="${val}" step="any" />`;
    } else if (p.kind === 'enum') {
      const val = savedVal !== undefined ? savedVal : p.default;
      const opts = p.options.map(o =>
        `<option value="${o.value}" ${String(o.value) === String(val) ? 'selected' : ''}>${o.value} — ${o.label}</option>`
      ).join('');
      row.className = 'param-row';
      row.innerHTML = `
        <label for="param-${p.name}">${p.name}</label>
        <div class="param-desc">${p.description}</div>
        <select id="param-${p.name}" data-param="${p.name}" data-default="${p.default}">${opts}</select>`;
    } else {
      const val = savedVal !== undefined ? savedVal : p.default;
      row.className = 'param-row';
      row.innerHTML = `
        <label for="param-${p.name}">${p.name}</label>
        <input type="text" id="param-${p.name}" data-param="${p.name}" data-default="${p.default}"
          value="${val}" />`;
    }
    body.appendChild(row);
    const input = row.querySelector('[data-param]');
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
    const { wps, cache } = JSON.parse(raw);
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

function startEndWaypointsFromGeoJson(geojson) {
  const coords = geojson?.features?.[0]?.geometry?.coordinates;
  if (!coords || coords.length < 2) return [];
  const first = coords[0];
  const last = coords[coords.length - 1];
  return [
    { lat: first[1], lon: first[0], auto: false },
    { lat: last[1], lon: last[0], auto: false },
  ];
}

function initGpxImport() {
  const btn = document.getElementById('btn-import-gpx');
  const input = document.getElementById('gpx-file-input');
  const chkRegular = document.getElementById('import-regular-vias');
  const inputKm = document.getElementById('import-via-km');

  btn.addEventListener('click', () => input.click());

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;

    try {
      const xml = await file.text();
      const parsed = parseGpxString(xml);
      const useRegular = chkRegular.checked;
      const km = Math.max(1, Number(inputKm.value) || 10);
      const waypoints = useRegular
        ? buildRegularWaypointsFromGeoJson(parsed.geojson, km)
        : startEndWaypointsFromGeoJson(parsed.geojson);

      if (waypoints.length < 2) throw new Error('Could not derive waypoints from GPX');

      clearRenderedRouteOnly();
      state.routeSource = 'imported';
      replaceWaypoints(waypoints, waypoints.length > 2);
      renderRoute(parsed.geojson, true);

      const viaCount = Math.max(0, waypoints.length - 2);
      const name = parsed.name ? ` "${parsed.name}"` : '';
      setStatus(`Loaded GPX${name}: ${waypoints.length} waypoints (${viaCount} via).`, 'ok');
    } catch (err) {
      setStatus(`GPX import failed: ${err.message}`, 'error');
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
loadProfileParams(document.getElementById('profile').value);

document.getElementById('profile').addEventListener('change', e => {
  localStorage.setItem('brouter-profile', e.target.value);
  refreshTrackName();
  loadProfileParams(e.target.value);
  scheduleRoute();
});
document.getElementById('alternativeidx').addEventListener('change', scheduleRoute);

// ── Download button ────────────────────────────────────────────────────────

document.getElementById('btn-download').addEventListener('click', () => {
  if (state.waypoints.length < 2) return;
  const fmt       = document.getElementById('format').value;
  const trackname = document.getElementById('trackname').value.trim() || defaultTrackName();
  const qs = buildRouteParams(currentLonlats(), fmt);
  qs.set('trackname', trackname);
  window.location.href = `/download?${qs}`;
});

// ── Elevation panel toggle ─────────────────────────────────────────────────

initElevModeButtons();

document.getElementById('btn-toggle-panel').addEventListener('click', () => {
  const panel     = document.getElementById('profile-panel');
  const collapsed = panel.classList.toggle('collapsed');
  document.getElementById('btn-toggle-panel').textContent = collapsed ? '▲ Show' : '▼ Hide';
  setTimeout(() => { state.map.invalidateSize(); if (!collapsed && state.elevData) renderChart(); }, 50);
});

// ── Sidebar toggle ─────────────────────────────────────────────────────────

document.getElementById('sidebar-toggle').addEventListener('click', () => {
  const sidebar   = document.getElementById('sidebar');
  const collapsed = sidebar.classList.toggle('collapsed');
  document.getElementById('sidebar-toggle').textContent = collapsed ? '›' : '‹';
  document.getElementById('sidebar-toggle').title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  setTimeout(() => { state.map.invalidateSize(); if (state.elevData) renderChart(); }, 260);
});

// Re-render chart on resize
window.addEventListener('resize', () => { if (state.elevData) renderChart(); });

// ── Geocoder ───────────────────────────────────────────────────────────────

initGeocoder();
initGpxImport();

// ── Restore saved route ────────────────────────────────────────────────────

restoreRoute();
