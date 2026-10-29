import type { LonLat } from '@gbg-osint/shared';
import type { ConnectorContext } from '../core/connector';
import { BUILDING_TILES, openFreeMapTileUrl } from './buildings';
import { decodeMvt, type MvtValue } from './mvt';
import { fromLocalM, normalizeHeading, simplifyLine, toLocalM } from './util';

/**
 * Street, tram-track and rail networks from OpenFreeMap's OpenMapTiles `transportation` layer,
 * used to map-match transit vehicles: positions are snapped to the network and the route
 * between consecutive positions follows it, so playback runs along streets and tracks.
 */

export const NETWORK_ZOOM = 14;
const TILE_MAX_AGE_MS = 30 * 24 * 3600_000;
const MAX_TILE_BYTES = 8 * 1024 * 1024;
const RETRY_FAILED_MS = 10 * 60_000;
const FETCH_CONCURRENCY = 3;

export type NetworkName = 'tram' | 'road' | 'rail';

/** One tile's lines as flat `[x0, y0, x1, y1, …]` arrays in local metres (0.1 m precision). */
export interface NetworkTile {
  x: number;
  y: number;
  tram: number[][];
  road: number[][];
  /** Service roads: allowed for buses but less likely than real streets. */
  service: number[][];
  rail: number[][];
}

type LineKind = 'tram' | 'road' | 'service' | 'rail';

const ROAD_CLASSES = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'minor',
  'busway',
  'bus_guideway',
]);
const SKIPPED_SERVICE = new Set(['driveway', 'parking_aisle']);
const SKIPPED_RAIL_SERVICE = new Set(['yard', 'spur']);

function lineKind(p: Readonly<Record<string, MvtValue>>): LineKind | undefined {
  const cls = p.class;
  if (cls === 'transit')
    return p.subclass === 'tram' || p.subclass === 'light_rail' ? 'tram' : undefined;
  if (cls === 'rail') {
    return p.subclass === 'rail' && !SKIPPED_RAIL_SERVICE.has(String(p.service))
      ? 'rail'
      : undefined;
  }
  if (typeof cls === 'string' && ROAD_CLASSES.has(cls)) return 'road';
  if (cls === 'service') return SKIPPED_SERVICE.has(String(p.service)) ? undefined : 'service';
  return undefined;
}

/** Liang–Barsky: the part of a segment inside [0, size]², or undefined. */
function clipSegment(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  size: number,
): [number, number, number, number] | undefined {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [
    [-dx, x0],
    [dx, size - x0],
    [-dy, y0],
    [dy, size - y0],
  ] as const) {
    if (p === 0) {
      if (q < 0) return undefined;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 >= t1) return undefined;
  }
  return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
}

/** Clips a flat polyline to [0, size]²; tiles carry a buffer that would overlap neighbours. */
export function clipLine(line: readonly number[], size: number): number[][] {
  const pieces: number[][] = [];
  let current: number[] = [];
  for (let i = 2; i + 1 < line.length; i += 2) {
    const seg = clipSegment(line[i - 2]!, line[i - 1]!, line[i]!, line[i + 1]!, size);
    if (!seg) continue;
    const [x0, y0, x1, y1] = seg;
    const n = current.length;
    if (n >= 2 && current[n - 2] === x0 && current[n - 1] === y0) {
      current.push(x1, y1);
    } else {
      if (n >= 4) pieces.push(current);
      current = [x0, y0, x1, y1];
    }
  }
  if (current.length >= 4) pieces.push(current);
  return pieces;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

function tileToLocal(tx: number, ty: number, px: number, py: number, extent: number) {
  const n = 2 ** NETWORK_ZOOM;
  const lon = ((tx + px / extent) / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + py / extent)) / n))) * 180) / Math.PI;
  return toLocalM([lon, lat]);
}

