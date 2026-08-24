import { state } from './state.js';
import { parseTags } from './stats.js';
import { sustainedGradeExtremes } from './geometry.js';

// ── Color maps ─────────────────────────────────────────────────────────────

const SURFACE_COLORS = {
  asphalt: '#6b7280',  concrete: '#6b7280',  paved: '#6b7280',
  paving_stones: '#9ca3af', sett: '#9ca3af', cobblestone: '#9ca3af',
  gravel: '#f97316', fine_gravel: '#f97316', compacted: '#f97316',
  pebblestone: '#f97316', unpaved: '#f97316',
  dirt: '#92400e', ground: '#92400e', grass: '#92400e',
  mud: '#92400e', earth: '#92400e', grass_paver: '#92400e',
  sand: '#fde68a',
  wood: '#a16207', metal: '#9ca3af',
};

const HIGHWAY_COLORS = {
  cycleway: '#16a34a', path: '#16a34a', footway: '#16a34a', track: '#f97316',
  motorway: '#6b7280', trunk: '#6b7280', primary: '#6b7280',
  secondary: '#9ca3af', tertiary: '#9ca3af', residential: '#9ca3af',
  unclassified: '#9ca3af', service: '#9ca3af', living_street: '#9ca3af',
};

const TRACKTYPE_COLORS = {
  grade1: '#9ca3af', grade2: '#f97316', grade3: '#92400e',
  grade4: '#92400e', grade5: '#92400e',
};

const SURFACE_LEGEND = [
  { label: 'Asphalt / Concrete',    color: '#6b7280' },
  { label: 'Paving stones / Sett',  color: '#9ca3af' },
  { label: 'Gravel / Compacted',    color: '#f97316' },
  { label: 'Dirt / Ground / Grass', color: '#92400e' },
  { label: 'Sand',                  color: '#fde68a' },
  { label: 'Cycleway / Path',       color: '#16a34a' },
  { label: 'Unknown',               color: '#334155' },
];

function surfaceColor(tags) {
  if (tags.surface   && SURFACE_COLORS[tags.surface])     return SURFACE_COLORS[tags.surface];
  if (tags.highway   && HIGHWAY_COLORS[tags.highway])     return HIGHWAY_COLORS[tags.highway];
  if (tags.tracktype && TRACKTYPE_COLORS[tags.tracktype]) return TRACKTYPE_COLORS[tags.tracktype];
  return '#334155';
}

function gradientColor(slopePct) {
  if      (slopePct <= -6) return '#1d4ed8';
  else if (slopePct <= -2) return '#60a5fa';
  else if (slopePct <   2) return '#22c55e';
  else if (slopePct <   6) return '#fbbf24';
  else if (slopePct <  10) return '#f97316';
  else                     return '#ef4444';
}

// ── Data parsing ───────────────────────────────────────────────────────────

function parseElevData(geojson) {
  const props = geojson?.features?.[0]?.properties;
  if (!props?.messages) return parseElevDataFromGeometry(geojson);
  const msgs = props.messages;
  const cols = msgs[0];
  const iLon  = cols.indexOf('Longitude');
  const iLat  = cols.indexOf('Latitude');
  const iElev = cols.indexOf('Elevation');
  const iDist = cols.indexOf('Distance');
  const iWay  = cols.indexOf('WayTags');
  if (iElev < 0 || iDist < 0) return null;

  const pts = [];
  let cum = 0;
  for (let r = 1; r < msgs.length; r++) {
    const row  = msgs[r];
    const dist = parseInt(row[iDist], 10) || 0;
    cum += dist;
    const elev = parseInt(row[iElev], 10);
    const lon  = iLon >= 0 ? parseInt(row[iLon], 10) / 1e6 : null;
    const lat  = iLat >= 0 ? parseInt(row[iLat], 10) / 1e6 : null;
    const tags = iWay >= 0 ? parseTags(row[iWay]) : {};
    if (!Number.isFinite(elev)) continue;
    const prevElev = pts.length ? pts[pts.length - 1].elev : elev;
    const slope = dist > 0 ? (elev - prevElev) / dist * 100 : 0;
    pts.push({
      cumDist: cum, elev, lat, lon,
      colorGradient: gradientColor(slope),
      colorSurface:  surfaceColor(tags),
    });
  }
  return pts;
}

