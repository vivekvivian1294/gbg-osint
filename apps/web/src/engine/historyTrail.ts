import type { Track } from '@gbg-osint/shared';
import { Cartesian3, Color, Material, PolylineCollection, type Scene } from 'cesium';

/** Longer gaps than this (out of coverage, server restart) break the line instead of bridging it. */
const MAX_GAP_MS = 30 * 60_000;
const MIN_HEIGHT_M = 3;
const WIDTH_PX = 3;
const COLOR = '#5eead4';

/** Track points split into continuous runs of at least two points. */
export function trailSegments(
  points: Track['points'],
  maxGapMs = MAX_GAP_MS,
): Track['points'][number][][] {
  const runs: Track['points'][number][][] = [];
  let run: Track['points'][number][] = [];
  for (const p of points) {
    const last = run[run.length - 1];
    if (last && p[0] - last[0] > maxGapMs) {
      if (run.length >= 2) runs.push(run);
      run = [];
    }
    run.push(p);
  }
  if (run.length >= 2) runs.push(run);
  return runs;
}

/** Where the selected or tracked ship, aircraft or train has been in the last 24 hours. */
export class HistoryTrailLayer {
  private readonly lines: PolylineCollection;

  constructor(private readonly scene: Scene) {
    this.lines = scene.primitives.add(new PolylineCollection());
  }

  set(track: Track): void {
    this.lines.removeAll();
    const material = Material.fromType('PolylineDash', {
      color: Color.fromCssColorString(COLOR).withAlpha(0.85),
      gapColor: Color.TRANSPARENT,
      dashLength: 14,
    });
    for (const run of trailSegments(track.points)) {
      this.lines.add({
        positions: run.map(([, lon, lat, alt]) =>
          Cartesian3.fromDegrees(lon, lat, Math.max(alt, MIN_HEIGHT_M)),
        ),
        width: WIDTH_PX,
        material,
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
