import type { LonLat } from '@gbg-osint/shared';

const M_PER_DEG_LAT = 110_540;
const TO_RAD = Math.PI / 180;

/** Planar metres (x east, y north) around an anchor point; accurate at city scale. */
export class LocalFrame {
  private readonly mPerDegLon: number;

  constructor(
    readonly lon0: number,
    readonly lat0: number,
  ) {
    this.mPerDegLon = 111_320 * Math.cos(lat0 * TO_RAD);
  }

  toXY(lon: number, lat: number): [number, number] {
    return [(lon - this.lon0) * this.mPerDegLon, (lat - this.lat0) * M_PER_DEG_LAT];
  }

  toLonLat(x: number, y: number): LonLat {
    return [this.lon0 + x / this.mPerDegLon, this.lat0 + y / M_PER_DEG_LAT];
  }
}

export interface PathPoint {
  x: number;
  y: number;
  /** Cumulative distance from the first point, metres. */
  d: number;
}

export interface PathPosition {
  x: number;
  y: number;
  /** Compass heading of travel, or undefined where the path has no direction (a stop). */
  heading: number | undefined;
}

export function headingOf(dx: number, dy: number): number | undefined {
  if (dx === 0 && dy === 0) return undefined;
  const h = Math.atan2(dx, dy) / TO_RAD;
  return h < 0 ? h + 360 : h;
}

export function toPath(xy: readonly (readonly [number, number])[]): PathPoint[] {
  const out: PathPoint[] = [];
  for (const [x, y] of xy) {
    const prev = out[out.length - 1];
    out.push({ x, y, d: prev ? prev.d + Math.hypot(x - prev.x, y - prev.y) : 0 });
  }
  return out;
}

/** Index i such that pts[i].d <= d <= pts[i + 1].d (clamped to the ends). */
function segmentAt(pts: readonly PathPoint[], d: number): number {
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid]!.d <= d) lo = mid;
    else hi = mid;
  }
  return lo;
}

function filletRadius(pts: readonly PathPoint[], i: number, maxRadius: number): number {
  if (i <= 0 || i >= pts.length - 1) return 0;
  const inLen = pts[i]!.d - pts[i - 1]!.d;
  const outLen = pts[i + 1]!.d - pts[i]!.d;
  if (inLen < 0.5 || outLen < 0.5) return 0;
  return Math.min(maxRadius, inLen * 0.4, outLen * 0.4);
}

/**
 * Position at distance `d` along a polyline. With `maxFillet` > 0, corners are rounded with a
 * quadratic curve so objects turn smoothly instead of pivoting on the spot.
 */
export function pointAlong(pts: readonly PathPoint[], d: number, maxFillet = 0): PathPosition {
  const first = pts[0];
  if (!first) return { x: 0, y: 0, heading: undefined };
  if (pts.length === 1) return { x: first.x, y: first.y, heading: undefined };
  const dist = Math.max(0, Math.min(d, pts[pts.length - 1]!.d));
  const i = segmentAt(pts, dist);
  const a = pts[i]!;
  const b = pts[i + 1]!;

  for (const v of [i, i + 1]) {
    const r = filletRadius(pts, v, maxFillet);
    const p = pts[v]!;
    if (r <= 0 || Math.abs(dist - p.d) >= r) continue;
    const prev = pts[v - 1]!;
    const next = pts[v + 1]!;
    const inLen = p.d - prev.d;
    const outLen = next.d - p.d;
    const ax = p.x - ((p.x - prev.x) / inLen) * r;
    const ay = p.y - ((p.y - prev.y) / inLen) * r;
    const cx = p.x + ((next.x - p.x) / outLen) * r;
    const cy = p.y + ((next.y - p.y) / outLen) * r;
    const s = (dist - (p.d - r)) / (2 * r);
    const u = 1 - s;
    return {
      x: u * u * ax + 2 * s * u * p.x + s * s * cx,
      y: u * u * ay + 2 * s * u * p.y + s * s * cy,
      heading: headingOf(u * (p.x - ax) + s * (cx - p.x), u * (p.y - ay) + s * (cy - p.y)),
    };
  }

  const len = b.d - a.d;
  const f = len > 0 ? (dist - a.d) / len : 0;
  return {
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    heading: headingOf(b.x - a.x, b.y - a.y),
  };
}

/** Points evenly spaced along a path (count + 1 points from `from` to `to`). */
export function resample(pts: readonly PathPoint[], from: number, to: number, count: number) {
  const out: [number, number][] = [];
  for (let j = 0; j <= count; j++) {
    const p = pointAlong(pts, from + ((to - from) * j) / count);
    out.push([p.x, p.y]);
  }
  return out;
}
