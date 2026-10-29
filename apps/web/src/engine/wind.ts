import {
  Cartesian3,
  Ellipsoid,
  EllipsoidalOccluder,
  Math as CesiumMath,
  Matrix4,
  Rectangle,
  type Scene,
} from 'cesium';
import { windVector, type WindField } from '../layers/wind';

const MAX_PARTICLES = 1_500;
const PX_PER_PARTICLE = 900;
const MIN_AGE_FRAMES = 40;
const MAX_AGE_FRAMES = 120;
/** Screen positions kept per particle; the trail fades from the oldest to the newest. */
const TRAIL_POINTS = 28;
const TRAIL_SHADES = [0.15, 0.35, 0.6, 1];
const HEIGHT_M = 30;
/** A 10 m/s wind carries a particle across the view in about this many seconds. */
const CROSS_SECONDS = 8;
const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON = 111_320;
/** Stroke colours (RGB, opacity) by speed: light air, breeze, strong breeze, gale. */
const SPEED_BANDS: readonly [number, string, number][] = [
  [4, '255, 255, 255', 0.5],
  [8, '255, 255, 255', 0.85],
  [14, '253, 230, 138', 0.9],
  [Infinity, '252, 165, 165', 0.95],
];

interface Particle {
  lon: number;
  lat: number;
  age: number;
  maxAge: number;
  band: number;
  /** Recent world positions as x, y, z triples, oldest first. */
  trail: number[];
}

interface Extent {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Flowing wind particles over the map, drawn on their own canvas above the globe. */
export class WindLayer {
  private field: WindField | null = null;
  private particles: Particle[] = [];
  private readonly ctx: CanvasRenderingContext2D | null;
  private lastFrame = 0;
  private readonly position = new Cartesian3();
  private readonly viewProjection = new Matrix4();
  private readonly view = new Rectangle();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly scene: Scene,
  ) {
    this.ctx = canvas.getContext('2d');
  }

  set(field: WindField | null): void {
    this.field = field;
    if (!field) {
      this.particles = [];
      this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  /** Advances and draws the particles; called once per animation frame. */
  update(now: number): void {
    const ctx = this.ctx;
    const field = this.field;
    if (!ctx || !field) return;
    const dt = Math.min(0.1, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;

    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (
      this.canvas.width !== Math.round(width * dpr) ||
      this.canvas.height !== Math.round(height * dpr)
    ) {
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const camera = this.scene.camera;
    const extent = this.extent(field);
    if (!extent) return;
    const target = Math.min(MAX_PARTICLES, Math.floor((width * height) / PX_PER_PARTICLE));
    while (this.particles.length < target) this.particles.push(spawn(extent));
    this.particles.length = target;

    const midLat = (extent.south + extent.north) / 2;
    const cosLat = Math.cos(CesiumMath.toRadians(midLat));
    const viewWidthM = (extent.east - extent.west) * M_PER_DEG_LON * cosLat;
    const timeScale = viewWidthM / (10 * CROSS_SECONDS);
    const occluder = new EllipsoidalOccluder(Ellipsoid.WGS84, camera.positionWC);
    const paths = SPEED_BANDS.map(() => TRAIL_SHADES.map(() => new Path2D()));
    // One matrix per frame: projecting every trail point through Cesium would be too slow.
    const m = Matrix4.multiply(
      camera.frustum.projectionMatrix,
      camera.viewMatrix,
      this.viewProjection,
    );
    const screen: number[] = [];
    const project = (x: number, y: number, z: number) => {
      const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
      if (w <= 0) return false;
      screen.push(
        ((m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w + 1) * 0.5 * width,
        (1 - (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w) * 0.5 * height,
      );
      return true;
    };

    for (let k = 0; k < this.particles.length; k++) {
      const particle = this.particles[k]!;
      const wind = windVector(field, particle.lon, particle.lat);
      if (!wind || ++particle.age > particle.maxAge || !inside(extent, particle)) {
        this.particles[k] = spawn(extent);
        continue;
      }
      particle.lon += (wind.u * timeScale * dt) / (M_PER_DEG_LON * cosLat);
      particle.lat += (wind.v * timeScale * dt) / M_PER_DEG_LAT;
      const speed = Math.hypot(wind.u, wind.v);
      particle.band = SPEED_BANDS.findIndex(([max]) => speed < max);
      const pos = Cartesian3.fromDegrees(
        particle.lon,
        particle.lat,
        HEIGHT_M,
        Ellipsoid.WGS84,
        this.position,
      );
      const t = particle.trail;
      t.push(pos.x, pos.y, pos.z);
      if (t.length > TRAIL_POINTS * 3) t.splice(0, 3);
      if (!occluder.isPointVisible(pos)) continue;

      screen.length = 0;
      for (let i = 0; i < t.length; i += 3) project(t[i]!, t[i + 1]!, t[i + 2]!);
      const segments = screen.length / 2 - 1;
      for (let s = 0; s < segments; s++) {
        const shade = Math.min(
          TRAIL_SHADES.length - 1,
          Math.floor(((s + TRAIL_POINTS - segments) / TRAIL_POINTS) * TRAIL_SHADES.length),
        );
        const path = paths[particle.band]![shade]!;
        path.moveTo(screen[s * 2]!, screen[s * 2 + 1]!);
        path.lineTo(screen[s * 2 + 2]!, screen[s * 2 + 3]!);
      }
    }

    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    SPEED_BANDS.forEach(([, rgb, opacity], band) => {
      TRAIL_SHADES.forEach((shade, i) => {
        ctx.strokeStyle = `rgba(${rgb}, ${(opacity * shade).toFixed(2)})`;
        ctx.stroke(paths[band]![i]!);
      });
    });
  }

  /** Where particles live: the part of the grid in view (all of it when the view is unknown). */
  private extent(field: WindField): Extent | undefined {
    const grid = {
      west: field.lons[0]!,
      south: field.lats[0]!,
      east: field.lons.at(-1)!,
      north: field.lats.at(-1)!,
    };
    const view = this.scene.camera.computeViewRectangle(Ellipsoid.WGS84, this.view);
    if (!view) return grid;
    const e = {
      west: Math.max(grid.west, CesiumMath.toDegrees(view.west)),
      south: Math.max(grid.south, CesiumMath.toDegrees(view.south)),
      east: Math.min(grid.east, CesiumMath.toDegrees(view.east)),
      north: Math.min(grid.north, CesiumMath.toDegrees(view.north)),
    };
    return e.west < e.east && e.south < e.north ? e : undefined;
  }
}

function spawn(e: Extent): Particle {
  return {
    lon: e.west + Math.random() * (e.east - e.west),
    lat: e.south + Math.random() * (e.north - e.south),
    age: 0,
    maxAge: MIN_AGE_FRAMES + Math.random() * (MAX_AGE_FRAMES - MIN_AGE_FRAMES),
    band: 0,
    trail: [],
  };
}

const inside = (e: Extent, p: Particle) =>
  p.lon >= e.west && p.lon <= e.east && p.lat >= e.south && p.lat <= e.north;