export function parseNetworkTile(pbf: Uint8Array, x: number, y: number): NetworkTile {
  const tile: NetworkTile = { x, y, tram: [], road: [], service: [], rail: [] };
  const layer = decodeMvt(pbf, new Set(['transportation']))[0];
  if (!layer) return tile;
  for (const f of layer.features) {
    if (f.type !== 2) continue;
    const kind = lineKind(f.properties);
    if (!kind) continue;
    for (const part of f.geometry) {
      for (const piece of clipLine(part, layer.extent)) {
        const out: number[] = [];
        for (let i = 0; i < piece.length; i += 2) {
          const [lx, ly] = tileToLocal(x, y, piece[i]!, piece[i + 1]!, layer.extent);
          out.push(round1(lx), round1(ly));
        }
        tile[kind].push(out);
      }
    }
  }
  return tile;
}

// --- Graph ---

export interface GraphSnap {
  seg: number;
  /** Fraction along the segment from its first node to its second. */
  t: number;
  x: number;
  y: number;
  dist: number;
}

/** Vertices closer than this are the same node (shared OSM nodes, tile-edge crossings). */
const MERGE_M = 0.6;
/** Line ends this close to another line are joined to it (junctions lost to simplification). */
const JOIN_M = 1.5;
const SEG_CELL_M = 40;
const GRID_OFFSET = 2 ** 19;
const GRID_SPAN = 2 ** 20;
const MAX_EXPANSIONS = 40_000;
/** Snapping penalty per unit of extra cost, so main streets win over parallel service roads. */
const COST_SNAP_PENALTY_M = 10;
const RAD = Math.PI / 180;
const U_TURN_DEG = 150;

export interface RouteOptions {
  /** Sharper turns at a node are impossible (rail vehicles can't reverse through a switch). */
  maxTurnDeg?: number;
  /** Extra cost of turning back at a node (e.g. a bus U-turn). */
  uTurnPenaltyM?: number;
  /** Extra cost of setting off against the direction of travel. */
  backwardPenaltyM?: number;
}

const cellKey = (ix: number, iy: number) => (ix + GRID_OFFSET) * GRID_SPAN + (iy + GRID_OFFSET);

class MinHeap {
  private readonly keys: number[] = [];
  private readonly values: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  peek(): number {
    return this.keys[0] ?? Infinity;
  }

  push(key: number, value: number): void {
    const { keys, values } = this;
    let i = keys.length;
    keys.push(key);
    values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent]! <= key) break;
      keys[i] = keys[parent]!;
      values[i] = values[parent]!;
      i = parent;
    }
    keys[i] = key;
    values[i] = value;
  }

  pop(): number {
    const { keys, values } = this;
    const top = values[0]!;
    const lastKey = keys.pop()!;
    const lastValue = values.pop()!;
    const n = keys.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const c = l + 1 < n && keys[l + 1]! < keys[l]! ? l + 1 : l;
        if (keys[c]! >= lastKey) break;
        keys[i] = keys[c]!;
        values[i] = values[c]!;
        i = c;
      }
      keys[i] = lastKey;
      values[i] = lastValue;
    }
    return top;
  }
}

/** Undirected line network in local metres with snapping and shortest paths. */
export class LineGraph {
  private readonly xs: number[] = [];
  private readonly ys: number[] = [];
  private readonly nodeSegs: number[][] = [];
  private readonly segA: number[] = [];
  private readonly segB: number[] = [];
  private readonly segCost: number[] = [];
  private readonly nodeGrid = new Map<number, number[]>();
  private readonly segGrid = new Map<number, number[]>();
  private live = 0;

  get nodeCount(): number {
    return this.xs.length;
  }

  get segmentCount(): number {
    return this.live;
  }

  degree(node: number): number {
    return this.nodeSegs[node]?.length ?? 0;
  }

  /** Compass bearing of a segment from its first node to its second. */
  bearingOf(seg: number): number | undefined {
    const a = this.segA[seg]!;
    const b = this.segB[seg]!;
    if (a < 0) return undefined;
    return headingOf(this.xs[b]! - this.xs[a]!, this.ys[b]! - this.ys[a]!);
  }

