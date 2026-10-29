import type { LonLat } from '@gbg-osint/shared';
import {
  Cartesian2,
  Cartesian3,
  Color,
  LabelCollection,
  LabelStyle,
  PointPrimitiveCollection,
  VerticalOrigin,
  type GroundPolylinePrimitive,
  type GroundPrimitive,
  type Scene,
} from 'cesium';
import { drapedAreas, drapedLines } from './draped';
import type { Ground } from './terrain';

/** What the measure, pin, route and watch tools have drawn, plus the "What's here?" point. */
export interface Drawing {
  measure: readonly LonLat[];
  measureLabel: string;
  pins: readonly LonLat[];
  routeEnds: readonly LonLat[];
  routeLine: readonly LonLat[];
  watchDraft: readonly LonLat[];
  watchAreas: readonly { name: string; ring: readonly LonLat[] }[];
  spot?: LonLat;
}

const LIFT_M = 1.5;
const MEASURE = Color.fromCssColorString('#fbbf24');
const ROUTE = Color.fromCssColorString('#f472b6');
const PIN = Color.fromCssColorString('#38bdf8');
const WATCH = Color.fromCssColorString('#f87171');
const SPOT = Color.fromCssColorString('#ffffff');
const ON_TOP = Number.POSITIVE_INFINITY;
const LABEL_OFFSET = new Cartesian2(0, -14);

const northernmost = (ring: readonly LonLat[]): LonLat =>
  ring.reduce((top, p) => (p[1] > top[1] ? p : top), ring[0]!);

/** Draws measurements, pins, routes and watch areas on the ground. */
export class ToolLayer {
  private readonly points: PointPrimitiveCollection;
  private readonly labels: LabelCollection;
  private primitives: (GroundPrimitive | GroundPolylinePrimitive)[] = [];
  private last: Drawing | undefined;

  constructor(
    private readonly scene: Scene,
    private readonly ground?: Ground,
  ) {
    this.points = scene.primitives.add(new PointPrimitiveCollection());
    this.labels = scene.primitives.add(new LabelCollection({ scene }));
  }

  /** Re-places the points after terrain was switched or refined. */
  refreshHeights(): void {
    if (this.last) this.set(this.last);
  }

  set(d: Drawing): void {
    this.clear();
    this.last = d;
    const at = ([lon, lat]: LonLat) =>
      Cartesian3.fromDegrees(lon, lat, (this.ground?.surface(lon, lat) ?? 0) + LIFT_M);
    const point = (p: LonLat, color: Color, size: number) =>
      this.points.add({
        position: at(p),
        color,
        pixelSize: size,
        outlineColor: Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: ON_TOP,
      });
    const label = (p: LonLat, text: string) =>
      this.labels.add({
        position: at(p),
        text,
        font: '12px ui-monospace, Menlo, monospace',
        style: LabelStyle.FILL_AND_OUTLINE,
        outlineColor: Color.BLACK,
        outlineWidth: 3,
        pixelOffset: LABEL_OFFSET,
        verticalOrigin: VerticalOrigin.BOTTOM,
        disableDepthTestDistance: ON_TOP,
      });
    const fill = (ring: readonly LonLat[], color: Color) =>
      this.add(drapedAreas([{ rings: [ring], color }], false));
    const line = (coords: readonly LonLat[], color: Color, width: number, loop = false) =>
      this.add(drapedLines([{ coords, color, width, loop }], false));

    if (d.measure.length >= 3) fill(d.measure, MEASURE.withAlpha(0.15));
    if (d.measure.length >= 2) line(d.measure, MEASURE, 3);
    d.measure.forEach((p) => point(p, MEASURE, 8));
    const last = d.measure.at(-1);
    if (last && d.measureLabel) label(last, d.measureLabel);

    for (const area of d.watchAreas) {
      fill(area.ring, WATCH.withAlpha(0.08));
      line(area.ring, WATCH, 2, true);
      label(northernmost(area.ring), area.name);
    }
    if (d.watchDraft.length >= 3) fill(d.watchDraft, WATCH.withAlpha(0.15));
    if (d.watchDraft.length >= 2) line(d.watchDraft, WATCH, 3);
    d.watchDraft.forEach((p) => point(p, WATCH, 8));

    d.pins.forEach((p, i) => {
      point(p, PIN, 12);
      label(p, `P${i + 1}`);
    });

    if (d.routeLine.length >= 2) line(d.routeLine, ROUTE, 5);
    d.routeEnds.forEach((p, i) => {
      point(p, ROUTE, 12);
      label(p, i === 0 ? 'A' : 'B');
    });
    if (d.spot) {
      point(d.spot, SPOT, 14);
      label(d.spot, "What's here?");
    }
    this.scene.requestRender();
  }

  clear(): void {
    if (this.scene.isDestroyed()) return;
    for (const p of this.primitives) this.scene.primitives.remove(p);
    this.primitives = [];
    this.points.removeAll();
    this.labels.removeAll();
  }

  destroy(): void {
    this.clear();
    if (this.scene.isDestroyed()) return;
    this.scene.primitives.remove(this.points);
    this.scene.primitives.remove(this.labels);
  }

  private add(p: GroundPrimitive | GroundPolylinePrimitive | undefined): void {
    if (p) this.primitives.push(this.scene.primitives.add(p));
  }
}
