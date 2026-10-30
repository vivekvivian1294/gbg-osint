import { decodeLine, GOTHENBURG, type Feature, type LonLat } from '@gbg-osint/shared';
import { LocalFrame } from './path';

export const TUNNEL_CHANNEL = 'context.tunnels';

const CELL_M = 50;
/** A line or vehicle has to run along the tunnel, not just cross above it. */
const MAX_ANGLE_DEG = 25;
const SAMPLE_M = 5;
/** Shorter tunnel matches along a line (ramps beside a portal) are ignored, shorter gaps bridged. */
const MIN_RUN_M = 15;

export type Ranges = readonly (readonly [number, number])[];

const bearingOf = (dx: number, dy: number) => ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;

/** Difference between two directions, ignoring which way along the line (0–90°). */
function axisDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 180;
  return d > 90 ? 180 - d : d;
}

/**
 * Where roads and railways run underground or under buildings (OpenStreetMap tunnels and covered
 * ways), so cars, vehicles and lines along them aren't drawn through buildings.
 */
export class TunnelMask {
  private static nextId = 0;
  /** Changes with every mask, for change detection. */
  readonly id = TunnelMask.nextId++;
  private readonly frame = new LocalFrame(GOTHENBURG.center.lon, GOTHENBURG.center.lat);
  private readonly segs: [number, number, number, number, number][] = [];
  private readonly grid = new Map<string, number[]>();

  constructor(features: readonly Feature[]) {
    for (const f of features) {
      if (f.kind !== 'tunnel') continue;
      const pts = decodeLine(f.line).map(([lon, lat]) => this.frame.toXY(lon, lat));
      for (let i = 1; i < pts.length; i++) this.add(pts[i - 1]!, pts[i]!);
    }
  }

  get size(): number {
    return this.segs.length;
  }

  /** True when the point lies on a tunnel, moving along it when a heading is given. */
  covers(lon: number, lat: number, heading?: number, toleranceM = 6): boolean {
    if (this.segs.length === 0) return false;
    const [x, y] = this.frame.toXY(lon, lat);
    return this.coversXY(x, y, heading, toleranceM);
  }

  /** Stretches of a line, as `[from, to]` metres along it, that run through tunnels. */
  ranges(coords: readonly LonLat[], toleranceM = 6): [number, number][] {
    if (this.segs.length === 0 || coords.length < 2) return [];
    const runs: [number, number][] = [];
    let along = 0;
    let open: number | undefined;
    let lastHit = 0;
    for (let i = 1; i < coords.length; i++) {
      const [ax, ay] = this.frame.toXY(coords[i - 1]![0], coords[i - 1]![1]);
      const [bx, by] = this.frame.toXY(coords[i]![0], coords[i]![1]);
      const len = Math.hypot(bx - ax, by - ay);
      if (len === 0) continue;
      const heading = bearingOf(bx - ax, by - ay);
      const steps = Math.max(1, Math.ceil(len / SAMPLE_M));
      for (let k = i === 1 ? 0 : 1; k <= steps; k++) {
        const f = k / steps;
        const d = along + f * len;
        if (this.coversXY(ax + f * (bx - ax), ay + f * (by - ay), heading, toleranceM)) {
          if (open === undefined) open = d;
          lastHit = d;
        } else if (open !== undefined && d - lastHit > SAMPLE_M) {
          runs.push([open, lastHit]);
          open = undefined;
        }
      }
      along += len;
    }
    if (open !== undefined) runs.push([open, lastHit]);
    const merged: [number, number][] = [];
    for (const run of runs) {
      const prev = merged.at(-1);
      if (prev && run[0] - prev[1] < MIN_RUN_M) prev[1] = run[1];
      else merged.push([run[0], run[1]]);
    }
    return merged.filter(([a, b]) => b - a >= MIN_RUN_M);
  }