function parseElevDataFromGeometry(geojson) {
  const geometry = geojson?.features?.[0]?.geometry;
  const coords = geometry?.type === 'MultiLineString'
    ? geometry.coordinates.reduce((best, part) => part.length > best.length ? part : best, [])
    : geometry?.coordinates;
  const surfaceSegs = geojson?.features?.[0]?.properties?.surface_segments || [];
  if (!coords || coords.length < 2) return null;
  const hasElev = coords.some(c => c.length >= 3 && Number.isFinite(Number(c[2])));
  if (!hasElev) return null;

  const pts = [];
  let cum = 0;
  let prevElev = null;

  function surfaceColorAt(d) {
    if (!surfaceSegs.length) return '#334155';
    let lo = 0, hi = surfaceSegs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((surfaceSegs[mid].dist_end_m || 0) < d) lo = mid + 1; else hi = mid;
    }
    const cat = surfaceSegs[lo]?.category || 'unknown';
    if (cat === 'paved') return '#6b7280';
    if (cat === 'unpaved') return '#f97316';
    return '#334155';
  }

  for (let i = 0; i < coords.length; i++) {
    const c = coords[i];
    const lon = Number(c[0]);
    const lat = Number(c[1]);
    const elevRaw = c.length >= 3 ? Number(c[2]) : NaN;
    const elev = Number.isFinite(elevRaw) ? elevRaw : null;
    if (i > 0) {
      const p = coords[i - 1];
      const dLat = (lat - Number(p[1])) * 111320;
      const dLon = (lon - Number(p[0])) * 111320 * Math.cos((Number(p[1]) + lat) / 2 * Math.PI / 180);
      const dist = Math.sqrt(dLat * dLat + dLon * dLon);
      cum += dist;
    }
    const dDist = i > 0 ? (cum - pts[pts.length - 1].cumDist) : 0;
    const slope = dDist > 0 && elev !== null && prevElev !== null ? (elev - prevElev) / dDist * 100 : 0;
    pts.push({
      cumDist: cum,
      elev,
      lat,
      lon,
      colorGradient: gradientColor(slope),
      colorSurface: surfaceColorAt(cum),
    });
    if (elev !== null) prevElev = elev;
  }
  return pts.filter(p => p.elev !== null);
}

// ── Chart rendering ────────────────────────────────────────────────────────

const PAD_L = 42, PAD_R = 8, PAD_T = 10, PAD_B = 20;
const CONTEXT_SHARE = 0.10;

export function drawElevationProfile(geojson) {
  state.elevData = parseElevData(geojson);
  if (!state.elevData || state.elevData.length < 2 || state.elevData[state.elevData.length - 1].cumDist <= 0) {
    clearElevationProfile();
    return;
  }
  const panel = document.getElementById('profile-panel');
  panel.classList.remove('collapsed');
  document.getElementById('btn-toggle-panel').textContent = '▼ Hide';
  document.getElementById('btn-toggle-panel').setAttribute('aria-expanded', 'true');
  setTimeout(() => state.map.invalidateSize(), 50);
  renderChart();
}