  /** Adds a flat `[x0, y0, x1, y1, …]` polyline; returns its end nodes. */
  addLine(flat: readonly number[], cost = 1): [number, number] | undefined {
    let first = -1;
    let prev = -1;
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const node = this.nodeAt(flat[i]!, flat[i + 1]!);
      if (first < 0) first = node;
      if (prev >= 0 && node !== prev) this.addSegment(prev, node, cost);
      prev = node;
    }
    return first < 0 ? undefined : [first, prev];
  }

  /** Connects a dangling line end to a line passing within JOIN_M of it. */
  joinEnd(node: number): boolean {
    if (this.degree(node) !== 1) return false;
    const snap = this.snap(this.xs[node]!, this.ys[node]!, JOIN_M, undefined, 0, node);
    if (!snap) return false;
    const cost = this.segCost[this.nodeSegs[node]![0]!]!;
    const target = this.split(snap.seg, snap.t);
    if (target !== node) this.addSegment(node, target, cost);
    return true;
  }

  /**
   * Nearest segment within `maxDist`. With a heading, segments across the direction of travel
   * cost up to `headingWeightM` extra metres, which picks the right street at junctions.
   */
  snap(
    x: number,
    y: number,
    maxDist: number,
    heading?: number,
    headingWeightM = 0,
    excludeNode = -1,
  ): GraphSnap | undefined {
    const hx = heading !== undefined ? Math.sin(heading * RAD) : 0;
    const hy = heading !== undefined ? Math.cos(heading * RAD) : 0;
    const seen = new Set<number>();
    let best: GraphSnap | undefined;
    let bestScore = Infinity;
    const x0 = Math.floor((x - maxDist) / SEG_CELL_M);
    const x1 = Math.floor((x + maxDist) / SEG_CELL_M);
    const y0 = Math.floor((y - maxDist) / SEG_CELL_M);
    const y1 = Math.floor((y + maxDist) / SEG_CELL_M);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        for (const s of this.segGrid.get(cellKey(ix, iy)) ?? []) {
          if (seen.has(s)) continue;
          seen.add(s);
          const a = this.segA[s]!;
          const b = this.segB[s]!;
          if (a < 0 || a === excludeNode || b === excludeNode) continue;
          const ax = this.xs[a]!;
          const ay = this.ys[a]!;
          const dx = this.xs[b]! - ax;
          const dy = this.ys[b]! - ay;
          const len2 = dx * dx + dy * dy;
          const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
          const px = ax + t * dx;
          const py = ay + t * dy;
          const dist = Math.hypot(x - px, y - py);
          if (dist > maxDist) continue;
          let score = dist + (this.segCost[s]! - 1) * COST_SNAP_PENALTY_M;
          if (heading !== undefined && len2 > 0) {
            score += headingWeightM * (1 - Math.abs(dx * hx + dy * hy) / Math.sqrt(len2));
          }
          if (score < bestScore) {
            bestScore = score;
            best = { seg: s, t, x: px, y: py, dist };
          }
        }
      }
    }
    return best;
  }

  /**
   * Shortest path along the network between two snapped points (A* over directed segments, so
   * turns can be limited), or undefined. `heading` is the direction of travel at `from`.
   */
  route(
    from: GraphSnap,
    to: GraphSnap,
    maxCost: number,
    opts: RouteOptions = {},
    heading?: number,
  ): [number, number][] | undefined {
    if (this.segA[from.seg]! < 0 || this.segA[to.seg]! < 0) return undefined;
    if (from.seg === to.seg) {
      return [
        [from.x, from.y],
        [to.x, to.y],
      ];
    }
    // A state is a segment traversed towards one of its ends: seg * 2 + (towards B ? 1 : 0).
    const nodeOf = (st: number) => (st & 1 ? this.segB[st >> 1]! : this.segA[st >> 1]!);
    const fromOf = (st: number) => (st & 1 ? this.segA[st >> 1]! : this.segB[st >> 1]!);
    const g = new Map<number, number>();
    const prev = new Map<number, number>();
    const heap = new MinHeap();
    const h = (n: number) => Math.hypot(this.xs[n]! - to.x, this.ys[n]! - to.y);
    const turnCost = (a: number, b: number, c: number) => this.turnCost(a, b, c, opts);
    const hx = heading !== undefined ? Math.sin(heading * RAD) : 0;
    const hy = heading !== undefined ? Math.cos(heading * RAD) : 0;
    const startLen = this.weight(from.seg);
    for (const towardsB of [true, false]) {
      const st = from.seg * 2 + (towardsB ? 1 : 0);
      const node = nodeOf(st);
      const dx = this.xs[node]! - from.x;
      const dy = this.ys[node]! - from.y;
      const backwards = heading !== undefined && dx * hx + dy * hy < 0;
      const cost =
        (towardsB ? 1 - from.t : from.t) * startLen +
        (backwards ? (opts.backwardPenaltyM ?? 0) : 0);
      g.set(st, cost);
      prev.set(st, -1);
      heap.push(cost + h(node), st);
    }
    const goalLen = this.weight(to.seg);
    const goalA = this.segA[to.seg]!;
    const goalB = this.segB[to.seg]!;
    let best = maxCost;
    let bestState = -1;
    let expansions = 0;
    while (heap.size > 0 && heap.peek() < best && expansions++ < MAX_EXPANSIONS) {
      const key = heap.peek();
      const st = heap.pop();
      const node = nodeOf(st);
      const back = fromOf(st);
      const gs = g.get(st)!;
      if (key > gs + h(node) + 1e-6) continue;
      if ((node === goalA || node === goalB) && st >> 1 !== to.seg) {
        const onward = node === goalA ? goalB : goalA;
        const turn = turnCost(back, node, onward);
        const extra = (node === goalA ? to.t : 1 - to.t) * goalLen + turn;
        if (turn < Infinity && gs + extra < best) {
          best = gs + extra;
          bestState = st;
        }
      }
      for (const s of this.nodeSegs[node]!) {
        if (s === st >> 1) continue;
        const next = this.segA[s] === node ? this.segB[s]! : this.segA[s]!;
        const cost = gs + this.weight(s) + turnCost(back, node, next);
        const ns = s * 2 + (next === this.segB[s] ? 1 : 0);
        if (cost >= best || cost >= (g.get(ns) ?? Infinity)) continue;
        g.set(ns, cost);
        prev.set(ns, st);
        heap.push(cost + h(next), ns);
      }
    }
    if (bestState < 0) return undefined;
    const chain: number[] = [];
    for (let st = bestState; st >= 0; st = prev.get(st)!) chain.push(nodeOf(st));
    chain.reverse();
    return [
      [from.x, from.y],
      ...chain.map((n): [number, number] => [this.xs[n]!, this.ys[n]!]),
      [to.x, to.y],
    ];
  }

  /** Extra cost of turning at `b` when coming from `a` and going on to `c` (Infinity = not allowed). */
  private turnCost(a: number, b: number, c: number, opts: RouteOptions): number {
    if (opts.maxTurnDeg === undefined && opts.uTurnPenaltyM === undefined) return 0;
    const ix = this.xs[b]! - this.xs[a]!;
    const iy = this.ys[b]! - this.ys[a]!;
    const ox = this.xs[c]! - this.xs[b]!;
    const oy = this.ys[c]! - this.ys[b]!;
    const len = Math.hypot(ix, iy) * Math.hypot(ox, oy);
    if (len === 0) return 0;
    const deviation = Math.acos(Math.max(-1, Math.min(1, (ix * ox + iy * oy) / len))) / RAD;
    if (opts.maxTurnDeg !== undefined && deviation > opts.maxTurnDeg) return Infinity;
    return deviation > U_TURN_DEG ? (opts.uTurnPenaltyM ?? 0) : 0;
  }

  private weight(s: number): number {
    const a = this.segA[s]!;
    const b = this.segB[s]!;
    return Math.hypot(this.xs[b]! - this.xs[a]!, this.ys[b]! - this.ys[a]!) * this.segCost[s]!;
  }

  private nodeAt(x: number, y: number): number {
    const cx = Math.floor(x / MERGE_M);
    const cy = Math.floor(y / MERGE_M);
    let best = -1;
    let bestDist = MERGE_M;
    for (let ix = cx - 1; ix <= cx + 1; ix++) {
      for (let iy = cy - 1; iy <= cy + 1; iy++) {
        for (const n of this.nodeGrid.get(cellKey(ix, iy)) ?? []) {
          const d = Math.hypot(this.xs[n]! - x, this.ys[n]! - y);
          if (d <= bestDist) {
            best = n;
            bestDist = d;
          }
        }
      }
    }
    if (best >= 0) return best;
    const id = this.xs.length;
    this.xs.push(x);
    this.ys.push(y);
    this.nodeSegs.push([]);
    const key = cellKey(cx, cy);
    const cell = this.nodeGrid.get(key);
    if (cell) cell.push(id);
    else this.nodeGrid.set(key, [id]);
    return id;
  }

  private addSegment(a: number, b: number, cost: number): void {
    for (const s of this.nodeSegs[a]!) {
      if (this.segA[s] === b || this.segB[s] === b) return;
    }
    const id = this.segA.length;
    this.segA.push(a);
    this.segB.push(b);
    this.segCost.push(cost);
    this.nodeSegs[a]!.push(id);
    this.nodeSegs[b]!.push(id);
    this.live++;
    const ax = this.xs[a]!;
    const ay = this.ys[a]!;
    const bx = this.xs[b]!;
    const by = this.ys[b]!;
    for (
      let ix = Math.floor(Math.min(ax, bx) / SEG_CELL_M);
      ix * SEG_CELL_M <= Math.max(ax, bx);
      ix++
    ) {
      for (
        let iy = Math.floor(Math.min(ay, by) / SEG_CELL_M);
        iy * SEG_CELL_M <= Math.max(ay, by);
        iy++
      ) {
        const key = cellKey(ix, iy);
        const cell = this.segGrid.get(key);
        if (cell) cell.push(id);
        else this.segGrid.set(key, [id]);
      }
    }
  }

  private removeSegment(s: number): void {
    for (const node of [this.segA[s]!, this.segB[s]!]) {
      const segs = this.nodeSegs[node]!;
      const i = segs.indexOf(s);
      if (i >= 0) segs.splice(i, 1);
    }
    this.segA[s] = -1;
    this.segB[s] = -1;
    this.live--;
  }

  /** Inserts a node on a segment, or returns the end node it would coincide with. */
  private split(s: number, t: number): number {
    const a = this.segA[s]!;
    const b = this.segB[s]!;
    const cost = this.segCost[s]!;
    const node = this.nodeAt(
      this.xs[a]! + (this.xs[b]! - this.xs[a]!) * t,
      this.ys[a]! + (this.ys[b]! - this.ys[a]!) * t,
    );
    if (node === a || node === b) return node;
    this.removeSegment(s);
    this.addSegment(a, node, cost);
    this.addSegment(node, b, cost);
    return node;
  }
}

