import type { GeoEvent, Severity } from '@gbg-osint/shared';
import { describe, expect, it } from 'vitest';
import {
  categoryCounts,
  eventInView,
  filterEvents,
  isFiltering,
  NO_FILTER,
  type FeedContext,
} from './feedFilter';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const HOUR = 3_600_000;

function event(
  id: string,
  opts: {
    category?: string;
    severity?: Severity;
    hoursAgo?: number;
    at?: [number, number] | null;
    precision?: GeoEvent['locationPrecision'];
  } = {},
): GeoEvent {
  const at = opts.at === undefined ? [11.97, 57.7] : opts.at;
  return {
    id,
    source: 'test',
    category: opts.category ?? 'Olycka',
    severity: opts.severity ?? 'minor',
    title: id,
    locationPrecision: opts.precision ?? (at ? 'exact' : 'none'),
    start: new Date(NOW - (opts.hoursAgo ?? 0.5) * HOUR).toISOString(),
    ...(at && { geometry: { type: 'Point', coordinates: at } }),
  };
}

const CENTRAL = { west: 11.9, south: 57.65, east: 12.05, north: 57.75 };
const ctx: FeedContext = { now: NOW, view: CENTRAL, watchAreas: [] };
const ids = (events: GeoEvent[]) => events.map((e) => e.id);

describe('feed filters', () => {
  it('lets everything through without filters', () => {
    const events = [event('a'), event('b', { at: null })];
    expect(isFiltering(NO_FILTER)).toBe(false);
    expect(filterEvents(events, NO_FILTER, ctx)).toEqual(events);
  });

  it('filters by category and minimum severity', () => {
    const events = [
      event('crash', { severity: 'major' }),
      event('works', { category: 'Vägarbete', severity: 'major' }),
      event('minor'),
      event('critical', { severity: 'critical' }),
    ];
    expect(ids(filterEvents(events, { ...NO_FILTER, category: 'Olycka' }, ctx))).toEqual([
      'crash',
      'minor',
      'critical',
    ]);
    expect(ids(filterEvents(events, { ...NO_FILTER, minSeverity: 'major' }, ctx))).toEqual([
      'crash',
      'works',
      'critical',
    ]);
  });

  it('keeps events that started within the window, not planned ones', () => {
    const events = [
      event('recent'),
      event('earlier', { hoursAgo: 5 }),
      event('yesterday', { hoursAgo: 30 }),
      event('planned', { hoursAgo: -48 }),
    ];
    expect(ids(filterEvents(events, { ...NO_FILTER, window: '1h' }, ctx))).toEqual(['recent']);
    expect(ids(filterEvents(events, { ...NO_FILTER, window: '6h' }, ctx))).toEqual([
      'recent',
      'earlier',
    ]);
    expect(ids(filterEvents(events, NO_FILTER, ctx))).toHaveLength(4);
  });

  it('keeps events whose place overlaps the view', () => {
    const region: GeoEvent = {
      ...event('county warning', { precision: 'region' }),
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [11, 57],
            [13, 57],
            [13, 59],
            [11, 59],
            [11, 57],
          ],
        ],
      },
    };
    const events = [
      event('here'),
      event('kungalv', { at: [11.98, 57.87] }),
      event('news', { at: null }),
      region,
    ];
    expect(ids(filterEvents(events, { ...NO_FILTER, inView: true }, ctx))).toEqual([
      'here',
      'county warning',
    ]);
    // Without a known view (e.g. looking at the sky) nothing is hidden.
    expect(
      filterEvents(events, { ...NO_FILTER, inView: true }, { ...ctx, view: null }),
    ).toHaveLength(4);
  });

  it('handles a view across the antimeridian', () => {
    const wrapped = { west: 170, south: -10, east: -170, north: 10 };
    expect(eventInView(event('east', { at: [175, 0] }), wrapped)).toBe(true);
    expect(eventInView(event('west', { at: [-175, 0] }), wrapped)).toBe(true);
    expect(eventInView(event('far', { at: [0, 0] }), wrapped)).toBe(false);
  });

  it('keeps precisely placed events inside a watch area', () => {
    const area = {
      id: 'w1',
      name: 'Centralen',
      ring: [
        [11.96, 57.7],
        [11.98, 57.7],
        [11.98, 57.71],
        [11.96, 57.71],
      ] as [number, number][],
    };
    const events = [
      event('inside', { at: [11.97, 57.705] }),
      event('outside', { at: [11.9, 57.7] }),
      event('police', { at: [11.97, 57.705], precision: 'municipality' }),
    ];
    expect(
      ids(filterEvents(events, { ...NO_FILTER, inWatch: true }, { ...ctx, watchAreas: [area] })),
    ).toEqual(['inside']);
  });

  it('counts categories, most common first', () => {
    const events = [event('a'), event('b', { category: 'Brand' }), event('c')];
    expect(categoryCounts(events)).toEqual([
      ['Olycka', 2],
      ['Brand', 1],
    ]);
  });
});
