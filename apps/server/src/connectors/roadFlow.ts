import type { LonLat } from '@gbg-osint/shared';
import { fromLocalM, normalizeHeading, simplifyLine, toLocalM } from './util';

export interface RoadWay {
  id: number;
  nodes: readonly number[];
  coords: readonly LonLat[];
  highway: string;
  /** 1: traffic follows the drawing order, -1: against it, 0: both ways. */
  oneway: 1 | -1 | 0;
  name?: string;
  ref?: string;
}

export interface FlowRecord {
  siteId: number;
  lon: number;
  lat: number;
  /** Compass bearing the measured traffic travels towards, when Trafikverket knows it. */
  bearing?: number;
  lane: string;
  flowVehH: number;
  speedKmh?: number;
  measuredAt: string;
}

export interface Corridor {
  id: string;
  /** Road stretch around the measuring site, in travel order. */
  coords: LonLat[];
  flowVehH: number;
  speedKmh: number;
  lanes: number;
  twoWay: boolean;
  road?: string;
  measuredAt: string;
  sites: number[];
}

const CELL_M = 100;
const MATCH_M = 30;
const GROUP_M = 150;
const DEDUPE_M = 350;
const HALF_LENGTH_M = 300;
const MAX_TURN_DEG = 50;

const SIDE_BEARINGS: Record<string, number> = {
  northBound: 0,
  northEastBound: 45,
  eastBound: 90,
  southEastBound: 135,
  southBound: 180,
  southWestBound: 225,
  westBound: 270,
  northWestBound: 315,
};

export function sideBearing(side: string | undefined): number | undefined {
  return side === undefined ? undefined : SIDE_BEARINGS[side];
}

const IMPLIED_ONEWAY = new Set(['motorway', 'motorway_link']);

export function onewayOf(tags: Readonly<Record<string, string>>): 1 | -1 | 0 {
  const v = tags.oneway;
  if (v === '-1') return -1;
  if (v === 'yes' || v === '1' || v === 'true') return 1;
  if (v === 'no') return 0;
  return IMPLIED_ONEWAY.has(tags.highway ?? '') || tags.junction === 'roundabout' ? 1 : 0;
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs(normalizeHeading(a) - normalizeHeading(b));
  return d > 180 ? 360 - d : d;
}

/** Compass bearing of the local-metre vector (dx east, dy north). */
function bearingOf(dx: number, dy: number): number {
  return normalizeHeading((Math.atan2(dx, dy) * 180) / Math.PI);
}

interface Projection {
  way: number;
  seg: number;
  t: number;
  dist: number;
}

/** Road network in local metres with a grid index over its segments. */
class RoadIndex {
  readonly pts: [number, number][][];
  private readonly grid = new Map<string, [number, number][]>();
  private readonly byNode = new Map<number, [number, number][]>();

  constructor(readonly ways: readonly RoadWay[]) {
    this.pts = ways.map((w) => w.coords.map(toLocalM));
    this.pts.forEach((pts, w) => {
      ways[w]!.nodes.forEach((node, i) => {
        const list = this.byNode.get(node) ?? [];
        list.push([w, i]);
        this.byNode.set(node, list);
      });
      for (let s = 1; s < pts.length; s++) {
        const [ax, ay] = pts[s - 1]!;
        const [bx, by] = pts[s]!;
        for (
          let cx = Math.floor(Math.min(ax, bx) / CELL_M);
          cx <= Math.floor(Math.max(ax, bx) / CELL_M);
          cx++
        ) {
          for (
            let cy = Math.floor(Math.min(ay, by) / CELL_M);
            cy <= Math.floor(Math.max(ay, by) / CELL_M);
            cy++
          ) {
            const key = `${cx},${cy}`;
            const cell = this.grid.get(key) ?? [];
            cell.push([w, s - 1]);
            this.grid.set(key, cell);
          }
        }
      }
    });
  }