// --- Map matching ---

export interface MatchOptions extends RouteOptions {
  maxSnapM: number;
  /** Shifts the position towards the running side before snapping: + right, − left. */
  sideBiasM: number;
  headingWeightM: number;
}

/** Trams run on the right in Gothenburg; Swedish railways run on the left. */
export const MATCH_OPTIONS: Record<NetworkName, MatchOptions> = {
  tram: {
    maxSnapM: 25,
    sideBiasM: 1.8,
    headingWeightM: 20,
    maxTurnDeg: 60,
    backwardPenaltyM: 300,
  },
  road: {
    maxSnapM: 35,
    sideBiasM: 0,
    headingWeightM: 15,
    uTurnPenaltyM: 150,
    backwardPenaltyM: 150,
  },
  rail: {
    maxSnapM: 30,
    sideBiasM: -2.2,
    headingWeightM: 20,
    maxTurnDeg: 45,
    backwardPenaltyM: 500,
  },
};

export interface MatchState {
  x: number;
  y: number;
  heading?: number;
}

export interface MatchResult {
  x: number;
  y: number;
  /** Direction of travel, when known from movement. */
  heading?: number;
  /** Bearing of the street or track here (either way along it), to draw a vehicle with no
   * known direction of travel along the street rather than across it. */
  axis?: number;
  /** Points travelled since the previous state, excluding both ends. */
  via: [number, number][];
}

