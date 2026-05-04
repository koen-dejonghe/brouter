import { state } from './state.js';
import { initControls } from './controls.js';

import { renderWaypointList, addWaypoint, removeWaypoint, reverseWaypoints, clearAllWaypoints, undo, _addWaypointRaw, replaceWaypoints } from './waypoints.js';
import { makeLocationIcon, refreshAllIcons } from './icons.js';
import { buildRouteParams, currentLonlats, scheduleRoute, renderRoute, stitchLegs, getProfileOverrides, clearRenderedRouteOnly } from './route.js';
import { renderChart, clearElevationProfile, initElevModeButtons } from './elevation.js';
import { initGeocoder } from './geocoder.js';
import { setStatus, saveRoute, clearSavedRoute, storageKey } from './utils.js';
import { parseGpxString, buildSmartWaypointsFromGeoJson } from './gpx.js';
import { parseTags, surfaceCategory } from './stats.js';

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

function routeLengthFromCoords(coords) {
  if (!coords || coords.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lon1, lat1] = coords[i - 1];
    const [lon2, lat2] = coords[i];
    const dLat = (lat2 - lat1) * 111320;
    const dLon = (lon2 - lon1) * 111320 * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
    total += Math.sqrt(dLat * dLat + dLon * dLon);
  }
  return total;
}

function buildSurfaceSegmentsFromMessages(messages, scale = 1) {
  if (!messages || messages.length < 2) return [];
  const cols = messages[0];
  const iDist = cols.indexOf('Distance');
  const iWay = cols.indexOf('WayTags');
  if (iDist < 0) return [];

  const bins = [];
  let cum = 0;
  let prev = 0;
  for (let r = 1; r < messages.length; r++) {
    const row = messages[r];
    const dist = parseInt(row[iDist], 10) || 0;
    cum += dist;
    const tags = iWay >= 0 ? parseTags(row[iWay]) : {};
    bins.push({
      dist_start_m: prev * scale,
      dist_end_m: cum * scale,
      category: surfaceCategory(tags),
      confidence: 'high',
    });
    prev = cum;
  }

  if (!bins.length) return [];
  const merged = [bins[0]];
  for (let i = 1; i < bins.length; i++) {
    const cur = merged[merged.length - 1];
    const nxt = bins[i];
    if (cur.category === nxt.category && cur.confidence === nxt.confidence) {
      cur.dist_end_m = nxt.dist_end_m;
    } else {
      merged.push(nxt);
    }
  }
  return merged;
}

async function enrichImportedSurfaceViaBrouter(geojson, waypoints) {
  const lonlats = waypoints
    .map(w => `${w.lon.toFixed(6)},${w.lat.toFixed(6)}`)
    .join('|');
  const params = buildRouteParams(lonlats, null);
  const resp = await fetch(`/route?${params}`);
  const brouter = await resp.json();
  if (!resp.ok) throw new Error(brouter.error || 'BRouter enrichment failed');

  const msgs = brouter?.features?.[0]?.properties?.messages;
  const brouterProps = brouter?.features?.[0]?.properties || {};
  if (!msgs || msgs.length < 2) return { surfaceSegments: [], surfaceStats: null };

  const brouterCoords = brouter?.features?.[0]?.geometry?.coordinates;
  const importedCoords = geojson?.features?.[0]?.geometry?.coordinates;
  const brouterLen = routeLengthFromCoords(brouterCoords);
  const importedLen = routeLengthFromCoords(importedCoords);
  const scale = brouterLen > 0 && importedLen > 0 ? (importedLen / brouterLen) : 1;
  const surfaceSegments = buildSurfaceSegmentsFromMessages(msgs, scale);
  return {
    surfaceSegments,
    surfaceStats: { highPct: 100, mediumPct: 0, lowPct: 0 },
    routeMetrics: {
      trackLength: brouterProps['track-length'] ?? null,
      totalTime: brouterProps['total-time'] ?? null,
      totalEnergy: brouterProps['total-energy'] ?? null,
    },
  };
}

function initGpxImport() {
  const btn = document.getElementById('btn-import-gpx');
  const input = document.getElementById('gpx-file-input');
  const enrichProgress = document.getElementById('surface-enrich-progress');
  let importSeq = 0;

  btn.addEventListener('click', () => input.click());

  input.addEventListener('change', async () => {
    importSeq += 1;
    const seq = importSeq;
    const file = input.files?.[0];
    if (!file) return;

    try {
      const xml = await file.text();
      const parsed = parseGpxString(xml);
      const waypoints = buildSmartWaypointsFromGeoJson(parsed.geojson);

      if (waypoints.length < 2) throw new Error('Could not derive waypoints from GPX');

      clearRenderedRouteOnly();
      state.routeSource = 'imported';
      replaceWaypoints(waypoints, false);
      renderRoute(parsed.geojson, true);

      const viaCount = Math.max(0, waypoints.length - 2);
      const name = parsed.name ? ` "${parsed.name}"` : '';
      const sm = waypoints.meta;
      const smartInfo = sm
        ? ` Smart: ${sm.selectedCount} pts (cap ${sm.adaptiveCap}, spacing ${(sm.adaptiveSpacingM / 1000).toFixed(1)} km).`
        : '';
      setStatus(`Loaded GPX${name}: ${waypoints.length} waypoints (${viaCount} via).${smartInfo} Fetching surface via BRouter…`, 'info');

      enrichProgress.style.display = 'inline-flex';
      try {
        const enrich = await enrichImportedSurfaceViaBrouter(parsed.geojson, waypoints);
        if (seq === importSeq) {
          parsed.geojson.features[0].properties.surface_segments = enrich.surfaceSegments || [];
          parsed.geojson.features[0].properties.surface_stats = enrich.surfaceStats || null;
          if (enrich.routeMetrics) {
            parsed.geojson.features[0].properties['track-length'] = enrich.routeMetrics.trackLength;
            parsed.geojson.features[0].properties['total-time'] = enrich.routeMetrics.totalTime;
            parsed.geojson.features[0].properties['total-energy'] = enrich.routeMetrics.totalEnergy;
          }
          renderRoute(parsed.geojson, false);
          setStatus(`Loaded GPX${name}: ${waypoints.length} waypoints (${viaCount} via).${smartInfo}`, 'ok');
        }
      } catch {
        if (seq === importSeq) setStatus('Surface enrichment via BRouter failed. Route loaded without detailed surface tags.', 'info');
      } finally {
        if (seq === importSeq) enrichProgress.style.display = 'none';
      }
    } catch (err) {
      enrichProgress.style.display = 'none';
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
