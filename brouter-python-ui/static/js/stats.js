// ── Surface classification sets ────────────────────────────────────────────

export const PAVED_SURFACES   = new Set(['asphalt','concrete','paved','paving_stones','sett','cobblestone','metal','wood']);
export const UNPAVED_SURFACES = new Set(['gravel','fine_gravel','compacted','pebblestone','unpaved',
                                          'dirt','ground','grass','mud','earth','grass_paver','sand']);
export const PAVED_HIGHWAYS   = new Set(['motorway','trunk','primary','secondary','tertiary',
                                          'residential','unclassified','service','living_street','road']);
export const UNPAVED_HIGHWAYS = new Set(['track','bridleway']);

// ── Tag parsing ────────────────────────────────────────────────────────────

export function parseTags(wayTagsStr) {
  const tags = {};
  for (const part of wayTagsStr.split(' ')) {
    const eq = part.indexOf('=');
    if (eq > 0) tags[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return tags;
}

export function surfaceCategory(tags) {
  if (tags.surface) {
    if (PAVED_SURFACES.has(tags.surface))   return 'paved';
    if (UNPAVED_SURFACES.has(tags.surface)) return 'unpaved';
  }
  if (tags.tracktype && tags.tracktype !== 'grade1') return 'unpaved';
  if (tags.tracktype === 'grade1')                   return 'paved';
  if (tags.highway) {
    if (PAVED_HIGHWAYS.has(tags.highway))   return 'paved';
    if (UNPAVED_HIGHWAYS.has(tags.highway)) return 'unpaved';
    if (tags.highway === 'cycleway' || tags.highway === 'path' || tags.highway === 'footway')
      return 'paved';
  }
  return 'unknown';
}

/**
 * Split the route geometry into runs of the same surface category.
 * Returns [{ latlngs, category, cumDistStart, cumDistEnd }] or null.
 */
export function buildSurfaceLines(geojson) {
  const coords = geojson?.features?.[0]?.geometry?.coordinates;
  const msgs   = geojson?.features?.[0]?.properties?.messages;
  if (!coords || coords.length < 2 || !msgs || msgs.length < 2) return null;

  const cols  = msgs[0];
  const iDist = cols.indexOf('Distance');
  const iWay  = cols.indexOf('WayTags');
  if (iDist < 0) return null;

  // Build message boundaries: cumulative distance → surface category.
  const boundaries = [];
  let cum = 0;
  for (let r = 1; r < msgs.length; r++) {
    cum += parseInt(msgs[r][iDist], 10) || 0;
    const tags = iWay >= 0 ? parseTags(msgs[r][iWay]) : {};
    boundaries.push({ cumDist: cum, category: surfaceCategory(tags) });
  }

  // Compute cumulative distances along geometry coordinates
  const geomCum = new Float64Array(coords.length);
  for (let i = 1; i < coords.length; i++) {
    const [lon1, lat1] = coords[i - 1];
    const [lon2, lat2] = coords[i];
    const dLat = (lat2 - lat1) * 111320;
    const dLon = (lon2 - lon1) * 111320 * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
    geomCum[i] = geomCum[i - 1] + Math.sqrt(dLat * dLat + dLon * dLon);
  }

  function categoryAt(d) {
    let lo = 0, hi = boundaries.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (boundaries[mid].cumDist < d) lo = mid + 1; else hi = mid;
    }
    return boundaries[lo].category;
  }

  const segments = [];
  let curCat   = categoryAt(geomCum[0]);
  let curPts   = [[coords[0][1], coords[0][0]]];
  let curStart = geomCum[0];

  for (let i = 1; i < coords.length; i++) {
    const cat = categoryAt(geomCum[i]);
    if (cat === curCat) {
      curPts.push([coords[i][1], coords[i][0]]);
    } else {
      curPts.push([coords[i][1], coords[i][0]]);
      segments.push({ latlngs: curPts, category: curCat, cumDistStart: curStart, cumDistEnd: geomCum[i] });
      curCat   = cat;
      curPts   = [[coords[i][1], coords[i][0]]];
      curStart = geomCum[i];
    }
  }
  segments.push({ latlngs: curPts, category: curCat, cumDistStart: curStart, cumDistEnd: geomCum[geomCum.length - 1] });
  return segments;
}

export function computeRouteStats(geojson) {
  const msgs   = geojson?.features?.[0]?.properties?.messages;
  const coords = geojson?.features?.[0]?.geometry?.coordinates;
  if (!msgs || msgs.length < 2) return null;

  const cols  = msgs[0];
  const iDist = cols.indexOf('Distance');
  const iWay  = cols.indexOf('WayTags');
  if (iDist < 0) return null;

  let pavedM = 0, unpavedM = 0, unknownM = 0;
  for (let r = 1; r < msgs.length; r++) {
    const row  = msgs[r];
    const dist = parseInt(row[iDist], 10) || 0;
    const tags = iWay >= 0 ? parseTags(row[iWay]) : {};
    const cat  = surfaceCategory(tags);
    if      (cat === 'paved')   pavedM   += dist;
    else if (cat === 'unpaved') unpavedM += dist;
    else                        unknownM += dist;
  }

  let gainM = 0, lossM = 0;
  let maxGrade = -Infinity, minGrade = Infinity;
  if (coords && coords.length >= 2) {
    const cumDist = new Float64Array(coords.length);
    for (let i = 1; i < coords.length; i++) {
      const [lon1, lat1] = coords[i - 1];
      const [lon2, lat2] = coords[i];
      const dLat = (lat2 - lat1) * 111320;
      const dLon = (lon2 - lon1) * 111320 * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
      cumDist[i] = cumDist[i - 1] + Math.sqrt(dLat * dLat + dLon * dLon);
      const dElev = coords[i][2] - coords[i - 1][2];
      if (dElev > 0) gainM += dElev;
      else           lossM += Math.abs(dElev);
    }
    const WINDOW_M = 100;
    let j = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      if (j <= i) j = i + 1;
      while (j < coords.length - 1 && cumDist[j] - cumDist[i] < WINDOW_M) j++;
      const span = cumDist[j] - cumDist[i];
      if (span < 1) continue;
      const grade = (coords[j][2] - coords[i][2]) / span * 100;
      if (grade > maxGrade) maxGrade = grade;
      if (grade < minGrade) minGrade = grade;
    }
  }

  const totalM = pavedM + unpavedM + unknownM || 1;
  return {
    pavedM, unpavedM, unknownM, totalM,
    gainM:    Math.round(gainM),
    lossM:    Math.round(lossM),
    maxGrade: isFinite(maxGrade) ? maxGrade : null,
    minGrade: isFinite(minGrade) ? minGrade : null,
  };
}