/** Movements shorter than this are GPS noise around a stop. */
const HOLD_M = 3;
/** Short moves against the direction of travel are noise too; vehicles don't reverse. */
const BACKWARD_MAX_M = 40;
const BACKWARD_ANGLE = 110;

function headingOf(dx: number, dy: number): number | undefined {
  return dx === 0 && dy === 0 ? undefined : normalizeHeading(Math.atan2(dx, dy) / RAD);
}

function angleBetween(a: number, b: number): number {
  return Math.abs(((b - a + 540) % 360) - 180);
}

/** Point at distance `d` along a polyline (clamped). */
function along(pts: readonly (readonly [number, number])[], d: number): [number, number] {
  let left = Math.max(0, d);
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1]!;
    const [bx, by] = pts[i]!;
    const len = Math.hypot(bx - ax, by - ay);
    if (left <= len && len > 0)
      return [ax + ((bx - ax) * left) / len, ay + ((by - ay) * left) / len];
    left -= len;
  }
  const last = pts[pts.length - 1]!;
  return [last[0], last[1]];
}

function lengthOf(pts: readonly (readonly [number, number])[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  }
  return total;
}

/**
 * Snaps a new position to the network and routes from the previous state to it. Returns
 * undefined when the position is too far from the network (the raw position is used instead).
 */
