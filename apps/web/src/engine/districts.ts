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
import type { DistrictShape } from '../layers/districts';
import type { PickRef } from './markerSpec';

const FILL_ALPHA = 0.55;
const NO_DATA = Color.fromCssColorString('#64748b').withAlpha(0.25);
const EDGE = Color.WHITE.withAlpha(0.35);

const hierarchy = (rings: readonly (readonly [number, number])[][]) => {
  const [outer, ...holes] = rings.map((r) => Cartesian3.fromDegreesArray(r.flat()));
  return new PolygonHierarchy(
    outer!,
    holes.map((h) => new PolygonHierarchy(h)),
  );
};

/** Choropleth of statistical districts; clicking a district selects it. */
export class DistrictLayer {
  private fill: Primitive | undefined;
  private edge: Primitive | undefined;
  private key = '';

  constructor(private readonly scene: Scene) {}

  set(key: string, shapes: readonly DistrictShape[], pickOf: (id: string) => PickRef): void {
    if (key === this.key) return;
    this.clear();
    this.key = key;
    const fills: GeometryInstance[] = [];
    const edges: GeometryInstance[] = [];
    for (const shape of shapes) {
      const color = ColorGeometryInstanceAttribute.fromColor(
        shape.color ? Color.fromCssColorString(shape.color).withAlpha(FILL_ALPHA) : NO_DATA,
      );
      for (const rings of shape.polygons) {
        const polygonHierarchy = hierarchy(rings);
        fills.push(
          new GeometryInstance({
            id: pickOf(shape.id),
            geometry: new PolygonGeometry({
              polygonHierarchy,
              vertexFormat: PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
            }),
            attributes: { color },
          }),
        );
        edges.push(
          new GeometryInstance({
            geometry: new PolygonOutlineGeometry({ polygonHierarchy }),
            attributes: { color: ColorGeometryInstanceAttribute.fromColor(EDGE) },
          }),
        );
      }
    }
    if (fills.length === 0) return;
    const appearance = () => new PerInstanceColorAppearance({ flat: true, translucent: true });
    this.fill = this.scene.primitives.add(
      new Primitive({ geometryInstances: fills, appearance: appearance(), asynchronous: true }),
    );
    this.edge = this.scene.primitives.add(
      new Primitive({
        geometryInstances: edges,
        appearance: appearance(),
        asynchronous: true,
        allowPicking: false,
      }),
    );
    this.scene.requestRender();
  }

  /** True while the geometry is still being built. */
  update(): boolean {
    return Boolean((this.fill && !this.fill.ready) || (this.edge && !this.edge.ready));
  }

  clear(): void {
    if (!this.scene.isDestroyed()) {
      if (this.fill) this.scene.primitives.remove(this.fill);
      if (this.edge) this.scene.primitives.remove(this.edge);
      this.scene.requestRender();
    }
    this.fill = undefined;
    this.edge = undefined;
    this.key = '';
  }
}
