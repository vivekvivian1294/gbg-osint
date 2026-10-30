import { decodeLine, type Feature } from '@gbg-osint/shared';
import { Cartesian3, type Scene } from 'cesium';
import type { PickRef } from './markerSpec';
import { ModelLayer, type ModelInstance } from './modelLayer';
import { LocalFrame, pointAlong, toPath, type PathPoint } from './path';
import type { Ground } from './terrain';
import { NO_TUNNELS, portalFade, type Ranges, type TunnelMask } from './tunnels';

const CAR_COLORS = [
  '#f2f2f0',
  '#1b1d21',
  '#9aa1a8',
  '#5d646b',
  '#1f3c73',
  '#8c1d1d',
  '#ffffff',
  '#2f2f33',
  '#c7ccd1',
  '#3b5f3a',
];
const LANE_WIDTH_M = 3.4;
/** Cars are only drawn near the camera; they are illustrative. */
const RANGE_M = 2_200;
const MAX_CARS = 260;
const MAX_PER_CORRIDOR = 40;
const JAM_SPACING_M = 7.5;
const FADE_M = 25;
/** Corridors follow OpenStreetMap ways, so they lie right on the tunnel lines. */
const TUNNEL_TOLERANCE_M = 5;

interface Lane {
  offset: number;
  cars: number[];
}

export interface Corridor {
  id: string;
  frame: LocalFrame;
  path: PathPoint[];
  length: number;
  speedMs: number;
  lanes: Lane[];
  center: Cartesian3;
  /** Stretches (metres along the path) in tunnels, where no cars are drawn. */
  hidden: Ranges;
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Lays out cars on a measured road stretch: density = flow / speed (vehicles per km), capped at
 * jam density, spread over the measured lanes. Starting positions are deterministic per corridor.
 */
export function corridorFrom(
  feature: Feature,
  tunnels: TunnelMask = NO_TUNNELS,
): Corridor | undefined {
  const coords = decodeLine(feature.line);
  if (coords.length < 2) return undefined;
  const frame = new LocalFrame(coords[0]![0], coords[0]![1]);
  const path = toPath(coords.map(([lon, lat]) => frame.toXY(lon, lat)));
  const length = path[path.length - 1]!.d;
  if (length < 50) return undefined;
  const flow = num(feature.props?.flowVehH);
  const speedKmh = num(feature.props?.speedKmh);
  const laneCount = Math.max(1, Math.min(5, Math.round(num(feature.props?.lanes)) || 1));
  const twoWay = feature.props?.twoWay === true;
  const perKm = flow > 0 ? flow / Math.max(speedKmh, 5) : 0;
  const count = Math.min(
    MAX_PER_CORRIDOR,
    Math.round((perKm * length) / 1000),
    Math.floor((laneCount * length) / JAM_SPACING_M),
  );
  const lanes: Lane[] = Array.from({ length: laneCount }, (_, i) => ({
    offset: twoWay ? LANE_WIDTH_M * (i + 0.5) : LANE_WIDTH_M * (i - (laneCount - 1) / 2),
    cars: [],
  }));
  for (let i = 0; i < count; i++) {
    const lane = lanes[i % laneCount]!;
    const slot = Math.floor(i / laneCount);
    const perLane = Math.ceil(count / laneCount);
    const jitter = (hash(`${feature.id}:${i}`) - 0.5) * 0.6;
    lane.cars.push(((slot + 0.5 + jitter) * length) / perLane);
  }
  const mid = pointAlong(path, length / 2);
  const [lon, lat] = frame.toLonLat(mid.x, mid.y);
  return {
    id: feature.id,
    frame,
    path,
    length,
    speedMs: speedKmh / 3.6,
    lanes,
    center: Cartesian3.fromDegrees(lon, lat),
    hidden: tunnels.ranges(coords, TUNNEL_TOLERANCE_M),
  };
}

/** Car positions on a corridor at time `t` (seconds), with a lateral lane offset. */
export function carsAt(c: Corridor, t: number) {
  const cars: { lon: number; lat: number; heading: number; scale: number; index: number }[] = [];
  let index = 0;
  for (const lane of c.lanes) {
    for (const start of lane.cars) {
      const s = (((start + c.speedMs * t) % c.length) + c.length) % c.length;
      const p = pointAlong(c.path, s, 15);
      const heading = p.heading ?? 0;
      const rad = (heading * Math.PI) / 180;
      const x = p.x + Math.cos(rad) * lane.offset;
      const y = p.y - Math.sin(rad) * lane.offset;
      const [lon, lat] = c.frame.toLonLat(x, y);
      const edge = Math.min(s, c.length - s);
      const scale = Math.min(1, Math.max(0, edge / FADE_M), portalFade(s, c.hidden, FADE_M));
      cars.push({ lon, lat, heading, scale, index: index++ });
    }
  }
  return cars;
}

/**
 * Illustrative cars on road stretches where Trafikverket measures traffic. Count and speed
 * follow the latest measurements; individual cars are not real vehicles.
 */
export class TrafficLayer {
  private corridors: Corridor[] = [];
  private readonly models: ModelLayer;
  private channel = '';
  private layerId = '';

  constructor(
    private readonly scene: Scene,
    private readonly ground?: Ground,
  ) {
    this.models = new ModelLayer(scene);
  }

  set(
    layerId: string,
    channel: string,
    features: readonly Feature[],
    tunnels: TunnelMask = NO_TUNNELS,
  ): void {
    this.layerId = layerId;
    this.channel = channel;
    this.corridors = features.flatMap((f) => corridorFrom(f, tunnels) ?? []);
  }

  /** Moves the cars; returns true while any are on screen. */
  update(nowMs: number): boolean {
    const camera = this.scene.camera.positionWC;
    const t = nowMs / 1000;
    const candidates: { inst: ModelInstance; dist: number }[] = [];
    for (const c of this.corridors) {
      if (Cartesian3.distance(camera, c.center) > RANGE_M + c.length) continue;
      const pick: PickRef = { layerId: this.layerId, channel: this.channel, ids: [c.id] };
      for (const car of carsAt(c, t)) {
        if (car.scale <= 0) continue;
        const position = Cartesian3.fromDegrees(
          car.lon,
          car.lat,
          this.ground?.surface(car.lon, car.lat) ?? 0,
        );
        const dist = Cartesian3.distance(camera, position);
        if (dist > RANGE_M) continue;
        candidates.push({
          dist,
          inst: {
            key: `${c.id}#${car.index}`,
            kind: 'car',
            position,
            heading: car.heading,
            scale: [car.scale, car.scale, car.scale],
            accent: CAR_COLORS[Math.floor(hash(`${c.id}#${car.index}`) * CAR_COLORS.length)]!,
            pick,
          },
        });
      }
    }
    candidates.sort((a, b) => a.dist - b.dist);
    const shown = this.models.update(candidates.slice(0, MAX_CARS).map((c) => c.inst));
    return shown.size > 0;
  }

  pickOf(picked: unknown): PickRef | undefined {
    return this.models.pickOf(picked) as PickRef | undefined;
  }

  clear(): void {
    this.corridors = [];
    this.models.update([]);
  }

  destroy(): void {
    this.models.destroy();
  }
}
