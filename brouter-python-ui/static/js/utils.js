import { state } from './state.js';

// ── Status banner ──────────────────────────────────────────────────────────

export function setStatus(msg, type) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status' + (type ? ' ' + type : '');
}

// ── Route persistence (localStorage) ──────────────────────────────────────

export function saveRoute(context = null) {
  try {
    if (state.routeSource !== 'brouter' || state.waypoints.length < 2 || state.legCache.some(l => l === null)) return;
    const data = {
      version: 2,
      source: 'brouter',
      context,
      wps:   state.waypoints.map(w => ({ lat: w.lat, lon: w.lon })),
      cache: state.legCache,
    };
    localStorage.setItem('brouter-route', JSON.stringify(data));
  } catch { /* quota exceeded — ignore */ }
}

export function clearSavedRoute() {
  localStorage.removeItem('brouter-route');
}

// ── Profile override persistence ───────────────────────────────────────────

export const storageKey = profile => `brouter-params:${profile}`;
