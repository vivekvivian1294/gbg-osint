import { encodeLine, type Area, type LonLat } from '@gbg-osint/shared';
import { describe, expect, it } from 'vitest';
import { routePath } from '../state/tools';
import {
  classifyDistricts,
  classOf,
  DISTRICT_METRICS,
  DISTRICT_PALETTE,
  metricById,
  quantileBreaks,
} from './districts';
import {
  distanceM,
  formatArea,
  formatDistance,
  formatDuration,
  pathLengthM,
  polygonAreaM2,
} from './measure';
import { LAYERS, LOCAL_CHANNELS } from './registry';

const ring: LonLat[] = [
  [11.95, 57.7],
  [11.96, 57.7],
  [11.96, 57.71],
  [11.95, 57.7],
];
const area = (id: string, props: Record<string, unknown>): Area => ({
  id,
  source: 'scb',
  label: id,
  polygons: [[encodeLine(ring)]],
  ts: '2026-10-27T12:00:00.000Z',
  props,
});

describe('district choropleth', () => {
  it('splits values into equal-count classes', () => {
    const values = Array.from({ length: 100 }, (_, i) => i);
    expect(quantileBreaks(values)).toEqual([20, 40, 60, 80]);
    expect(classOf(5, [20, 40, 60, 80])).toBe(0);
    expect(classOf(40, [20, 40, 60, 80])).toBe(2);
    expect(classOf(99, [20, 40, 60, 80])).toBe(4);
    expect(quantileBreaks([7, 7, 7, 7])).toEqual([7]);
    expect(quantileBreaks([])).toEqual([]);
  });

  it('colours districts by the chosen statistic and greys out missing values', () => {
    const areas = [
      ...Array.from({ length: 10 }, (_, i) =>
        area(`1480R00${i}`, { densityPerKm2: (i + 1) * 1000, populationYear: 2025 }),
      ),
      area('1480R099', { population: 10 }),
    ];
    const classes = classifyDistricts(areas, 'density');
    expect(classes.metric.id).toBe('density');
    expect(classes.year).toBe(2025);
    expect(classes.breaks).toEqual([3000, 5000, 7000, 9000]);
    expect(classes.shapes[0]!.color).toBe(DISTRICT_PALETTE[0]);
    expect(classes.shapes[9]!.color).toBe(DISTRICT_PALETTE[4]);
    expect(classes.shapes[10]!.color).toBeNull();
    expect(classes.shapes[0]!.polygons[0]![0]).toEqual(ring);
  });

  it('defines every statistic with a formatter and falls back to the first', () => {
    for (const m of DISTRICT_METRICS) expect(m.format(1234.5)).toMatch(/\d/);
    expect(metricById('nope').id).toBe(DISTRICT_METRICS[0]!.id);
    expect(metricById('income').format(382.4)).toBe('382 tkr');
  });
});

describe('measuring', () => {
  it('measures distances and areas on the ground', () => {
    const oneKmNorth: LonLat = [11.97, 57.7 + 1000 / 111_195];
    expect(distanceM([11.97, 57.7], oneKmNorth)).toBeCloseTo(1000, 0);
    const square: LonLat[] = [
      [11.97, 57.7],
      [11.97 + 0.01, 57.7],
      [11.97 + 0.01, 57.71],
      [11.97, 57.71],
    ];
    const side = pathLengthM(square.slice(0, 2));
    const height = pathLengthM(square.slice(1, 3));
    expect(polygonAreaM2(square) / (side * height)).toBeCloseTo(1, 2);
    expect(polygonAreaM2(square.slice(0, 2))).toBe(0);
  });

  it('formats lengths, areas and travel times', () => {
    expect(formatDistance(850)).toBe('850 m');
    expect(formatDistance(2263)).toBe('2,26 km');
    expect(formatDistance(15_400)).toBe('15,4 km');
    expect(formatArea(5_000)).toMatch(/^5\s000 m²$/);
    expect(formatArea(640_000)).toBe('0,64 km²');
    expect(formatDuration(20)).toBe('1 min');
    expect(formatDuration(5400)).toBe('1 h 30 min');
  });

  it('asks the routing endpoint with rounded coordinates', () => {
    expect(
      routePath('bike', [
        [11.974612345, 57.70891],
        [11.99, 57.695],
      ]),
    ).toBe('/api/data/osrm.routes/route/bike/11.97461/57.70891/11.99000/57.69500.json');
  });
});

describe('Phase 5 layers', () => {
  it('registers the new layers with sources and notes for derived figures', () => {
    const byId = new Map(LAYERS.map((l) => [l.id, l]));
    expect(byId.get('districts')?.channels).toEqual(['context.districts']);
    expect(byId.get('energy-mix')?.sourceIds).toEqual(['energycharts.se']);
    expect(byId.get('gnss')?.note).toMatch(/not proof of jamming/);
    expect(byId.get('social')?.channels).toEqual(['events.social']);
    for (const channel of LOCAL_CHANNELS.keys()) {
      expect(LAYERS.some((l) => l.channels.includes(channel))).toBe(true);
    }
  });
});
