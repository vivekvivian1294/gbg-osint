import { Color, type GroundPolylinePrimitive, type GroundPrimitive, type Scene } from 'cesium';
import type { DistrictShape } from '../layers/districts';
import { building, drapedAreas, drapedLines, type DrapedArea, type DrapedLine } from './draped';
import type { PickRef } from './markerSpec';

const FILL_ALPHA = 0.55;
const NO_DATA = Color.fromCssColorString('#64748b').withAlpha(0.25);
const EDGE = Color.WHITE.withAlpha(0.35);
const EDGE_WIDTH = 1.5;

/** Choropleth of statistical districts; clicking a district selects it. */
export class DistrictLayer {
  private fill: GroundPrimitive | undefined;
  private edge: GroundPolylinePrimitive | undefined;
  private key = '';

  constructor(private readonly scene: Scene) {}

  set(key: string, shapes: readonly DistrictShape[], pickOf: (id: string) => PickRef): void {
    if (key === this.key) return;
    this.clear();
    this.key = key;
    const fills: DrapedArea[] = [];
    const edges: DrapedLine[] = [];
    for (const shape of shapes) {
      const color = shape.color
        ? Color.fromCssColorString(shape.color).withAlpha(FILL_ALPHA)
        : NO_DATA;
      for (const rings of shape.polygons) {
        fills.push({ rings, color, id: pickOf(shape.id) });
        for (const ring of rings) {
          edges.push({ coords: ring, width: EDGE_WIDTH, color: EDGE, loop: true });
        }
      }
    }
    const fill = drapedAreas(fills);
    if (!fill) return;
    this.fill = this.scene.primitives.add(fill);
    const edge = drapedLines(edges, false);
    if (edge) this.edge = this.scene.primitives.add(edge);
    this.scene.requestRender();
  }

  /** True while the geometry is still being built. */
  update(): boolean {
    return building(this.fill, this.edge);
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
