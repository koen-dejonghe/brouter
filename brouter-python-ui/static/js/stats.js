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
  const imported = geojson?.features?.[0]?.properties?.surface_segments;
  if (!coords || coords.length < 2) return null;

  if ((!msgs || msgs.length < 2) && Array.isArray(imported) && imported.length) {
    const geomCum = new Float64Array(coords.length);
    for (let i = 1; i < coords.length; i++) {
      const [lon1, lat1] = coords[i - 1];
      const [lon2, lat2] = coords[i];
      const dLat = (lat2 - lat1) * 111320;
      const dLon = (lon2 - lon1) * 111320 * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
      geomCum[i] = geomCum[i - 1] + Math.sqrt(dLat * dLat + dLon * dLon);
    }

    function categoryAtImported(d) {
      let lo = 0, hi = imported.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (imported[mid].dist_end_m < d) lo = mid + 1; else hi = mid;
      }
      return imported[lo]?.category || 'unknown';
    }

    const segments = [];
    let curCat = categoryAtImported(geomCum[0]);
    let curPts = [[coords[0][1], coords[0][0]]];
    let curStart = geomCum[0];
    for (let i = 1; i < coords.length; i++) {
      const cat = categoryAtImported(geomCum[i]);
      if (cat === curCat) {
        curPts.push([coords[i][1], coords[i][0]]);
      } else {
        curPts.push([coords[i][1], coords[i][0]]);
        segments.push({ latlngs: curPts, category: curCat, cumDistStart: curStart, cumDistEnd: geomCum[i] });
        curCat = cat;
        curPts = [[coords[i][1], coords[i][0]]];
        curStart = geomCum[i];
      }
    }
    segments.push({ latlngs: curPts, category: curCat, cumDistStart: curStart, cumDistEnd: geomCum[geomCum.length - 1] });
    return segments;
  }

  if (!msgs || msgs.length < 2) return null;

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
  const props  = geojson?.features?.[0]?.properties || {};
  const coords = geojson?.features?.[0]?.geometry?.coordinates;
  const imported = geojson?.features?.[0]?.properties?.surface_segments;
  const importedStats = geojson?.features?.[0]?.properties?.surface_stats;
  if ((!msgs || msgs.length < 2) && (!coords || coords.length < 2)) return null;

  let pavedM = 0, unpavedM = 0, unknownM = 0;
  let confidence = null;

  if (Array.isArray(imported) && imported.length) {
    for (const s of imported) {
      const dist = Math.max(0, (s.dist_end_m || 0) - (s.dist_start_m || 0));
      if (s.category === 'paved') pavedM += dist;
      else if (s.category === 'unpaved') unpavedM += dist;
      else unknownM += dist;
    }
    if (importedStats) confidence = importedStats;
  }

  if (msgs && msgs.length >= 2) {
    pavedM = 0; unpavedM = 0; unknownM = 0;
    const cols  = msgs[0];
    const iDist = cols.indexOf('Distance');
    const iWay  = cols.indexOf('WayTags');
    if (iDist < 0) return null;

    for (let r = 1; r < msgs.length; r++) {
      const row  = msgs[r];
      const dist = parseInt(row[iDist], 10) || 0;
      const tags = iWay >= 0 ? parseTags(row[iWay]) : {};
      const cat  = surfaceCategory(tags);
      if      (cat === 'paved')   pavedM   += dist;
      else if (cat === 'unpaved') unpavedM += dist;
      else                        unknownM += dist;
    }
  }

  let gainM = 0, lossM = 0;
  let maxGrade = -Infinity, minGrade = Infinity;
  let geomTotalM = 0;
  if (coords && coords.length >= 2) {
    const hasElev = coords.some(c => c.length >= 3 && Number.isFinite(Number(c[2])));
    const cumDist = new Float64Array(coords.length);
    for (let i = 1; i < coords.length; i++) {
      const [lon1, lat1] = coords[i - 1];
      const [lon2, lat2] = coords[i];
      const dLat = (lat2 - lat1) * 111320;
      const dLon = (lon2 - lon1) * 111320 * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
      cumDist[i] = cumDist[i - 1] + Math.sqrt(dLat * dLat + dLon * dLon);
      geomTotalM = cumDist[i];
      if (hasElev) {
        const z1 = Number(coords[i - 1][2]);
        const z2 = Number(coords[i][2]);
        if (Number.isFinite(z1) && Number.isFinite(z2)) {
          const dElev = z2 - z1;
          if (dElev > 0) gainM += dElev;
          else           lossM += Math.abs(dElev);
        }
      }
    }
    if (hasElev) {
      const WINDOW_M = 100;
      let j = 0;
      for (let i = 0; i < coords.length - 1; i++) {
        if (j <= i) j = i + 1;
        while (j < coords.length - 1 && cumDist[j] - cumDist[i] < WINDOW_M) j++;
        const span = cumDist[j] - cumDist[i];
        if (span < 1) continue;
        const z1 = Number(coords[i][2]);
        const z2 = Number(coords[j][2]);
        if (!Number.isFinite(z1) || !Number.isFinite(z2)) continue;
        const grade = (z2 - z1) / span * 100;
        if (grade > maxGrade) maxGrade = grade;
        if (grade < minGrade) minGrade = grade;
      }
    }
  }

  const totalM = pavedM + unpavedM + unknownM || 1;
  const displayDistanceM = Number.isFinite(Number(props['track-length']))
    ? Number(props['track-length'])
    : geomTotalM;
  return {
    pavedM, unpavedM, unknownM, totalM,
    displayDistanceM,
    gainM:    Math.round(gainM),
    lossM:    Math.round(lossM),
    maxGrade: isFinite(maxGrade) ? maxGrade : null,
    minGrade: isFinite(minGrade) ? minGrade : null,
    confidence,
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
  let hasDistanceField = false;
  for (const [label, key, fmt] of fields)
    if (props[key] != null) {
      if (key === 'track-length') hasDistanceField = true;
      rows.push(`<div>${label}: <strong>${fmt(props[key])}</strong></div>`);
    }

  const s = geojson ? computeRouteStats(geojson) : null;
  if (s) {
    if (!hasDistanceField && Number.isFinite(s.displayDistanceM) && s.displayDistanceM > 0)
      rows.unshift(`<div>Total distance: <strong>${(s.displayDistanceM / 1000).toFixed(2)} km</strong></div>`);
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
    if (s.confidence)
      rows.push(`<div style="color:#64748b">Surface confidence: high ${s.confidence.highPct}% · medium ${s.confidence.mediumPct}% · low ${s.confidence.lowPct}%</div>`);
  }

  body.innerHTML = rows.join('');
  statsDiv.style.display = rows.length ? 'block' : 'none';
}
