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