export function renderChart() {
  if (!state.elevData) return;
  const svg = document.getElementById('elev-svg');
  const W = svg.clientWidth  || svg.getBoundingClientRect().width  || 800;
  const H = svg.clientHeight || svg.getBoundingClientRect().height || 130;

  const totalDist = state.elevData[state.elevData.length - 1].cumDist;
  const chartW    = W - PAD_L - PAD_R;
  const yBase     = H - PAD_B;

  const sel = state.elevSelection;
  const d0  = sel ? sel.distStart : 0;
  const d1  = sel ? sel.distEnd   : totalDist;

  function xOf(d) {
    if (!sel) return PAD_L + (d / totalDist) * chartW;
    if (d <= d0) return PAD_L + (d0 > 0 ? (d / d0) * CONTEXT_SHARE * chartW : 0);
    if (d <= d1) return PAD_L + CONTEXT_SHARE * chartW + ((d - d0) / (d1 - d0)) * (1 - 2 * CONTEXT_SHARE) * chartW;
    const tail = totalDist - d1;
    return PAD_L + (1 - CONTEXT_SHARE) * chartW + (tail > 0 ? ((d - d1) / tail) * CONTEXT_SHARE * chartW : 0);
  }
  function distOf(x) {
    const rel = x - PAD_L;
    if (!sel) return (rel / chartW) * totalDist;
    if (rel <= CONTEXT_SHARE * chartW) return d0 > 0 ? (rel / (CONTEXT_SHARE * chartW)) * d0 : 0;
    if (rel <= (1 - CONTEXT_SHARE) * chartW) return d0 + ((rel - CONTEXT_SHARE * chartW) / ((1 - 2 * CONTEXT_SHARE) * chartW)) * (d1 - d0);
    const tail = totalDist - d1;
    return d1 + (tail > 0 ? ((rel - (1 - CONTEXT_SHARE) * chartW) / (CONTEXT_SHARE * chartW)) * tail : 0);
  }

  const scalePoints = sel
    ? state.elevData.filter(point => point.cumDist >= d0 && point.cumDist <= d1)
    : state.elevData;
  const rawMinElev = Math.min(...scalePoints.map(point => point.elev));
  const rawMaxElev = Math.max(...scalePoints.map(point => point.elev));
  const rawRange = Math.max(rawMaxElev - rawMinElev, 10);
  const minElev = rawMinElev - rawRange * 0.08;
  const maxElev = rawMaxElev + rawRange * 0.08;
  const elevRange = maxElev - minElev;
  function yOf(e, context = false) {
    const clamped = context ? Math.max(minElev, Math.min(maxElev, e)) : e;
    return PAD_T + (1 - (clamped - minElev) / elevRange) * (H - PAD_T - PAD_B);
  }

  const ns = 'http://www.w3.org/2000/svg';
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  // Draw full profile
  const colorKey = state.elevMode === 'gradient' ? 'colorGradient' : 'colorSurface';
  let prevX = xOf(0), prevY = yOf(state.elevData[0].elev, !!sel && d0 > 0);
  for (let i = 0; i < state.elevData.length; i++) {
    const pt   = state.elevData[i];
    const context = !!sel && (pt.cumDist < d0 || pt.cumDist > d1);
    const curX = xOf(pt.cumDist), curY = yOf(pt.elev, context);
    const poly = document.createElementNS(ns, 'polygon');
    poly.setAttribute('points', `${prevX},${yBase} ${prevX},${prevY} ${curX},${curY} ${curX},${yBase}`);
    poly.setAttribute('fill', pt[colorKey]);
    poly.setAttribute('stroke', 'none');
    svg.appendChild(poly);
    prevX = curX; prevY = curY;
  }

  // Y axis
  for (let i = 0; i <= 4; i++) {
    const e = minElev + (elevRange / 4) * i;
    const y = yOf(e);
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', PAD_L); line.setAttribute('x2', W - PAD_R);
    line.setAttribute('y1', y);     line.setAttribute('y2', y);
    line.setAttribute('stroke', 'rgba(255,255,255,0.07)'); line.setAttribute('stroke-width', '1');
    svg.appendChild(line);
    const txt = document.createElementNS(ns, 'text');
    txt.setAttribute('x', PAD_L - 4); txt.setAttribute('y', y + 4);
    txt.setAttribute('text-anchor', 'end'); txt.setAttribute('font-size', '9'); txt.setAttribute('fill', '#94a3b8');
    txt.textContent = Math.round(e) + 'm';
    svg.appendChild(txt);
  }

  // X axis
  const axisStartM = sel ? d0 : 0;
  const axisEndM = sel ? d1 : totalDist;
  const xStepM = niceStep((axisEndM - axisStartM) / 1000, 5) * 1000;
  const firstTickM = Math.ceil(axisStartM / xStepM) * xStepM;
  for (let distanceM = firstTickM; distanceM <= axisEndM + xStepM * 0.25; distanceM += xStepM) {
    const x = xOf(distanceM);
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', x); line.setAttribute('x2', x);
    line.setAttribute('y1', PAD_T); line.setAttribute('y2', yBase);
    line.setAttribute('stroke', 'rgba(255,255,255,0.07)'); line.setAttribute('stroke-width', '1');
    svg.appendChild(line);
    const txt = document.createElementNS(ns, 'text');
    txt.setAttribute('x', x); txt.setAttribute('y', H - 5);
    txt.setAttribute('text-anchor', 'middle'); txt.setAttribute('font-size', '9'); txt.setAttribute('fill', '#94a3b8');
    const km = distanceM / 1000;
    txt.textContent = km.toFixed(xStepM < 1000 ? 1 : 0) + 'km';
    svg.appendChild(txt);
  }

  // Selection overlay: gray film + boundary lines
  if (sel) {
    const xL = xOf(d0), xR = xOf(d1);
    const makeContextStrip = (side, x, width) => {
      if (width <= 1) return;
      const group = document.createElementNS(ns, 'g');
      group.classList.add('elev-context-strip');
      group.dataset.side = side;
      group.setAttribute('role', 'button');
      group.setAttribute('tabindex', '0');
      group.setAttribute('aria-label', 'Return to full route profile');
      const r = document.createElementNS(ns, 'rect');
      r.setAttribute('x', x); r.setAttribute('y', PAD_T);
      r.setAttribute('width', width); r.setAttribute('height', H - PAD_T - PAD_B);
      const text = document.createElementNS(ns, 'text');
      text.setAttribute('x', x + width / 2); text.setAttribute('y', PAD_T + 15);
      text.setAttribute('text-anchor', 'middle');
      text.textContent = 'Full view';
      group.append(r, text);
      svg.appendChild(group);
    };
    makeContextStrip('left', PAD_L, xL - PAD_L);
    makeContextStrip('right', xR, W - PAD_R - xR);
    const lL = document.createElementNS(ns, 'line');
    lL.setAttribute('x1', xL); lL.setAttribute('x2', xL);
    lL.setAttribute('y1', PAD_T); lL.setAttribute('y2', yBase);
    lL.setAttribute('stroke', 'rgba(255,255,255,0.7)'); lL.setAttribute('stroke-width', '1.5');
    lL.setAttribute('pointer-events', 'none');
    svg.appendChild(lL);
    const lR = document.createElementNS(ns, 'line');
    lR.setAttribute('x1', xR); lR.setAttribute('x2', xR);
    lR.setAttribute('y1', PAD_T); lR.setAttribute('y2', yBase);
    lR.setAttribute('stroke', 'rgba(255,255,255,0.7)'); lR.setAttribute('stroke-width', '1.5');
    lR.setAttribute('pointer-events', 'none');
    svg.appendChild(lR);
  }

  state.elevData._W        = W;
  state.elevData._H        = H;
  state.elevData._xOf      = xOf;
  state.elevData._yOf      = yOf;
  state.elevData._distOf   = distOf;
  state.elevData._distMin  = 0;
  state.elevData._distMax  = totalDist;
  state.elevData._totalDist = totalDist;
  svg.classList.toggle('zoomed', !!sel);

  updateSurfaceLegend();
}

