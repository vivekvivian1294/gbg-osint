import type { LonLat } from '@gbg-osint/shared';
import {
  Cartesian2,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  GeometryInstance,
  LabelCollection,
  LabelStyle,
  Material,
  PerInstanceColorAppearance,
  PointPrimitiveCollection,
  PolygonGeometry,
  PolygonHierarchy,
  PolylineGeometry,
  PolylineMaterialAppearance,
  Primitive,
  VerticalOrigin,
  type Scene,
} from 'cesium';

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

const positions = (points: readonly LonLat[]) =>
  Cartesian3.fromDegreesArrayHeights(points.flatMap(([lon, lat]) => [lon, lat, LIFT_M]));

/** Lines stay visible behind buildings, drawn fainter there. */
function line(points: readonly LonLat[], color: Color, width: number): Primitive {
  return new Primitive({
    geometryInstances: new GeometryInstance({
      geometry: new PolylineGeometry({
        positions: positions(points),
        width,
        vertexFormat: PolylineMaterialAppearance.VERTEX_FORMAT,
      }),
    }),
    appearance: new PolylineMaterialAppearance({ material: Material.fromType('Color', { color }) }),
    depthFailAppearance: new PolylineMaterialAppearance({
      material: Material.fromType('Color', { color: color.withAlpha(0.35) }),
    }),
    asynchronous: false,
    allowPicking: false,
  });
}

function fill(points: readonly LonLat[], color: Color): Primitive {
  return new Primitive({
    geometryInstances: new GeometryInstance({
      geometry: new PolygonGeometry({
        polygonHierarchy: new PolygonHierarchy(positions(points)),
        height: LIFT_M,
        vertexFormat: PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
      }),
      attributes: { color: ColorGeometryInstanceAttribute.fromColor(color) },
    }),
    appearance: new PerInstanceColorAppearance({ flat: true, translucent: true }),
    asynchronous: false,
    allowPicking: false,
  });
}

const northernmost = (ring: readonly LonLat[]): LonLat =>
  ring.reduce((top, p) => (p[1] > top[1] ? p : top), ring[0]!);

/** Draws measurements, pins, routes and watch areas on top of the map. */
export class ToolLayer {
  private readonly points: PointPrimitiveCollection;
  private readonly labels: LabelCollection;
  private primitives: Primitive[] = [];

  constructor(private readonly scene: Scene) {
    this.points = scene.primitives.add(new PointPrimitiveCollection());
    this.labels = scene.primitives.add(new LabelCollection({ scene }));
  }

  set(d: Drawing): void {
    this.clear();
    const point = (p: LonLat, color: Color, size: number) =>
      this.points.add({
        position: Cartesian3.fromDegrees(p[0], p[1], LIFT_M),
        color,
        pixelSize: size,
        outlineColor: Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: ON_TOP,
      });
    const label = (p: LonLat, text: string) =>
      this.labels.add({
        position: Cartesian3.fromDegrees(p[0], p[1], LIFT_M),
        text,
        font: '12px ui-monospace, Menlo, monospace',
        style: LabelStyle.FILL_AND_OUTLINE,
        outlineColor: Color.BLACK,
        outlineWidth: 3,
        pixelOffset: LABEL_OFFSET,
        verticalOrigin: VerticalOrigin.BOTTOM,
        disableDepthTestDistance: ON_TOP,
      });

    if (d.measure.length >= 3) this.add(fill(d.measure, MEASURE.withAlpha(0.15)));
    if (d.measure.length >= 2) this.add(line(d.measure, MEASURE, 3));
    d.measure.forEach((p) => point(p, MEASURE, 8));
    const last = d.measure.at(-1);
    if (last && d.measureLabel) label(last, d.measureLabel);

    for (const area of d.watchAreas) {
      this.add(fill(area.ring, WATCH.withAlpha(0.08)));
      this.add(line([...area.ring, area.ring[0]!], WATCH, 2));
      label(northernmost(area.ring), area.name);
    }
    if (d.watchDraft.length >= 3) this.add(fill(d.watchDraft, WATCH.withAlpha(0.15)));
    if (d.watchDraft.length >= 2) this.add(line(d.watchDraft, WATCH, 3));
    d.watchDraft.forEach((p) => point(p, WATCH, 8));

    d.pins.forEach((p, i) => {
      point(p, PIN, 12);
      label(p, `P${i + 1}`);
    });

    if (d.routeLine.length >= 2) this.add(line(d.routeLine, ROUTE, 5));
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

  private add(p: Primitive): void {
    this.primitives.push(this.scene.primitives.add(p));
  }
}
