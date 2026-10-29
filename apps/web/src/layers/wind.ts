import { isEntity, type ChannelItem } from '@gbg-osint/shared';

/** Wind on a regular lon/lat grid; components in m/s, row-major by latitude then longitude. */
export interface WindField {
  lons: number[];
  lats: number[];
  /** Towards the east. */
  u: Float64Array;
  /** Towards the north. */
  v: Float64Array;
  gust: Float64Array;
  ts: string;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const toRad = Math.PI / 180;

/** The grid from the wind channel's points; missing points are NaN. */
export function buildWindField(items: readonly ChannelItem[]): WindField | null {
  const points = items.filter(isEntity).flatMap((e) => {
    const speed = num(e.props?.windMs);
    const from = num(e.props?.windFromDeg);
    return speed === undefined || from === undefined
      ? []
      : [{ lon: e.lon, lat: e.lat, speed, from, gust: num(e.props?.gustMs), ts: e.ts }];
  });
  const lons = [...new Set(points.map((p) => p.lon))].sort((a, b) => a - b);
  const lats = [...new Set(points.map((p) => p.lat))].sort((a, b) => a - b);
  if (lons.length < 2 || lats.length < 2) return null;
  const size = lons.length * lats.length;
  const field: WindField = {
    lons,
    lats,
    u: new Float64Array(size).fill(NaN),
    v: new Float64Array(size).fill(NaN),
    gust: new Float64Array(size).fill(NaN),
    ts: points.reduce((latest, p) => (p.ts > latest ? p.ts : latest), ''),
  };
  for (const p of points) {
    const i = lats.indexOf(p.lat) * lons.length + lons.indexOf(p.lon);
    // Meteorological direction is where the wind comes from; the vector points where it goes.
    field.u[i] = -p.speed * Math.sin(p.from * toRad);
    field.v[i] = -p.speed * Math.cos(p.from * toRad);
    field.gust[i] = p.gust ?? NaN;
  }
  return field;
}

function cell(axis: readonly number[], value: number): [number, number] | undefined {
  if (value < axis[0]! || value > axis.at(-1)!) return undefined;
  const i = Math.min(
    axis.length - 2,
    axis.findIndex((a, k) => value <= axis[k + 1]!),
  );
  return [i, (value - axis[i]!) / (axis[i + 1]! - axis[i]!)];
}

/** Bilinear wind vector at a point inside the grid. */
export function windVector(
  f: WindField,
  lon: number,
  lat: number,
): { u: number; v: number; gust: number } | undefined {
  const x = cell(f.lons, lon);
  const y = cell(f.lats, lat);
  if (!x || !y) return undefined;
  const [i, tx] = x;
  const [j, ty] = y;
  const cols = f.lons.length;
  const mix = (a: Float64Array) => {
    const k = j * cols + i;
    const top = a[k]! * (1 - tx) + a[k + 1]! * tx;
    const bottom = a[k + cols]! * (1 - tx) + a[k + cols + 1]! * tx;
    return top * (1 - ty) + bottom * ty;
  };
  const u = mix(f.u);
  const v = mix(f.v);
  return Number.isFinite(u) && Number.isFinite(v) ? { u, v, gust: mix(f.gust) } : undefined;
}

/** Speed, the direction it comes from, and gusts at a point. */
export function windAt(
  f: WindField,
  lon: number,
  lat: number,
): { speed: number; fromDeg: number; gust?: number } | undefined {
  const w = windVector(f, lon, lat);
  if (!w) return undefined;
  const fromDeg = (Math.atan2(-w.u, -w.v) / toRad + 360) % 360;
  return {
    speed: Math.hypot(w.u, w.v),
    fromDeg,
    ...(Number.isFinite(w.gust) && { gust: w.gust }),
  };
}

const COMPASS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
];

/** 16-point compass name for a direction in degrees. */
export function compass(deg: number): string {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]!;
}
