export const GOTHENBURG = {
  center: { lon: 11.9746, lat: 57.7089 },
  bbox: { west: 11.6, south: 57.55, east: 12.25, north: 57.85 },
} as const;

/** `[lon, lat]` in degrees. */
export type LonLat = [number, number];

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON_EQUATOR = 111_320;

/** Ray-casting test; the ring may be open or closed. */
export function pointInRing([x, y]: LonLat, ring: readonly LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside the exterior ring (first) and outside every hole. */
export function pointInPolygon(p: LonLat, rings: readonly (readonly LonLat[])[]): boolean {
  const [outer, ...holes] = rings;
  return Boolean(outer && pointInRing(p, outer) && !holes.some((h) => pointInRing(p, h)));
}

const isLonLat = (v: unknown): v is LonLat =>
  Array.isArray(v) &&
  v.length >= 2 &&
  typeof v[0] === 'number' &&
  typeof v[1] === 'number' &&
  Number.isFinite(v[0]) &&
  Number.isFinite(v[1]);
const lineOf = (v: unknown): LonLat[] =>
  Array.isArray(v) ? v.filter(isLonLat).map(([lon, lat]) => [lon, lat]) : [];
const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A GeoJSON-like geometry split into points, lines and polygons (rings as `[outer, ...holes]`). */
export function geometryParts(geometry: { type: string; coordinates: unknown }): {
  points: LonLat[];
  lines: LonLat[][];
  polygons: LonLat[][][];
} {
  const c = geometry.coordinates;
  switch (geometry.type) {
    case 'Point':
      return { points: isLonLat(c) ? [[c[0], c[1]]] : [], lines: [], polygons: [] };
    case 'MultiPoint':
      return { points: lineOf(c), lines: [], polygons: [] };
    case 'LineString':
      return { points: [], lines: [lineOf(c)], polygons: [] };
    case 'MultiLineString':
      return { points: [], lines: listOf(c).map(lineOf), polygons: [] };
    case 'Polygon':
      return { points: [], lines: [], polygons: [listOf(c).map(lineOf)] };
    case 'MultiPolygon':
      return { points: [], lines: [], polygons: listOf(c).map((p) => listOf(p).map(lineOf)) };
    default:
      return { points: [], lines: [], polygons: [] };
  }
}

/** Every vertex of a geometry. */
export function geometryVertices(geometry: { type: string; coordinates: unknown }): LonLat[] {
  const { points, lines, polygons } = geometryParts(geometry);
  return [...points, ...lines.flat(), ...polygons.flat(2)];
}

/** Metres from a point to a geometry on a local flat projection (fine within a city); 0 inside. */
export function distanceToGeometryM(
  p: LonLat,
  geometry: { type: string; coordinates: unknown },
): number {
  const kx = M_PER_DEG_LON_EQUATOR * Math.cos((p[1] * Math.PI) / 180);
  const xy = ([lon, lat]: LonLat): [number, number] => [
    (lon - p[0]) * kx,
    (lat - p[1]) * M_PER_DEG_LAT,
  ];
  const toSegment = (a: LonLat, b: LonLat) => {
    const [ax, ay] = xy(a);
    const [bx, by] = xy(b);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    return Math.hypot(ax + t * dx, ay + t * dy);
  };
  const toLine = (line: readonly LonLat[]) =>
    line.length === 1
      ? Math.hypot(...xy(line[0]!))
      : line.slice(1).reduce((min, b, i) => Math.min(min, toSegment(line[i]!, b)), Infinity);
  const { points, lines, polygons } = geometryParts(geometry);
  if (polygons.some((rings) => pointInPolygon(p, rings))) return 0;
  return Math.min(
    ...points.map((q) => Math.hypot(...xy(q))),
    ...lines.map(toLine),
    ...polygons.flat().map(toLine),
  );
}

/** Straight-line metres between two points (same flat approximation). */
export function flatDistanceM(a: LonLat, b: LonLat): number {
  return distanceToGeometryM(a, { type: 'Point', coordinates: b });
}

const LINE_SCALE = 1e5;

function encodeValue(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = '';
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>>= 5;
  }
  return out + String.fromCharCode(v + 63);
}

/** Encodes a line with the Google polyline algorithm (1e-5° ≈ 1 m precision). */
export function encodeLine(coords: readonly LonLat[]): string {
  let out = '';
  let prevLat = 0;
  let prevLon = 0;
  for (const [lon, lat] of coords) {
    const iLat = Math.round(lat * LINE_SCALE);
    const iLon = Math.round(lon * LINE_SCALE);
    out += encodeValue(iLat - prevLat) + encodeValue(iLon - prevLon);
    prevLat = iLat;
    prevLon = iLon;
  }
  return out;
}

/** Decodes `encodeLine` output; returns an empty array for malformed input. */
export function decodeLine(encoded: string): LonLat[] {
  const coords: LonLat[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  const next = (): number | undefined => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (index >= encoded.length || shift > 30) return undefined;
      const b = encoded.charCodeAt(index++) - 63;
      if (b < 0 || b > 63) return undefined;
      result |= (b & 0x1f) << shift;
      shift += 5;
      if (b < 0x20) break;
    }
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    const dLat = next();
    const dLon = next();
    if (dLat === undefined || dLon === undefined) return [];
    lat += dLat;
    lon += dLon;
    coords.push([lon / LINE_SCALE, lat / LINE_SCALE]);
  }
  return coords;
}
