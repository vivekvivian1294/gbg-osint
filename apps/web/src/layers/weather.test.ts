import type { ChannelItem, Entity } from '@gbg-osint/shared';
import { describe, expect, it } from 'vitest';
import { formatMetric } from '../components/MetricsStrip';
import { bathingColor } from './markers';
import { buildWindField, compass, windAt, windVector } from './wind';

const TS = '2026-10-29T11:00:00.000Z';
const point = (lon: number, lat: number, windMs: number, windFromDeg: number): ChannelItem => ({
  id: `w-${lon}-${lat}`,
  source: 'open-meteo',
  kind: 'sensor',
  lon,
  lat,
  ts: TS,
  props: { windMs, windFromDeg, gustMs: windMs * 1.5 },
});

describe('wind field', () => {
  const field = buildWindField([
    point(11.8, 57.6, 10, 270),
    point(12.0, 57.6, 10, 270),
    point(11.8, 57.8, 4, 180),
    point(12.0, 57.8, 4, 180),
  ])!;

  it('turns "from" directions into vectors that point downwind', () => {
    const west = windVector(field, 11.8, 57.6)!;
    expect(west.u).toBeCloseTo(10);
    expect(west.v).toBeCloseTo(0);
    const south = windVector(field, 11.8, 57.8)!;
    expect(south.u).toBeCloseTo(0);
    expect(south.v).toBeCloseTo(4);
  });

  it('interpolates between grid points and is undefined outside the grid', () => {
    const mid = windAt(field, 11.9, 57.7)!;
    expect(mid.speed).toBeCloseTo(Math.hypot(5, 2));
    expect(mid.fromDeg).toBeCloseTo(248.2, 1);
    expect(mid.gust).toBeCloseTo(10.5);
    expect(windAt(field, 12.1, 57.7)).toBeUndefined();
    expect(buildWindField([point(11.8, 57.6, 5, 0)])).toBeNull();
  });

  it('names compass points', () => {
    expect([0, 22.5, 90, 248, 270, 350, -10, 359].map(compass)).toEqual([
      'N',
      'NNE',
      'E',
      'WSW',
      'W',
      'N',
      'N',
      'N',
    ]);
  });
});

describe('seasonal layers', () => {
  const site = (props: Record<string, unknown>): Entity => ({
    id: 's',
    source: 'havochvatten',
    kind: 'poi',
    lon: 11.7,
    lat: 57.7,
    ts: TS,
    props,
  });

  it('colours bathing sites by advice and latest sample', () => {
    expect(bathingColor(site({ lastSample: 'Fit for bathing' }))).toBe('#38bdf8');
    expect(bathingColor(site({ lastSample: 'Fit, with remarks' }))).toBe('#fbbf24');
    expect(bathingColor(site({ lastSample: 'Unfit for bathing' }))).toBe('#f87171');
    expect(
      bathingColor(site({ lastSample: 'Fit for bathing', adviceAgainstBathing: 'Poor quality' })),
    ).toBe('#f87171');
    expect(bathingColor(site({}))).toBe('#94a3b8');
  });

  it('shows pollen levels as words', () => {
    expect(formatMetric({ unit: 'level', value: 0 })).toBe('None');
    expect(formatMetric({ unit: 'level', value: 5 })).toBe('High');
    expect(formatMetric({ unit: 'level', value: 7 })).toBe('Very high');
  });
});