export function matchMove(
  graph: LineGraph,
  prev: MatchState | undefined,
  x: number,
  y: number,
  opts: MatchOptions,
  /** Direction the vehicle itself reports, used when there is no previous heading. */
  hint?: number,
): MatchResult | undefined {
  const heading = prev?.heading ?? hint;
  let qx = x;
  let qy = y;
  if (heading !== undefined && opts.sideBiasM !== 0) {
    qx += Math.cos(heading * RAD) * opts.sideBiasM;
    qy -= Math.sin(heading * RAD) * opts.sideBiasM;
  }
  const snap = graph.snap(qx, qy, opts.maxSnapM, heading, opts.headingWeightM);
  if (!snap) return undefined;
  const axis = withAxis(graph.bearingOf(snap.seg));
  if (!prev) return { x: snap.x, y: snap.y, ...axis, via: [] };
  const keep: MatchResult = {
    x: prev.x,
    y: prev.y,
    ...(heading !== undefined && { heading }),
    ...axis,
    via: [],
  };
  const crow = Math.hypot(snap.x - prev.x, snap.y - prev.y);
  if (crow < HOLD_M) return keep;
  const from = graph.snap(prev.x, prev.y, opts.maxSnapM, heading, opts.headingWeightM);
  const path = from && graph.route(from, snap, crow * 2 + 100, opts, heading);
  if (!path) {
    const direct = headingOf(snap.x - prev.x, snap.y - prev.y) ?? heading;
    return { x: snap.x, y: snap.y, ...withHeading(direct), via: [] };
  }
  const length = lengthOf(path);
  if (heading !== undefined && length < BACKWARD_MAX_M) {
    const [sx, sy] = along(path, Math.min(3, length));
    const start = headingOf(sx - path[0]![0], sy - path[0]![1]);
    if (start !== undefined && angleBetween(start, heading) > BACKWARD_ANGLE) return keep;
  }
  const [ex, ey] = along(path, length - 6);
  const end = headingOf(snap.x - ex, snap.y - ey) ?? heading;
  const [fx, fy] = path[0]!;
  const via = path.slice(Math.hypot(fx - prev.x, fy - prev.y) > 0.5 ? 0 : 1, -1);
  return { x: snap.x, y: snap.y, ...withHeading(end), via: simplifyXY(via, snap) };
}

