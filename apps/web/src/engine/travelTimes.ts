import { decodeLine, type Feature } from '@gbg-osint/shared';
import { Cartesian3, Color, Material, PolylineCollection, type Scene } from 'cesium';
import type { PickRef } from './markerSpec';
import { LocalFrame } from './path';

const HEIGHT_M = 4;
const WIDTH_PX = 7;
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

/** Measured road stretches as coloured, clickable lines. */
export class TravelTimeLayer {
  private readonly lines: PolylineCollection;

  constructor(private readonly scene: Scene) {
    this.lines = scene.primitives.add(new PolylineCollection());
  }

  set(layerId: string, channel: string, features: readonly Feature[]): void {
    this.lines.removeAll();
    for (const f of features) {
      if (f.kind !== 'travel-time') continue;
      const coords = decodeLine(f.line);
      if (coords.length < 2) continue;
      const pick: PickRef = { layerId, channel, ids: [f.id] };
      this.lines.add({
        positions: offsetLine(coords, OFFSET_M).map(([lon, lat]) =>
          Cartesian3.fromDegrees(lon, lat, HEIGHT_M),
        ),
        width: WIDTH_PX,
        material: Material.fromType('PolylineOutline', {
          color: Color.fromCssColorString(travelTimeColor(f.props)),
          outlineColor: Color.BLACK.withAlpha(0.7),
          outlineWidth: 2,
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