export function showStats(props, geojson) {
  const statsDiv = document.getElementById('stats');
  const body     = document.getElementById('stats-body');
  const rows     = [];

  const fields = [
    ['Total distance', 'track-length',  m  => (m / 1000).toFixed(2) + ' km'],
    ['Est. time',      'total-time',    s  => { const h = Math.floor(s/3600), min = Math.floor((s%3600)/60); return (h ? h+'h ' : '') + min + ' min'; }],
    ['Energy',         'total-energy',  wh => (wh / 1000).toFixed(2) + ' kWh'],
  ];
  for (const [label, key, fmt] of fields)
    if (props[key] != null) rows.push(`<div>${label}: <strong>${fmt(props[key])}</strong></div>`);

  const s = geojson ? computeRouteStats(geojson) : null;
  if (s) {
    const fmt1 = v => (v / 1000).toFixed(2);
    const pct  = v => ((v / s.totalM) * 100).toFixed(1);
    rows.push(`<div>Elevation gain: <strong>${s.gainM} m</strong></div>`);
    rows.push(`<div>Elevation loss: <strong>${s.lossM} m</strong></div>`);
    if (s.maxGrade !== null)
      rows.push(`<div>Max grade: <strong>${s.maxGrade.toFixed(1)}%</strong> &nbsp; Min grade: <strong>${s.minGrade.toFixed(1)}%</strong></div>`);
    rows.push(`<div style="margin-top:4px"><strong>Surface</strong></div>`);
    rows.push(`<div>Paved: <strong>${fmt1(s.pavedM)} km</strong> <span style="color:#475569">(${pct(s.pavedM)}%)</span></div>`);
    rows.push(`<div>Unpaved: <strong>${fmt1(s.unpavedM)} km</strong> <span style="color:#475569">(${pct(s.unpavedM)}%)</span></div>`);
    if (s.unknownM > 0)
      rows.push(`<div>Unknown: <strong>${fmt1(s.unknownM)} km</strong> <span style="color:#475569">(${pct(s.unknownM)}%)</span></div>`);
  }

  body.innerHTML = rows.join('');
  statsDiv.style.display = rows.length ? 'block' : 'none';
}