function niceStep(range, targetSteps) {
  const raw  = range / targetSteps;
  const mag  = Math.pow(10, Math.floor(Math.log10(raw)));
  const frac = raw / mag;
  let nice;
  if      (frac < 1.5) nice = 1;
  else if (frac < 3.5) nice = 2;
  else if (frac < 7.5) nice = 5;
  else                 nice = 10;
  return nice * mag;
}

function updateSurfaceLegend() {
  const leg = document.getElementById('surface-legend');
  if (state.elevMode !== 'surface') { leg.classList.remove('visible'); return; }
  leg.classList.add('visible');
  const used  = new Set(state.elevData.map(p => p.colorSurface));
  const items = SURFACE_LEGEND.filter(item => used.has(item.color));
  leg.innerHTML = items.map(item =>
    `<div class="surf-item"><div class="surf-swatch" style="background:${item.color}"></div>${item.label}</div>`
  ).join('');
}

export function clearElevationProfile() {
  state.elevData = null;
  state.elevSelection = null;
  removeSelectionOverlay();
  const svg = document.getElementById('elev-svg');
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  if (state.hoverMarker) { state.map.removeLayer(state.hoverMarker); state.hoverMarker = null; }
  document.getElementById('elev-hairline').style.display = 'none';
  document.getElementById('elev-tooltip').style.display  = 'none';
  document.getElementById('surface-legend').classList.remove('visible');
  document.getElementById('sel-stats-card').classList.remove('visible');
  document.getElementById('profile-panel').classList.add('collapsed');
  document.getElementById('btn-toggle-panel').textContent = '▲ Show';
  document.getElementById('btn-toggle-panel').setAttribute('aria-expanded', 'false');
  state.map.invalidateSize();
}

