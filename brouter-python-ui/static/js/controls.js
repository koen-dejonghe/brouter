import { state } from './state.js';
import { setStatus } from './utils.js';

// ── My Location control ────────────────────────────────────────────────────

const LocateControl = L.Control.extend({
  options: { position: 'topleft' },
  onAdd() {
    const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-locate');
    const a = L.DomUtil.create('a', '', container);
    a.href    = '#';
    a.title   = 'My location';
    a.setAttribute('role', 'button');
    a.textContent = '⊕';
    L.DomEvent.on(a, 'click', e => {
      L.DomEvent.stopPropagation(e);
      L.DomEvent.preventDefault(e);
      a.classList.add('locating');
      state.map.once('locationfound', () => a.classList.remove('locating'));
      state.map.once('locationerror', () => {
        a.classList.remove('locating');
        setStatus('Could not determine your location.', 'error');
      });
      state.map.locate({ setView: true, maxZoom: 15 });
    });
    return container;
  },
});

// ── Zoom-to-route control ──────────────────────────────────────────────────

const FitRouteControl = L.Control.extend({
  options: { position: 'topleft' },
  onAdd() {
    const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
    const a = L.DomUtil.create('a', '', container);
    a.href  = '#';
    a.title = 'Zoom to route';
    a.setAttribute('role', 'button');
    a.innerHTML  = '⛶';
    a.style.fontSize = '16px';
    L.DomEvent.on(a, 'click', e => {
      L.DomEvent.stopPropagation(e);
      L.DomEvent.preventDefault(e);
      if (state.routeBounds) state.map.fitBounds(state.routeBounds, { padding: [30, 30], animate: true });
    });
    this._link = a;
    return container;
  },
  setEnabled(enabled) {
    this._link.style.color  = enabled ? '' : '#aaa';
    this._link.style.cursor = enabled ? 'pointer' : 'default';
  },
});

// ── Init: add both controls, expose FitRouteControl via state ─────────────

export function initControls() {
  new LocateControl().addTo(state.map);
  state.fitRouteControl = new FitRouteControl().addTo(state.map);
  state.fitRouteControl.setEnabled(false);
}
