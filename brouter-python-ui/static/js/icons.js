import { state } from './state.js';

// ── Marker icon factories ──────────────────────────────────────────────────

export function makeIcon(color, size) {
  return L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,.4)"></div>`,
    iconSize:   [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export function makeHighlightIcon(color, size) {
  const s = size + 6;
  return L.divIcon({
    className: '',
    html: `<div style="width:${s}px;height:${s}px;border-radius:50%;background:${color};border:3px solid white;box-shadow:0 0 0 2px ${color},0 2px 8px rgba(0,0,0,.5)"></div>`,
    iconSize:   [s, s],
    iconAnchor: [s / 2, s / 2],
  });
}

export function makeLocationIcon() {
  return L.divIcon({
    className: '',
    html: '<div class="loc-ring"></div><div class="loc-dot"></div>',
    iconSize:   [14, 14],
    iconAnchor: [7, 7],
  });
}

// ── Per-index icon selection ───────────────────────────────────────────────

export function wpColorSize(i) {
  const n = state.waypoints.length;
  if (i === 0)     return ['#16a34a', 14];
  if (i === n - 1) return ['#dc2626', 14];
  return ['#64748b', 10];
}

export function iconForIndex(i) {
  const [color, size] = wpColorSize(i);
  return makeIcon(color, size);
}

export function refreshAllIcons() {
  state.waypoints.forEach((w, i) => w.marker.setIcon(iconForIndex(i)));
}

// ── Highlight helpers ──────────────────────────────────────────────────────

export function highlightWaypoint(i) {
  const row = document.querySelector(`#waypoint-list .wp-row[data-idx="${i}"]`);
  if (row) row.classList.add('highlighted');
  const w = state.waypoints[i];
  if (w) {
    const [color, size] = wpColorSize(i);
    w.marker.setIcon(makeHighlightIcon(color, size));
  }
}

export function unhighlightWaypoint(i) {
  const row = document.querySelector(`#waypoint-list .wp-row[data-idx="${i}"]`);
  if (row) row.classList.remove('highlighted');
  if (state.waypoints[i]) state.waypoints[i].marker.setIcon(iconForIndex(i));
}