// ── Elevation hover helpers ────────────────────────────────────────────────

const svgEl    = document.getElementById('elev-svg');
const hairline = document.getElementById('elev-hairline');
const tooltip  = document.getElementById('elev-tooltip');

export function showElevHover(dist) {
  if (!state.elevData || state.elevData.length < 2 || !state.elevData._xOf) return;
  const x = state.elevData._xOf(dist);
  let lo = 0, hi = state.elevData.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (state.elevData[mid].cumDist < dist) lo = mid; else hi = mid;
  }
  const a = state.elevData[lo], b = state.elevData[hi];
  const t    = b.cumDist > a.cumDist ? (dist - a.cumDist) / (b.cumDist - a.cumDist) : 0;
  const elev = a.elev + t * (b.elev - a.elev);

  hairline.style.left    = x + 'px';
  hairline.style.display = 'block';

  const km   = (dist / 1000).toFixed(2);
  tooltip.textContent = `${km} km · ${Math.round(elev)} m`;
  const svgW = svgEl.getBoundingClientRect().width;
  const tipW = 100;
  tooltip.style.left    = (x + tipW + 14 > svgW) ? (x - tipW - 6) + 'px' : (x + 10) + 'px';
  tooltip.style.display = 'block';
}

export function hideElevHover() {
  hairline.style.display = 'none';
  tooltip.style.display  = 'none';
}

// ── SVG hover: profile → map marker ──────────────────────────────────────

svgEl.addEventListener('mousemove', e => {
  if (!state.elevData || state.elevData.length < 2 || state.svgDragState) return;
  const rect   = svgEl.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const dMin = state.elevData._distMin ?? 0;
  const dMax = dMin + (state.elevData._totalDist ?? 0);
  const dist = Math.max(dMin, Math.min(dMax,
    state.elevData._distOf ? state.elevData._distOf(mouseX) : dMin + (dMax - dMin) * (mouseX - PAD_L) / (rect.width - PAD_L - PAD_R)
  ));
  showElevHover(dist);

  let lo = 0, hi = state.elevData.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (state.elevData[mid].cumDist < dist) lo = mid; else hi = mid;
  }
  const a = state.elevData[lo], b = state.elevData[hi];
  const t   = b.cumDist > a.cumDist ? (dist - a.cumDist) / (b.cumDist - a.cumDist) : 0;
  const lat = a.lat != null ? a.lat + t * (b.lat - a.lat) : null;
  const lon = a.lon != null ? a.lon + t * (b.lon - a.lon) : null;

  if (lat != null && lon != null) {
    if (!state.hoverMarker) {
      state.hoverMarker = L.circleMarker([lat, lon], {
        radius: 6, color: 'white', weight: 2,
        fillColor: '#f59e0b', fillOpacity: 1,
      }).addTo(state.map);
    } else {
      state.hoverMarker.setLatLng([lat, lon]);
    }
  }
});

svgEl.addEventListener('mouseleave', () => {
  hideElevHover();
  if (state.hoverMarker) { state.map.removeLayer(state.hoverMarker); state.hoverMarker = null; }
});

// ── Route hover: map → profile hairline ──────────────────────────────────

