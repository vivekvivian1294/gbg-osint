import { decodeLine, type Feature } from '@gbg-osint/shared';
import { Color, Material, type GroundPolylinePrimitive, type Scene } from 'cesium';
import { building, drapedMaterialLines, type DrapedLine } from './draped';
import type { PickRef } from './markerSpec';
import { LocalFrame } from './path';
import { NO_TUNNELS, type TunnelMask } from './tunnels';

const WIDTH_PX = 7;
const TUNNEL_WIDTH_PX = 3;
/** Trafikverket's lines run a few metres beside OpenStreetMap's, and tunnels have one tube per direction. */
const TUNNEL_TOLERANCE_M = 12;
/** Each direction is drawn this far to its right, so both carriageways stay visible. */
const OFFSET_M = 6;

const STATUS_COLORS: Record<string, string> = {
  freeflow: '#4ade80',
  heavy: '#fbbf24',
  congested: '#f87171',
  impossible: '#b91c1c',
};

/** Free-flow time divided by measured time: 1 at free flow, lower when slower. */
export function flowRatio(props: Feature['props']): number | undefined {
  const travel = props?.travelTimeS;
  const free = props?.freeFlowS;
  return typeof travel === 'number' && typeof free === 'number' && travel > 0
    ? Math.min(1, free / travel)
    : undefined;
}

/** Colour by Trafikverket's own status, or by speed against free flow. */
export function travelTimeColor(props: Feature['props']): string {
  const status = props?.status;
  if (typeof status === 'string' && STATUS_COLORS[status]) return STATUS_COLORS[status];
  const ratio = flowRatio(props);
  if (ratio === undefined) return '#94a3b8';
  return ratio >= 0.85
    ? '#4ade80'
    : ratio >= 0.65
      ? '#fbbf24'
      : ratio >= 0.45
        ? '#fb923c'
        : '#f87171';
}

/** The line shifted `offsetM` to the right of its direction of travel. */
export function offsetLine(
  coords: readonly (readonly [number, number])[],
  offsetM: number,
): [number, number][] {
  const first = coords[0];
  if (!first || coords.length < 2) return coords.map(([lon, lat]) => [lon, lat]);
  const frame = new LocalFrame(first[0], first[1]);
  const xy = coords.map(([lon, lat]) => frame.toXY(lon, lat));
  return xy.map(([x, y], i) => {
    const [px, py] = xy[Math.max(0, i - 1)]!;
    const [nx, ny] = xy[Math.min(xy.length - 1, i + 1)]!;
    const len = Math.hypot(nx - px, ny - py) || 1;
    return frame.toLonLat(x + ((ny - py) / len) * offsetM, y - ((nx - px) / len) * offsetM);
  });
}

/** Measured road stretches as coloured, clickable lines draped on the ground. */
export class TravelTimeLayer {
  private primitives: GroundPolylinePrimitive[] = [];

  constructor(private readonly scene: Scene) {}

  set(
    layerId: string,
    channel: string,
    features: readonly Feature[],
    tunnels: TunnelMask = NO_TUNNELS,
  ): void {
    this.clear();
    const byColor = new Map<string, { open: DrapedLine[]; tunnel: DrapedLine[] }>();
    for (const f of features) {
      if (f.kind !== 'travel-time') continue;
      const coords = decodeLine(f.line);
      if (coords.length < 2) continue;
      const color = travelTimeColor(f.props);
      const lines = byColor.get(color) ?? { open: [], tunnel: [] };
      const id = { layerId, channel, ids: [f.id] } satisfies PickRef;
      const { surface, tunnel } = tunnels.split(coords, TUNNEL_TOLERANCE_M);
      for (const part of surface) {
        lines.open.push({ coords: offsetLine(part, OFFSET_M), width: WIDTH_PX, id });
      }
      for (const part of tunnel) {
        lines.tunnel.push({ coords: offsetLine(part, OFFSET_M), width: TUNNEL_WIDTH_PX, id });
      }
      byColor.set(color, lines);
    }
    for (const [color, lines] of byColor) {
      const material = Material.fromType('PolylineOutline', {
        color: Color.fromCssColorString(color),
        outlineColor: Color.BLACK.withAlpha(0.7),
        outlineWidth: 2,
      });
      const tunnelMaterial = Material.fromType('PolylineDash', {
        color: Color.fromCssColorString(color).withAlpha(0.55),
        gapColor: Color.TRANSPARENT,
        dashLength: 12,
      });
      for (const primitive of [
        drapedMaterialLines(lines.open, material),
        drapedMaterialLines(lines.tunnel, tunnelMaterial),
      ]) {
        if (primitive) this.primitives.push(this.scene.primitives.add(primitive));
      }
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
