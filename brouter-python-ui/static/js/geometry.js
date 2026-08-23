export const METERS_PER_DEGREE = 111320;

export function geometryParts(input) {
  const geometry = input?.type === 'FeatureCollection'
    ? input.features?.[0]?.geometry
    : input?.type === 'Feature' ? input.geometry : input;
  if (geometry?.type === 'LineString') return [geometry.coordinates || []];
  if (geometry?.type === 'MultiLineString') return geometry.coordinates || [];
  return [];
}

export function longestGeometryPart(input) {
  return geometryParts(input).reduce((best, part) => part.length > best.length ? part : best, []);
}

export function segmentDistanceMeters(a, b) {
  const lon1 = Number(a[0]), lat1 = Number(a[1]);
  const lon2 = Number(b[0]), lat2 = Number(b[1]);
  const dLat = (lat2 - lat1) * METERS_PER_DEGREE;
  const dLon = (lon2 - lon1) * METERS_PER_DEGREE * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
  return Math.hypot(dLat, dLon);
}

export function geometryLengthMeters(input) {
  return geometryParts(input).reduce((total, part) => {
    for (let i = 1; i < part.length; i++) total += segmentDistanceMeters(part[i - 1], part[i]);
    return total;
  }, 0);
}

export function measureCoordinates(coords, offsetM = 0) {
  let measureM = offsetM;
  return coords.map((coordinate, index) => {
    if (index) measureM += segmentDistanceMeters(coords[index - 1], coordinate);
    return {
      coordinate,
      lon: Number(coordinate[0]),
      lat: Number(coordinate[1]),
      elevation: coordinate.length > 2 && Number.isFinite(Number(coordinate[2])) ? Number(coordinate[2]) : null,
      measureM,
      pointIndex: index,
    };
  });
}

export function headingDegrees(a, b) {
  const dLat = (Number(b[1]) - Number(a[1])) * METERS_PER_DEGREE;
  const dLon = (Number(b[0]) - Number(a[0])) * METERS_PER_DEGREE * Math.cos((Number(a[1]) + Number(b[1])) / 2 * Math.PI / 180);
  if (!dLat && !dLon) return 0;
  return Math.atan2(dLon, dLat) * 180 / Math.PI;
}

export function angleDifferenceDegrees(a, b) {
  const difference = Math.abs(a - b) % 360;
  return Math.min(difference, 360 - difference);
}

function quantile(sorted, fraction) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function sustainedGradeExtremes(points, windowM = 300) {
  const valid = points
    .map(point => ({ distance: Number(point.distance), elevation: Number(point.elevation) }))
    .filter(point => Number.isFinite(point.distance) && Number.isFinite(point.elevation))
    .sort((a, b) => a.distance - b.distance);
  if (valid.length < 2) return { maxGrade: null, minGrade: null };

  const totalM = valid[valid.length - 1].distance - valid[0].distance;
  const effectiveWindowM = Math.min(windowM, totalM);
  const minimumSpanM = Math.max(50, effectiveWindowM * 0.65);
  const halfWindowM = effectiveWindowM / 2;
  const grades = [];

  let left = 0, right = 0, count = 0;
  let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
  const add = point => {
    count += 1; sumX += point.distance; sumY += point.elevation;
    sumXX += point.distance * point.distance; sumXY += point.distance * point.elevation;
  };
  const remove = point => {
    count -= 1; sumX -= point.distance; sumY -= point.elevation;
    sumXX -= point.distance * point.distance; sumXY -= point.distance * point.elevation;
  };

  for (const center of valid) {
    const start = center.distance - halfWindowM;
    const end = center.distance + halfWindowM;
    while (right < valid.length && valid[right].distance <= end) add(valid[right++]);
    while (left < right && valid[left].distance < start) remove(valid[left++]);
    if (count < 2 || valid[right - 1].distance - valid[left].distance < minimumSpanM) continue;
    const denominator = count * sumXX - sumX * sumX;
    if (denominator <= 0) continue;
    grades.push((count * sumXY - sumX * sumY) / denominator * 100);
  }

  grades.sort((a, b) => a - b);
  return { maxGrade: quantile(grades, 0.95), minGrade: quantile(grades, 0.05) };
}