export function onRouteMouseMove(e) {
  if (!state.routeGeom || state.routeGeom.length < 2) return;
  state.map.getContainer().style.cursor = 'copy';
  const { lat, lng } = e.latlng;

  let bestIdx = 0, bestDist = Infinity;
  for (let i = 0; i < state.routeGeom.length; i++) {
    const p = state.routeGeom[i];
    const d = (p.lat - lat) ** 2 + (p.lon - lng) ** 2;
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  const best = state.routeGeom[bestIdx];
  showElevHover(best.cumDist);

  if (!state.hoverMarker) {
    state.hoverMarker = L.circleMarker([best.lat, best.lon], {
      radius: 6, color: 'white', weight: 2,
      fillColor: '#f59e0b', fillOpacity: 1,
      interactive: false,
    }).addTo(state.map);
  } else {
    state.hoverMarker.setLatLng([best.lat, best.lon]);
  }
}

export function onRouteMouseOut() {
  state.map.getContainer().style.cursor = '';
  hideElevHover();
  if (state.hoverMarker) { state.map.removeLayer(state.hoverMarker); state.hoverMarker = null; }
}

// ── Elevation profile drag-to-select ─────────────────────────────────────

svgEl.addEventListener('mousedown', e => {
  if (e.target.closest?.('.elev-context-strip')) return;
  if (!state.elevData || !state.elevData._distOf) return;
  e.preventDefault();
  const rect = svgEl.getBoundingClientRect();
  const x    = e.clientX - rect.left;
  const dMin = state.elevData._distMin ?? 0;
  const dMax = dMin + state.elevData._totalDist;
  const dist = Math.max(dMin, Math.min(dMax, state.elevData._distOf(x)));
  state.svgDragState = { startX: x, startDist: dist, isDragging: false };
  svgEl.classList.add('selecting');
});

svgEl.addEventListener('mousemove', e => {
  if (!state.svgDragState || !state.elevData) return;
  if (e.buttons !== 1) { state.svgDragState = null; svgEl.classList.remove('selecting'); return; }
  const rect  = svgEl.getBoundingClientRect();
  const x     = e.clientX - rect.left;
  const dMin  = state.elevData._distMin ?? 0;
  const dMax  = dMin + state.elevData._totalDist;
  const dist  = Math.max(dMin, Math.min(dMax, state.elevData._distOf(x)));

  if (!state.svgDragState.isDragging && Math.abs(x - state.svgDragState.startX) > 5) {
    state.svgDragState.isDragging = true;
    hideElevHover();
    if (state.hoverMarker) { state.map.removeLayer(state.hoverMarker); state.hoverMarker = null; }
  }
  if (!state.svgDragState.isDragging) return;

  drawSelBand(Math.min(state.svgDragState.startDist, dist), Math.max(state.svgDragState.startDist, dist));
  updateSelectionLayer(Math.min(state.svgDragState.startDist, dist), Math.max(state.svgDragState.startDist, dist));
});

svgEl.addEventListener('mouseup', e => {
  if (e.target.closest?.('.elev-context-strip')) return;
  if (!state.svgDragState) return;
  const rect  = svgEl.getBoundingClientRect();
  const x     = e.clientX - rect.left;
  const dMin  = state.elevData?._distMin ?? 0;
  const dMax  = dMin + (state.elevData?._totalDist ?? 0);
  const dist  = Math.max(dMin, Math.min(dMax, state.elevData?._distOf ? state.elevData._distOf(x) : dMin));

  if (state.svgDragState.isDragging) {
    const d0 = Math.min(state.svgDragState.startDist, dist);
    const d1 = Math.max(state.svgDragState.startDist, dist);
    if (d1 - d0 > 200) {
      commitSelection(d0, d1);
    } else {
      removeSelectionOverlay();
      renderChart();
    }
  }
  state.svgDragState = null;
  svgEl.classList.remove('selecting');
});

function activateContextStrip(event) {
  const strip = event.target.closest?.('.elev-context-strip');
  if (!strip) return false;
  event.preventDefault();
  event.stopPropagation();
  clearSelection();
  return true;
}

svgEl.addEventListener('click', activateContextStrip);
svgEl.addEventListener('keydown', event => {
  if ((event.key === 'Enter' || event.key === ' ') && activateContextStrip(event)) return;
  if (event.key === 'Escape' && state.elevSelection) {
    event.preventDefault();
    clearSelection();
  }
});

svgEl.addEventListener('touchend', event => {
  activateContextStrip(event);
}, { passive: false });

svgEl.addEventListener('mouseleave', () => {
  // Keep live overlay; user may mouseup outside
});
document.addEventListener('mouseup', () => {
  if (state.svgDragState) {
    state.svgDragState = null;
    svgEl.classList.remove('selecting');
    removeSelectionOverlay();
    document.getElementById('elev-sel-band')?.remove();
    renderChart();
  }
});

function drawSelBand(d0, d1) {
  if (!state.elevData?._xOf) return;
  let band = document.getElementById('elev-sel-band');
  if (!band) {
    band = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    band.id = 'elev-sel-band';
    band.setAttribute('pointer-events', 'none');
  }
  const x0 = state.elevData._xOf(d0);
  const x1 = state.elevData._xOf(d1);
  const H  = state.elevData._H || svgEl.clientHeight || 130;
  band.setAttribute('x',      Math.min(x0, x1));
  band.setAttribute('y',      PAD_T);
  band.setAttribute('width',  Math.abs(x1 - x0));
  band.setAttribute('height', H - PAD_T - PAD_B);
  band.setAttribute('fill',   'rgba(37,99,235,0.20)');
  band.setAttribute('stroke', 'rgba(37,99,235,0.65)');
  band.setAttribute('stroke-width', '1');
  svgEl.appendChild(band);
}

export function removeSelectionOverlay() {
  if (state.selectionLayer) { state.map.removeLayer(state.selectionLayer); state.selectionLayer = null; }
  if (state.selStartMarker) { state.map.removeLayer(state.selStartMarker); state.selStartMarker = null; }
  if (state.selEndMarker)   { state.map.removeLayer(state.selEndMarker);   state.selEndMarker   = null; }
}

export function updateSelectionLayer(d0, d1) {
  if (!state.routeGeom) return;
  removeSelectionOverlay();

  let clipped;
  if (state.routeSegments) {
    clipped = state.routeSegments
      .filter(s => s.cumDistEnd >= d0 && s.cumDistStart <= d1)
      .map(s => ({
        category: s.category,
        latlngs: state.routeGeom
          .filter(p => p.cumDist >= Math.max(d0, s.cumDistStart) &&
                       p.cumDist <= Math.min(d1, s.cumDistEnd))
          .map(p => [p.lat, p.lon]),
      }))
      .filter(s => s.latlngs.length >= 2);
  } else {
    clipped = [{
      category: 'paved',
      latlngs: state.routeGeom.filter(p => p.cumDist >= d0 && p.cumDist <= d1).map(p => [p.lat, p.lon]),
    }];
  }

  if (!clipped.length) return;

  const casings = clipped.map(({ latlngs, category }) => L.polyline(latlngs, {
    color: 'rgba(0,0,0,0.55)', weight: category === 'unpaved' ? 7 : 9,
    lineCap: 'round', lineJoin: 'round', interactive: false,
  }));
  const fills = clipped.map(({ latlngs, category }) => L.polyline(latlngs, {
    color: '#22d3ee', weight: category === 'unpaved' ? 3 : 5, opacity: 0.9,
    dashArray: category === 'unpaved' ? '8, 8' : null,
    lineCap: 'butt', lineJoin: 'round', interactive: false,
  }));
  state.selectionLayer = L.layerGroup([...casings, ...fills]).addTo(state.map);

  const selMarkerStyle = { radius: 6, color: 'white', weight: 2, fillColor: '#22d3ee', fillOpacity: 1, interactive: false };
  const ptStart = state.routeGeom.reduce((best, p) => Math.abs(p.cumDist - d0) < Math.abs(best.cumDist - d0) ? p : best);
  const ptEnd   = state.routeGeom.reduce((best, p) => Math.abs(p.cumDist - d1) < Math.abs(best.cumDist - d1) ? p : best);
  state.selStartMarker = L.circleMarker([ptStart.lat, ptStart.lon], selMarkerStyle).addTo(state.map);
  state.selEndMarker   = L.circleMarker([ptEnd.lat,   ptEnd.lon],   selMarkerStyle).addTo(state.map);
}

function commitSelection(d0, d1) {
  state.elevSelection = { distStart: d0, distEnd: d1 };
  updateSelectionLayer(d0, d1);

  if (state.routeGeom) {
    const pts = state.routeGeom
      .filter(p => p.cumDist >= d0 && p.cumDist <= d1)
      .map(p => [p.lat, p.lon]);
    if (pts.length) state.map.fitBounds(L.latLngBounds(pts), { padding: [70, 70], animate: true });
  }

  renderChart();
  renderSelStats(d0, d1);
}

function clearSelection() {
  if (!state.elevSelection && !state.selectionLayer) return;
  state.elevSelection = null;
  removeSelectionOverlay();
  if (state.routeBounds) state.map.fitBounds(state.routeBounds, { padding: [30, 30], animate: true });
  renderChart();
  hideSelStats();
}

function computeSelStats(d0, d1) {
  const pts = state.elevData.filter(p => p.cumDist >= d0 && p.cumDist <= d1);
  if (pts.length < 2) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i < pts.length; i++) {
    const dElev = pts[i].elev - pts[i - 1].elev;
    if (dElev > 0) gain += dElev; else loss += Math.abs(dElev);
  }
  const extremes = sustainedGradeExtremes(pts.map(point => ({
    distance: point.cumDist, elevation: point.elev,
  })));
  return {
    distM: d1 - d0,
    gain:  Math.round(gain),
    loss:  Math.round(loss),
    maxGrade: extremes.maxGrade,
    minGrade: extremes.minGrade,
  };
}

