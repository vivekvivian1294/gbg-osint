import { decodeLine, type Feature } from '@gbg-osint/shared';
import { Color, Material, type GroundPolylinePrimitive, type Scene } from 'cesium';
import { routeColor } from '../layers/markers';
import { building, drapedLines, drapedMaterialLines, type DrapedLine } from './draped';
import type { PickRef } from './markerSpec';
import { NO_TUNNELS, type TunnelMask } from './tunnels';

const WIDTH: Record<string, number> = { tram: 3.5, train: 3.5, ferry: 3, bus: 1.6 };
/** Buses are drawn under rail and ferries and fainter, so the tram network stands out. */
const DRAW_ORDER = ['bus', 'ferry', 'train', 'tram'];
/** GTFS shapes run a few metres beside the OpenStreetMap ways. */
const TUNNEL_TOLERANCE_M = 10;

/** Public transport routes from GTFS, in each line's colour when the live vehicles give one. */
export class TransitRouteLayer {
  private primitives: GroundPolylinePrimitive[] = [];

  constructor(private readonly scene: Scene) {}

  set(
    layerId: string,
    channel: string,
    features: readonly Feature[],
    lineColors: ReadonlyMap<string, string>,
    tunnels: TunnelMask = NO_TUNNELS,
  ): void {
    this.clear();
    const byMode = new Map<string, DrapedLine[]>();
    // Tunnel stretches are dashed in the line's colour; a material per colour.
    const tunnelsByColor = new Map<string, DrapedLine[]>();
    for (const f of features) {
      if (f.kind !== 'transit-route') continue;
      const coords = decodeLine(f.line);
      if (coords.length < 2) continue;
      const mode = String(f.props?.mode);
      const lines = byMode.get(mode) ?? [];
      const color = routeColor(f, lineColors);
      const id = { layerId, channel, ids: [f.id] } satisfies PickRef;
      const { surface, tunnel } = tunnels.split(coords, TUNNEL_TOLERANCE_M);
      for (const part of surface) {
        lines.push({
          coords: part,
          width: WIDTH[mode] ?? 2,
          color: Color.fromCssColorString(color).withAlpha(mode === 'bus' ? 0.55 : 0.9),
          id,
        });
      }
      if (tunnel.length > 0) {
        const dashed = tunnelsByColor.get(color) ?? [];
        for (const part of tunnel) dashed.push({ coords: part, width: 1.5, id });
        tunnelsByColor.set(color, dashed);
      }
      byMode.set(mode, lines);
    }
    for (const [color, lines] of tunnelsByColor) {
      const material = Material.fromType('PolylineDash', {
        color: Color.fromCssColorString(color).withAlpha(0.45),
        gapColor: Color.TRANSPARENT,
        dashLength: 10,
      });
      const primitive = drapedMaterialLines(lines, material);
      if (primitive) this.primitives.push(this.scene.primitives.add(primitive));
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
