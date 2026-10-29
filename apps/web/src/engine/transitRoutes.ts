import { decodeLine, type Feature } from '@gbg-osint/shared';
import { Cartesian3, Color, Material, PolylineCollection, type Scene } from 'cesium';
import { routeColor } from '../layers/markers';
import type { PickRef } from './markerSpec';

const HEIGHT_M = 3;
const WIDTH: Record<string, number> = { tram: 3.5, train: 3.5, ferry: 3, bus: 1.6 };
/** Buses are drawn under rail and ferries and fainter, so the tram network stands out. */
const DRAW_ORDER = ['bus', 'ferry', 'train', 'tram'];

/** Public transport routes from GTFS, in each line's colour when the live vehicles give one. */
export class TransitRouteLayer {
  private readonly lines: PolylineCollection;

  constructor(private readonly scene: Scene) {
    this.lines = scene.primitives.add(new PolylineCollection());
  }

  set(
    layerId: string,
    channel: string,
    features: readonly Feature[],
    lineColors: ReadonlyMap<string, string>,
  ): void {
    this.lines.removeAll();
    const rank = (f: Feature) => DRAW_ORDER.indexOf(String(f.props?.mode));
    for (const f of [...features].sort((a, b) => rank(a) - rank(b))) {
      if (f.kind !== 'transit-route') continue;
      const coords = decodeLine(f.line);
      if (coords.length < 2) continue;
      const mode = String(f.props?.mode);
      const pick: PickRef = { layerId, channel, ids: [f.id] };
      this.lines.add({
        positions: coords.map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat, HEIGHT_M)),
        width: WIDTH[mode] ?? 2,
        material: Material.fromType('Color', {
          color: Color.fromCssColorString(routeColor(f, lineColors)).withAlpha(
            mode === 'bus' ? 0.55 : 0.9,
          ),
        }),
        id: pick,
      });
    }
    this.scene.requestRender();
  }

  clear(): void {
    this.lines.removeAll();
    this.scene.requestRender();
  }

  destroy(): void {
    if (!this.scene.isDestroyed()) this.scene.primitives.remove(this.lines);
  }
}