  /** Segments within `radius` of a point, nearest first. */
  near(x: number, y: number, radius: number): Projection[] {
    const out: Projection[] = [];
    const seen = new Set<string>();
    const r = Math.ceil(radius / CELL_M);
    const cx0 = Math.floor(x / CELL_M);
    const cy0 = Math.floor(y / CELL_M);
    for (let cx = cx0 - r; cx <= cx0 + r; cx++) {
      for (let cy = cy0 - r; cy <= cy0 + r; cy++) {
        for (const [w, s] of this.grid.get(`${cx},${cy}`) ?? []) {
          const key = `${w}:${s}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const [ax, ay] = this.pts[w]![s]!;
          const [bx, by] = this.pts[w]![s + 1]!;
          const dx = bx - ax;
          const dy = by - ay;
          const len2 = dx * dx + dy * dy;
          const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
          const dist = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
          if (dist <= radius) out.push({ way: w, seg: s, t, dist });
        }
      }
    }
    return out.sort((a, b) => a.dist - b.dist);
  }

  segBearing(way: number, seg: number): number {
    const [ax, ay] = this.pts[way]![seg]!;
    const [bx, by] = this.pts[way]![seg + 1]!;
    return bearingOf(bx - ax, by - ay);
  }

  at(way: number, seg: number, t: number): [number, number] {
    const [ax, ay] = this.pts[way]![seg]!;
    const [bx, by] = this.pts[way]![seg + 1]!;
    return [ax + t * (bx - ax), ay + t * (by - ay)];
  }

  /**
   * Points along the network from a position, walking `dir` (+1 in drawing order, -1 against) for
   * `length` metres and continuing onto connected ways that keep a similar heading.
   * `withTraffic` decides which oneway ways may be entered.
   */
  walk(start: Projection, dir: 1 | -1, length: number, withTraffic: boolean): [number, number][] {
    const out: [number, number][] = [this.at(start.way, start.seg, start.t)];
    let remaining = length;
    let way = start.way;
    let index = dir > 0 ? start.seg + 1 : start.seg;
    let d: 1 | -1 = dir;
    const visited = new Set<number>([way]);
    for (;;) {
      const pts = this.pts[way]!;
      while (index >= 0 && index < pts.length) {
        const prev = out[out.length - 1]!;
        const next = pts[index]!;
        const step = Math.hypot(next[0] - prev[0], next[1] - prev[1]);
        if (step >= remaining) {
          const f = step > 0 ? remaining / step : 0;
          out.push([prev[0] + f * (next[0] - prev[0]), prev[1] + f * (next[1] - prev[1])]);
          return out;
        }
        remaining -= step;
        out.push(next);
        index += d;
      }
      const endIndex = d > 0 ? pts.length - 1 : 0;
      const node = this.ways[way]!.nodes[endIndex]!;
      const heading = this.headingAtEnd(out);
      const current = this.ways[way]!;
      let best: { way: number; index: number; dir: 1 | -1; score: number } | undefined;
      for (const [w, i] of this.byNode.get(node) ?? []) {
        if (visited.has(w)) continue;
        const cand = this.ways[w]!;
        for (const cd of [1, -1] as const) {
          const j = i + cd;
          if (j < 0 || j >= this.pts[w]!.length) continue;
          const trafficDir = withTraffic ? cd : -cd;
          if (cand.oneway !== 0 && cand.oneway !== trafficDir) continue;
          const [ax, ay] = this.pts[w]![i]!;
          const [bx, by] = this.pts[w]![j]!;
          const turn = angleDiff(heading, bearingOf(bx - ax, by - ay));
          const score =
            turn +
            (cand.highway === current.highway ? 0 : 20) +
            (cand.highway.endsWith('_link') && !current.highway.endsWith('_link') ? 60 : 0);
          if (turn <= MAX_TURN_DEG && (!best || score < best.score)) {
            best = { way: w, index: j, dir: cd, score };
          }
        }
      }
      if (!best) return out;
      way = best.way;
      index = best.index;
      d = best.dir;
      visited.add(way);
    }
  }

  private headingAtEnd(pts: readonly [number, number][]): number {
    const b = pts[pts.length - 1]!;
    for (let i = pts.length - 2; i >= 0; i--) {
      const a = pts[i]!;
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.5) return bearingOf(b[0] - a[0], b[1] - a[1]);
    }
    return 0;
  }
}

interface Group {
  key: string;
  proj: Projection;
  dir: 1 | -1;
  records: FlowRecord[];
}

/**
 * Road stretches with measured traffic: each Trafikverket lane record is snapped to the nearest
 * OSM carriageway that matches its direction, lanes of one site are summed, and the stretch is
 * extended ±300 m along the road in the direction of travel.
 */
export function buildTrafficCorridors(
  ways: readonly RoadWay[],
  records: readonly FlowRecord[],
): Corridor[] {
  const index = new RoadIndex(ways);
  const groups = new Map<string, Group>();
  for (const r of records) {
    const [x, y] = toLocalM([r.lon, r.lat]);
    const candidates = index.near(x, y, MATCH_M);
    let match: { proj: Projection; dir: 1 | -1 } | undefined;
    for (const proj of candidates) {
      const way = ways[proj.way]!;
      const forward = index.segBearing(proj.way, proj.seg);
      if (way.oneway !== 0) {
        const travel = way.oneway > 0 ? forward : forward + 180;
        if (r.bearing === undefined || angleDiff(travel, r.bearing) <= 100) {
          match = { proj, dir: way.oneway };
          break;
        }
      } else {
        const dir = r.bearing !== undefined && angleDiff(forward, r.bearing) > 90 ? -1 : 1;
        match = { proj, dir };
        break;
      }
    }
    if (!match) continue;
    const way = ways[match.proj.way]!;
    let along = 0;
    const pts = index.pts[match.proj.way]!;
    for (let s = 0; s < match.proj.seg; s++) {
      along += Math.hypot(pts[s + 1]![0] - pts[s]![0], pts[s + 1]![1] - pts[s]![1]);
    }
    const key = `${way.id}:${match.dir}:${Math.round(along / GROUP_M)}`;
    const group = groups.get(key) ?? { key, proj: match.proj, dir: match.dir, records: [] };
    group.records.push(r);
    groups.set(key, group);
  }

  const accepted: { x: number; y: number; bearing: number }[] = [];
  const corridors: Corridor[] = [];
  const ranked = [...groups.values()].sort(
    (a, b) =>
      b.records.reduce((s, r) => s + r.flowVehH, 0) - a.records.reduce((s, r) => s + r.flowVehH, 0),
  );
  for (const g of ranked) {
    const [x, y] = index.at(g.proj.way, g.proj.seg, g.proj.t);
    const forward = index.segBearing(g.proj.way, g.proj.seg);
    const bearing = g.dir > 0 ? forward : normalizeHeading(forward + 180);
    if (
      accepted.some(
        (a) => Math.hypot(a.x - x, a.y - y) < DEDUPE_M && angleDiff(a.bearing, bearing) < 45,
      )
    ) {
      continue;
    }
    accepted.push({ x, y, bearing });
    const ahead = index.walk(g.proj, g.dir, HALF_LENGTH_M, true);
    const behind = index.walk(g.proj, g.dir > 0 ? -1 : 1, HALF_LENGTH_M, false);
    const local = [...behind.slice(1).reverse(), ...ahead];
    const coords = simplifyLine(local.map(fromLocalM), 1);
    if (coords.length < 2) continue;

    const lanes = new Set(g.records.map((r) => `${r.siteId}:${r.lane}`)).size;
    const flow = g.records.reduce((s, r) => s + r.flowVehH, 0);
    const withSpeed = g.records.filter((r) => r.speedKmh !== undefined && r.speedKmh > 0);
    const speedWeight = withSpeed.reduce((s, r) => s + Math.max(1, r.flowVehH), 0);
    const speed =
      speedWeight > 0
        ? withSpeed.reduce((s, r) => s + r.speedKmh! * Math.max(1, r.flowVehH), 0) / speedWeight
        : 0;
    const way = ways[g.proj.way]!;
    const road = way.ref ?? way.name;
    corridors.push({
      id: `flow-${g.key.replace(/:/g, '-')}`,
      coords,
      flowVehH: Math.round(flow),
      speedKmh: Math.round(speed * 10) / 10,
      lanes,
      twoWay: way.oneway === 0,
      ...(road && { road }),
      measuredAt: g.records
        .map((r) => r.measuredAt)
        .sort()
        .at(-1)!,
      sites: [...new Set(g.records.map((r) => r.siteId))].sort((a, b) => a - b),
    });
  }
  return corridors;
}
