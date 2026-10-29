import type { Series } from '@gbg-osint/shared';

const WIDTH = 72;
const HEIGHT = 18;
const DAY_MS = 24 * 3600_000;

/**
 * SVG polyline points for a series (x by time, y by value). The x axis covers the history
 * there is, up to 24 hours, so a freshly started server still draws a readable line.
 */
export function sparkPath(
  points: readonly (readonly [number, number])[],
  now: number,
  width = WIDTH,
  height = HEIGHT,
): string {
  if (points.length < 2) return '';
  const values = points.map((p) => p[1]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const start = Math.max(now - DAY_MS, points[0]![0]);
  const span = Math.max(1, now - start);
  return points
    .map(([t, v]) => {
      const x = Math.max(0, Math.min(width, ((t - start) / span) * width));
      const y = max === min ? height / 2 : height - 1 - ((v - min) / (max - min)) * (height - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

const fmt = (v: number) => v.toLocaleString('sv-SE', { maximumFractionDigits: 1 });

/** A small 24-hour trend line with its range in the tooltip. */
export function Sparkline({ series, now, label }: { series: Series; now: number; label: string }) {
  const path = sparkPath(series.points, now);
  if (!path) return null;
  const values = series.points.map((p) => p[1]);
  const minutes = Math.round((now - series.points[0]![0]) / 60_000);
  const span = minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
  const range = `${fmt(Math.min(...values))}–${fmt(Math.max(...values))} ${series.unit}`;
  return (
    <svg
      className="sparkline"
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={`${label}, last ${span}: ${range}`}
    >
      <title>{`Last ${span}: ${range}`}</title>
      <polyline points={path} fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
