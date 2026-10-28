import {
  Cartesian2,
  Cartesian3,
  Ellipsoid,
  EllipsoidalOccluder,
  SceneTransforms,
  type Scene,
} from 'cesium';
import type { MarkerRenderer } from './markers';

export interface OverlayOptions {
  detection: boolean;
  /** Share of detectable markers that get a box, nearest first (0–1). */
  density: number;
  trackedKey: string | null;
  color: string;
}

export interface OverlayStats {
  contactsInView: number;
  markersInView: number;
}

interface Box {
  x: number;
  y: number;
  distance: number;
  code: string;
  label: string | undefined;
  tag: string | undefined;
  stale: boolean;
}

const MAX_BOXES = 150;
const TRAIL_SAMPLE_MS = 1000;
const TRAIL_MAX_POINTS = 180;

/**
 * 2D canvas drawn after each globe render: detection boxes, the tracked target's reticle and its
 * fading trail. Sits above the WebGL canvas, so sensor styles don't distort it.
 */
export class Overlay {
  options: OverlayOptions = { detection: false, density: 1, trackedKey: null, color: '#5eead4' };
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly scratch = new Cartesian2();
  private trail: Cartesian3[] = [];
  private trailKey: string | null = null;
  private lastSample = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly scene: Scene,
    private readonly renderer: MarkerRenderer,
  ) {
    this.ctx = canvas.getContext('2d');
  }

  draw(now = performance.now()): OverlayStats {
    const stats: OverlayStats = { contactsInView: 0, markersInView: 0 };
    const ctx = this.ctx;
    if (!ctx) return stats;
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
    const occluder = new EllipsoidalOccluder(Ellipsoid.WGS84, camera.positionWC);
    const boxes: Box[] = [];
    for (const { spec, position, stale } of this.renderer.entries()) {
      const win = this.project(position, occluder, width, height);
      if (!win) continue;
      stats.markersInView++;
      if (!spec.detect) continue;
      stats.contactsInView++;
      boxes.push({
        x: win.x,
        y: win.y,
        distance: Cartesian3.distance(camera.positionWC, position),
        code: spec.detect.code,
        label: spec.label,
        tag: spec.detect.tag,
        stale,
      });
    }

    const { detection, density, trackedKey, color } = this.options;
    if (detection && boxes.length > 0) {
      boxes.sort((a, b) => a.distance - b.distance);
      const count = Math.min(MAX_BOXES, Math.ceil(boxes.length * density));
      for (const box of boxes.slice(0, count)) this.drawBox(ctx, box, color);
    }
    this.drawTrack(ctx, trackedKey, occluder, width, height, now, color);
    return stats;
  }

  private project(
    position: Cartesian3,
    occluder: EllipsoidalOccluder,
    width: number,
    height: number,
  ): Cartesian2 | undefined {
    if (!occluder.isPointVisible(position)) return undefined;
    const win = SceneTransforms.worldToWindowCoordinates(this.scene, position, this.scratch);
    if (!win || win.x < 0 || win.y < 0 || win.x > width || win.y > height) return undefined;
    return win;
  }

  private drawBox(ctx: CanvasRenderingContext2D, box: Box, color: string): void {
    const size = Math.max(18, Math.min(46, 2.5e5 / Math.max(box.distance, 1)));
    const half = size / 2;
    const corner = size * 0.3;
    const { x, y } = box;
    ctx.globalAlpha = box.stale ? 0.4 : 0.95;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      const cx = x + sx * half;
      const cy = y + sy * half;
      ctx.moveTo(cx, cy - sy * corner);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx - sx * corner, cy);
    }
    ctx.stroke();

    const lines = [box.code, [box.label, box.tag].filter(Boolean).join(' · ')].filter(Boolean);
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'top';
    let ty = y + half + 3;
    for (const line of lines) {
      const w = ctx.measureText(line).width;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.fillRect(x - half, ty - 1, w + 6, 12);
      ctx.fillStyle = color;
      ctx.fillText(line, x - half + 3, ty);
      ty += 12;
    }
    ctx.globalAlpha = 1;
  }

  private drawTrack(
    ctx: CanvasRenderingContext2D,
    key: string | null,
    occluder: EllipsoidalOccluder,
    width: number,
    height: number,
    now: number,
    color: string,
  ): void {
    if (key !== this.trailKey) {
      this.trail = [];
      this.trailKey = key;
      this.lastSample = 0;
    }
    if (!key) return;
    const position = this.renderer.positionOf(key);
    if (!position) return;
    if (now - this.lastSample >= TRAIL_SAMPLE_MS) {
      this.trail.push(Cartesian3.clone(position));
      if (this.trail.length > TRAIL_MAX_POINTS) this.trail.shift();
      this.lastSample = now;
    }

    const points = [...this.trail, position].map((p) => {
      const win = this.project(p, occluder, Infinity, Infinity);
      return win && { x: win.x, y: win.y };
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (!a || !b) continue;
      ctx.globalAlpha = (i / points.length) * 0.9;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    const head = this.project(position, occluder, width, height);
    if (!head) return;
    const r = 22;
    ctx.beginPath();
    ctx.arc(head.x, head.y, r, 0, Math.PI * 2);
    for (const angle of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
      ctx.moveTo(head.x + Math.cos(angle) * (r - 6), head.y + Math.sin(angle) * (r - 6));
      ctx.lineTo(head.x + Math.cos(angle) * (r + 6), head.y + Math.sin(angle) * (r + 6));
    }
    ctx.stroke();
    ctx.font = 'bold 10px ui-monospace, Menlo, monospace';
    ctx.fillStyle = color;
    ctx.fillText('TRK', head.x + r + 4, head.y - r);
  }
}
