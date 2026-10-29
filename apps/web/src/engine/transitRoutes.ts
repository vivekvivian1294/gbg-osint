import { decodeLine, type Feature } from '@gbg-osint/shared';
import { Color, type GroundPolylinePrimitive, type Scene } from 'cesium';
import { routeColor } from '../layers/markers';
import { building, drapedLines, type DrapedLine } from './draped';
import type { PickRef } from './markerSpec';

const WIDTH: Record<string, number> = { tram: 3.5, train: 3.5, ferry: 3, bus: 1.6 };
/** Buses are drawn under rail and ferries and fainter, so the tram network stands out. */
const DRAW_ORDER = ['bus', 'ferry', 'train', 'tram'];

/** Public transport routes from GTFS, in each line's colour when the live vehicles give one. */
export class TransitRouteLayer {
  private primitives: GroundPolylinePrimitive[] = [];

  constructor(private readonly scene: Scene) {}

  set(
    layerId: string,
    channel: string,
    features: readonly Feature[],
    lineColors: ReadonlyMap<string, string>,
  ): void {
    this.clear();
    const byMode = new Map<string, DrapedLine[]>();
    for (const f of features) {
      if (f.kind !== 'transit-route') continue;
      const coords = decodeLine(f.line);
      if (coords.length < 2) continue;
      const mode = String(f.props?.mode);
      const lines = byMode.get(mode) ?? [];
      lines.push({
        coords,
        width: WIDTH[mode] ?? 2,
        color: Color.fromCssColorString(routeColor(f, lineColors)).withAlpha(
          mode === 'bus' ? 0.55 : 0.9,
        ),
        id: { layerId, channel, ids: [f.id] } satisfies PickRef,
      });
      byMode.set(mode, lines);
    }
    // Later primitives draw on top, so trams end up above buses.
    const rank = (mode: string) => DRAW_ORDER.indexOf(mode);
    for (const [, lines] of [...byMode].sort((a, b) => rank(a[0]) - rank(b[0]))) {
      const primitive = drapedLines(lines);
      if (primitive) this.primitives.push(this.scene.primitives.add(primitive));
    }
    this.scene.requestRender();
  }

  /** True while the lines are still being built. */
  update(): boolean {
    return building(...this.primitives);
  }

  clear(): void {
    if (!this.scene.isDestroyed()) {
      for (const p of this.primitives) this.scene.primitives.remove(p);
      this.scene.requestRender();
    }
    this.primitives = [];
  }

  destroy(): void {
    this.clear();
  }
}