function renderSelStats(d0, d1) {
  const card = document.getElementById('sel-stats-card');
  const s    = computeSelStats(d0, d1);
  if (!s) { card.classList.remove('visible'); return; }

  const fmtDist  = s.distM >= 1000 ? (s.distM / 1000).toFixed(2) + ' km' : Math.round(s.distM) + ' m';
  const fmtGrade = g => g != null ? (g > 0 ? '+' : '') + g.toFixed(1) + '%' : '—';

  card.innerHTML = `
    <div class="sel-stat"><span class="sel-stat-val">${fmtDist}</span><span class="sel-stat-lbl">distance</span></div>
    <div class="sel-stat"><span class="sel-stat-val">+${s.gain} m</span><span class="sel-stat-lbl">gain</span></div>
    <div class="sel-stat"><span class="sel-stat-val">−${s.loss} m</span><span class="sel-stat-lbl">loss</span></div>
    <div class="sel-stat"><span class="sel-stat-val">${fmtGrade(s.maxGrade)}</span><span class="sel-stat-lbl">max sustained</span></div>
    <div class="sel-stat"><span class="sel-stat-val">${fmtGrade(s.minGrade)}</span><span class="sel-stat-lbl">min sustained</span></div>
    <button id="btn-clear-sel" title="Clear selection">✕ Reset</button>`;
  card.classList.add('visible');
  document.getElementById('btn-clear-sel').addEventListener('click', clearSelection);
}

export function hideSelStats() {
  document.getElementById('sel-stats-card').classList.remove('visible');
}

// ── Mode toggle buttons ───────────────────────────────────────────────────

export function initElevModeButtons() {
  document.getElementById('btn-mode-gradient').addEventListener('click', () => {
    state.elevMode = 'gradient';
    document.getElementById('btn-mode-gradient').classList.add('active');
    document.getElementById('btn-mode-surface').classList.remove('active');
    document.getElementById('btn-mode-gradient').setAttribute('aria-pressed', 'true');
    document.getElementById('btn-mode-surface').setAttribute('aria-pressed', 'false');
    renderChart();
  });
  document.getElementById('btn-mode-surface').addEventListener('click', () => {
    state.elevMode = 'surface';
    document.getElementById('btn-mode-surface').classList.add('active');
    document.getElementById('btn-mode-gradient').classList.remove('active');
    document.getElementById('btn-mode-surface').setAttribute('aria-pressed', 'true');
    document.getElementById('btn-mode-gradient').setAttribute('aria-pressed', 'false');
    renderChart();
  });
}