function withHeading(heading: number | undefined) {
  return heading !== undefined ? { heading } : {};
}

function withAxis(axis: number | undefined) {
  return axis !== undefined ? { axis } : {};
}

/** Drops intermediate points that add nothing (straight runs), to keep updates small. */
function simplifyXY(via: [number, number][], end: { x: number; y: number }): [number, number][] {
  if (via.length === 0) return via;
  const line = [...via, [end.x, end.y] as [number, number]].map(fromLocalM);
  return simplifyLine(line, 0.3).slice(0, -1).map(toLocalM);
}

// --- Tile loading ---

const tileKey = (x: number, y: number) => `${x}-${y}`;

/** Tiles within `radiusM` of a point (1–4 tiles). */
export function tilesNear(lon: number, lat: number, radiusM: number): [number, number][] {
  const n = 2 ** NETWORK_ZOOM;
  const dLat = radiusM / 110_540;
  const dLon = radiusM / (111_320 * Math.cos(lat * RAD));
  const tx = (v: number) => Math.floor(((v + 180) / 360) * n);
  const ty = (v: number) => {
    const phi = v * RAD;
    return Math.floor(((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n);
  };
  const out: [number, number][] = [];
  for (let x = tx(lon - dLon); x <= tx(lon + dLon); x++) {
    for (let y = ty(lat + dLat); y <= ty(lat - dLat); y++) out.push([x, y]);
  }
  return out;
}

/** Lazily loaded networks around Gothenburg, cached on disk per tile. */
export class StreetNetwork {
  readonly graphs: Record<NetworkName, LineGraph> = {
    tram: new LineGraph(),
    road: new LineGraph(),
    rail: new LineGraph(),
  };
  private readonly loaded = new Set<string>();
  private readonly failedAt = new Map<string, number>();

  get tileCount(): number {
    return this.loaded.size;
  }

  has(x: number, y: number): boolean {
    return this.loaded.has(tileKey(x, y));
  }

  /** Adds a parsed tile's lines to the graphs (idempotent per tile). */
  add(tile: NetworkTile): void {
    const key = tileKey(tile.x, tile.y);
    if (this.loaded.has(key)) return;
    this.loaded.add(key);
    const sets: [LineGraph, number[][], number][] = [
      [this.graphs.tram, tile.tram, 1],
      [this.graphs.road, tile.road, 1],
      [this.graphs.road, tile.service, 1.5],
      [this.graphs.rail, tile.rail, 1],
    ];
    const ends: [LineGraph, number][] = [];
    for (const [graph, lines, cost] of sets) {
      for (const line of lines) {
        const nodes = graph.addLine(line, cost);
        if (nodes) ends.push([graph, nodes[0]], [graph, nodes[1]]);
      }
    }
    // Junctions dropped by tile simplification, and crossings of the tile edge that the
    // neighbour tile placed a little differently.
    for (const [graph, node] of ends) graph.joinEnd(node);
  }

  /**
   * Loads the given tiles (most important first) from the disk cache, fetching at most
   * `maxFetches` new ones from OpenFreeMap so first-time coverage builds up over a few polls.
   */
  async ensure(
    ctx: ConnectorContext,
    tiles: readonly (readonly [number, number])[],
    maxFetches: number,
  ): Promise<void> {
    const now = Date.now();
    const b = BUILDING_TILES;
    const queue: [number, number][] = [];
    const queued = new Set<string>();
    for (const [x, y] of tiles) {
      const key = tileKey(x, y);
      if (this.loaded.has(key) || queued.has(key)) continue;
      if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) continue;
      if (now - (this.failedAt.get(key) ?? -Infinity) < RETRY_FAILED_MS) continue;
      queued.add(key);
      queue.push([x, y]);
    }
    let fetches = 0;
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [x, y] = next;
        const cacheKey = `net-${x}-${y}`;
        try {
          let tile = (await ctx.cache.get<NetworkTile>(cacheKey, TILE_MAX_AGE_MS))?.value;
          if (!tile) {
            if (fetches >= maxFetches) continue;
            fetches++;
            try {
              const url = await openFreeMapTileUrl(ctx, NETWORK_ZOOM, x, y);
              const pbf = await ctx.http.getBytes(url, {
                maxBytes: MAX_TILE_BYTES,
                timeoutMs: 30_000,
              });
              tile = parseNetworkTile(pbf, x, y);
              await ctx.cache.set(cacheKey, tile);
            } catch (err) {
              tile = (await ctx.cache.get<NetworkTile>(cacheKey, Infinity))?.value;
              if (!tile) throw err;
            }
          }
          this.add(tile);
        } catch (err) {
          this.failedAt.set(tileKey(x, y), Date.now());
          ctx.log.warn({ err, tile: `${x}/${y}` }, 'Street network tile failed');
        }
      }
    };
    await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));
  }
}