  /** A line cut into its above-ground parts and its tunnel parts. */
  split(coords: readonly LonLat[], toleranceM = 6): { surface: LonLat[][]; tunnel: LonLat[][] } {
    const ranges = this.ranges(coords, toleranceM);
    if (ranges.length === 0) return { surface: [[...coords]], tunnel: [] };
    const total = this.lengthOf(coords);
    const surface: LonLat[][] = [];
    const tunnel: LonLat[][] = [];
    let from = 0;
    for (const [a, b] of ranges) {
      if (a > from) surface.push(this.slice(coords, from, a));
      tunnel.push(this.slice(coords, a, b));
      from = b;
    }
    if (from < total) surface.push(this.slice(coords, from, total));
    const real = (parts: LonLat[][]) => parts.filter((p) => p.length >= 2);
    return { surface: real(surface), tunnel: real(tunnel) };
  }

  private lengthOf(coords: readonly LonLat[]): number {
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
      const [ax, ay] = this.frame.toXY(coords[i - 1]![0], coords[i - 1]![1]);
      const [bx, by] = this.frame.toXY(coords[i]![0], coords[i]![1]);
      total += Math.hypot(bx - ax, by - ay);
    }
    return total;
  }

  /** The part of a line between two distances along it, with interpolated ends. */
  private slice(coords: readonly LonLat[], from: number, to: number): LonLat[] {
    const out: LonLat[] = [];
    let along = 0;
    for (let i = 1; i < coords.length; i++) {
      const a = coords[i - 1]!;
      const b = coords[i]!;
      const [ax, ay] = this.frame.toXY(a[0], a[1]);
      const [bx, by] = this.frame.toXY(b[0], b[1]);
      const len = Math.hypot(bx - ax, by - ay);
      const end = along + len;
      if (end >= from && along <= to && len > 0) {
        const at = (d: number): LonLat => {
          const f = Math.min(1, Math.max(0, (d - along) / len));
          return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
        };
        if (out.length === 0) out.push(at(from));
        out.push(at(Math.min(to, end)));
      }
      along = end;
      if (along > to) break;
    }
    return out;
  }

  private add(a: readonly [number, number], b: readonly [number, number]): void {
    const index = this.segs.length;
    this.segs.push([a[0], a[1], b[0], b[1], bearingOf(b[0] - a[0], b[1] - a[1])]);
    for (
      let cx = Math.floor(Math.min(a[0], b[0]) / CELL_M);
      cx <= Math.floor(Math.max(a[0], b[0]) / CELL_M);
      cx++
    ) {
      for (
        let cy = Math.floor(Math.min(a[1], b[1]) / CELL_M);
        cy <= Math.floor(Math.max(a[1], b[1]) / CELL_M);
        cy++
      ) {
        const key = `${cx},${cy}`;
        const cell = this.grid.get(key);
        if (cell) cell.push(index);
        else this.grid.set(key, [index]);
      }
    }
  }

  private coversXY(x: number, y: number, heading: number | undefined, toleranceM: number): boolean {
    const r = Math.ceil(toleranceM / CELL_M);
    const cx0 = Math.floor(x / CELL_M);
    const cy0 = Math.floor(y / CELL_M);
    for (let cx = cx0 - r; cx <= cx0 + r; cx++) {
      for (let cy = cy0 - r; cy <= cy0 + r; cy++) {
        for (const s of this.grid.get(`${cx},${cy}`) ?? []) {
          const [ax, ay, bx, by, bearing] = this.segs[s]!;
          if (heading !== undefined && axisDiff(bearing, heading) > MAX_ANGLE_DEG) continue;
          const dx = bx - ax;
          const dy = by - ay;
          const len2 = dx * dx + dy * dy;
          const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
          if (Math.hypot(x - ax - t * dx, y - ay - t * dy) <= toleranceM) return true;
        }
      }
    }
    return false;
  }
}

export const NO_TUNNELS = new TunnelMask([]);

/** Visibility of something `s` metres along a line: 0 inside a tunnel, fading in over `fadeM` at the portals. */
export function portalFade(s: number, ranges: Ranges, fadeM: number): number {
  let scale = 1;
  for (const [a, b] of ranges) {
    if (s >= a && s <= b) return 0;
    scale = Math.min(scale, (s < a ? a - s : s - b) / fadeM);
  }
  return Math.max(0, Math.min(1, scale));
}
