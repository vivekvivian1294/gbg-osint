import type { ChannelItem, LonLat } from '@gbg-osint/shared';
import { describe, expect, it } from 'vitest';
import { itemsInside, Watcher, watchChannels, type WatchArea } from './watch';

const TS = '2026-10-23T10:00:00.000Z';
const T0 = Date.parse(TS);
const MIN = 60_000;
const area: WatchArea = {
  id: 'w1',
  name: 'Harbour mouth',
  ring: [
    [11.8, 57.68],
    [11.9, 57.68],
    [11.9, 57.72],
    [11.8, 57.72],
  ],
};
const INSIDE: LonLat = [11.85, 57.7];
const OUTSIDE: LonLat = [11.95, 57.7];

const ship = (id: string, [lon, lat]: LonLat): ChannelItem => ({
  id,
  source: 'aisstream',
  kind: 'ship',
  lon,
  lat,
  label: `Ship ${id}`,
  ts: TS,
});
const event = (id: string, at: LonLat, precision = 'exact'): ChannelItem => ({
  id,
  source: 'test',
  category: 'Test',
  severity: 'major',
  title: `Incident ${id}`,
  geometry: { type: 'Point', coordinates: at },
  locationPrecision: precision as 'exact',
  start: TS,
});

describe('watch areas', () => {
  it('only watches placed events, ships and trains', () => {
    const available = new Map([
      ['events.road', 'events'],
      ['events.police', 'events'],
      ['events.news', 'events'],
      ['maritime.ships', 'entities'],
      ['transit.vehicles', 'entities'],
      ['transit.rail', 'entities'],
      ['env.weather', 'metrics'],
    ]);
    expect(watchChannels(available)).toEqual(['events.road', 'maritime.ships', 'transit.rail']);
  });

  it('finds precise events and named ships inside, never anonymised craft', () => {
    const hits = itemsInside(area, [
      event('e1', INSIDE),
      event('e2', OUTSIDE),
      event('e3', INSIDE, 'municipality'),
      ship('265000001', INSIDE),
      ship('anon-abc', INSIDE),
    ]);
    expect([...hits.keys()]).toEqual(['e1', '265000001']);
    expect(hits.get('265000001')).toEqual({ text: 'Ship Ship 265000001 entered', at: INSIDE });
  });

  it('alerts on what enters after the first look, once per 30 minutes', () => {
    const watcher = new Watcher();
    const ships = (pos: Record<string, LonLat>) => [
      { channel: 'maritime.ships', items: Object.entries(pos).map(([id, p]) => ship(id, p)) },
    ];

    expect(watcher.update([area], ships({ a: INSIDE, b: OUTSIDE }), T0)).toEqual([]);
    const entered = watcher.update([area], ships({ a: INSIDE, b: INSIDE }), T0 + MIN);
    expect(entered).toMatchObject([
      { areaId: 'w1', areaName: 'Harbour mouth', channel: 'maritime.ships', itemId: 'b' },
    ]);
    expect(watcher.update([area], ships({ a: INSIDE, b: INSIDE }), T0 + 2 * MIN)).toEqual([]);

    watcher.update([area], ships({ a: INSIDE, b: OUTSIDE }), T0 + 3 * MIN);
    expect(watcher.update([area], ships({ a: INSIDE, b: INSIDE }), T0 + 4 * MIN)).toEqual([]);
    watcher.update([area], ships({ a: INSIDE, b: OUTSIDE }), T0 + 40 * MIN);
    expect(watcher.update([area], ships({ a: INSIDE, b: INSIDE }), T0 + 41 * MIN)).toHaveLength(1);
  });

  it('records a newly added area or channel silently before alerting', () => {
    const watcher = new Watcher();
    const road = (ids: string[]) => [
      { channel: 'events.road', items: ids.map((id) => event(id, INSIDE)) },
    ];
    expect(watcher.update([area], road(['e1', 'e2']), T0)).toEqual([]);
    expect(watcher.update([area], road(['e1', 'e2', 'e3']), T0 + MIN)).toMatchObject([
      { itemId: 'e3', text: 'Incident e3', lon: INSIDE[0], lat: INSIDE[1] },
    ]);
    const other = { ...area, id: 'w2' };
    expect(watcher.update([area, other], road(['e1', 'e2', 'e3', 'e4']), T0 + 2 * MIN)).toEqual([
      expect.objectContaining({ areaId: 'w1', itemId: 'e4' }),
    ]);
  });
});
