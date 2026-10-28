import {
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  GeometryInstance,
  PerInstanceColorAppearance,
  PolygonGeometry,
  PolygonHierarchy,
  PolygonOutlineGeometry,
  Primitive,
  type Scene,
} from 'cesium';

/** Assumed coverage: the published direction ± half the field of view, out to a typical range. */
export const VIEW_HALF_ANGLE_DEG = 30;
export const VIEW_RANGE_M = 150;
const ARC_STEPS = 10;
const MAX_CAMERA_HEIGHT_M = 8_000;
const FILL = Color.fromCssColorString('#5eead4').withAlpha(0.2);
const EDGE = Color.fromCssColorString('#5eead4').withAlpha(0.7);

export interface ViewCamera {
  id: string;
  lon: number;
  lat: number;
  heading: number;
}

/** Wedge outline `[lon, lat, …]`: the camera, then an arc around its viewing direction. */
export function viewWedge(
  c: ViewCamera,
  halfAngle = VIEW_HALF_ANGLE_DEG,
  range = VIEW_RANGE_M,
): number[] {
  const mPerDegLat = 111_320;
  const mPerDegLon = mPerDegLat * Math.cos((c.lat * Math.PI) / 180);
  const points = [c.lon, c.lat];
  for (let i = 0; i <= ARC_STEPS; i++) {
    const bearing = ((c.heading - halfAngle + (2 * halfAngle * i) / ARC_STEPS) * Math.PI) / 180;
    points.push(
      c.lon + (range * Math.sin(bearing)) / mPerDegLon,
      c.lat + (range * Math.cos(bearing)) / mPerDegLat,
    );
  }
  return points;
}

/** Estimated viewing areas of road cameras, drawn as translucent wedges on the ground. */
export class ViewshedLayer {
  private fill: Primitive | undefined;
  private edge: Primitive | undefined;
  private key = '';

  constructor(private readonly scene: Scene) {}

  set(cameras: readonly ViewCamera[]): void {
    const key = cameras.map((c) => `${c.id}:${c.heading}`).join('|');
    if (key === this.key) return;
    this.clear();
    this.key = key;
    if (cameras.length === 0) return;
    const hierarchies = cameras.map(
      (c) => new PolygonHierarchy(Cartesian3.fromDegreesArray(viewWedge(c))),
    );
    this.fill = this.scene.primitives.add(
      new Primitive({
        geometryInstances: hierarchies.map(
          (polygonHierarchy) =>
            new GeometryInstance({
              geometry: new PolygonGeometry({
                polygonHierarchy,
                vertexFormat: PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
              }),
              attributes: { color: ColorGeometryInstanceAttribute.fromColor(FILL) },
            }),
        ),
        appearance: new PerInstanceColorAppearance({ flat: true, translucent: true }),
        allowPicking: false,
        asynchronous: false,
      }),
    );
    this.edge = this.scene.primitives.add(
      new Primitive({
        geometryInstances: hierarchies.map(
          (polygonHierarchy) =>
            new GeometryInstance({
              geometry: new PolygonOutlineGeometry({ polygonHierarchy }),
              attributes: { color: ColorGeometryInstanceAttribute.fromColor(EDGE) },
            }),
        ),
        appearance: new PerInstanceColorAppearance({ flat: true, translucent: true }),
        allowPicking: false,
        asynchronous: false,
      }),
    );
    this.update();
  }

  /** Hides the wedges when zoomed far out; call when the camera settles. */
  update(): void {
    const show = this.scene.camera.positionCartographic.height < MAX_CAMERA_HEIGHT_M;
    if (this.fill) this.fill.show = show;
    if (this.edge) this.edge.show = show;
    this.scene.requestRender();
  }

  clear(): void {
    if (!this.scene.isDestroyed()) {
      if (this.fill) this.scene.primitives.remove(this.fill);
      if (this.edge) this.scene.primitives.remove(this.edge);
    }
    this.fill = undefined;
    this.edge = undefined;
    this.key = '';
  }
}