export function toLonLatPath(pts: readonly (readonly [number, number])[]): LonLat[] {
  return pts.map(([x, y]) => {
    const [lon, lat] = fromLocalM([x, y]);
    return [round6(lon), round6(lat)];
  });
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
/** Network tiles must be loaded this far around a position before it is matched. */
const READY_M = 60;

/** One network shared by all transit connectors, so tiles are loaded and kept once. */
export const STREET_NETWORK = new StreetNetwork();

export interface Placed {
  lon: number;
  lat: number;
  /** Direction of travel. */
  heading?: number;
  /** Street or track bearing, for vehicles whose direction isn't known yet. */
  axis?: number;
  /** Route since the previous position, excluding both ends. */
  via?: LonLat[];
}

/**
 * Snaps a vehicle to a network and routes from its previous position. A heading the vehicle
 * reports itself takes precedence over the previous one. Undefined while the network around it
 * isn't loaded, or when it is too far from any line.
 */
export function placeOnNetwork(
  network: StreetNetwork,
  name: NetworkName,
  here: { lon: number; lat: number },
  prev?: { lon: number; lat: number; heading?: number },
  reportedHeading?: number,
): Placed | undefined {
  const points = prev ? [here, prev] : [here];
  const ready = points.every((p) =>
    tilesNear(p.lon, p.lat, READY_M).every(([x, y]) => network.has(x, y)),
  );
  if (!ready) return undefined;
  const [x, y] = toLocalM([here.lon, here.lat]);
  let state: MatchState | undefined;
  if (prev) {
    const [px, py] = toLocalM([prev.lon, prev.lat]);
    const heading = reportedHeading ?? prev.heading;
    state = { x: px, y: py, ...withHeading(heading) };
  }
  const match = matchMove(network.graphs[name], state, x, y, MATCH_OPTIONS[name], reportedHeading);
  if (!match) return undefined;
  const [lon, lat] = fromLocalM([match.x, match.y]);
  return {
    lon: round6(lon),
    lat: round6(lat),
    ...(match.heading !== undefined && { heading: round1(match.heading) }),
    ...(match.axis !== undefined && { axis: round1(match.axis) }),
    ...(match.via.length > 0 && { via: toLonLatPath(match.via) }),
  };
}

/** Tiles within `marginM` of weighted points, heaviest first, for `StreetNetwork.ensure`. */
export function rankTiles(
  points: readonly { lon: number; lat: number; weight: number }[],
  marginM: number,
): [number, number][] {
  const weights = new Map<string, { tile: [number, number]; weight: number }>();
  for (const p of points) {
    for (const tile of tilesNear(p.lon, p.lat, marginM)) {
      const key = tile.join('/');
      const entry = weights.get(key);
      if (entry) entry.weight += p.weight;
      else weights.set(key, { tile, weight: p.weight });
    }
  }
  return [...weights.values()].sort((a, b) => b.weight - a.weight).map((e) => e.tile);
}
