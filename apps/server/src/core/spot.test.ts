import { encodeLine, type ChannelItem, type ChannelKind, type LonLat } from '@gbg-osint/shared';
import { describe, expect, it } from 'vitest';
import { parseGeosearch, parseNearbyPath } from '../connectors/wikipedia';
import { spotReport } from './spot';
import { ChannelStore } from './store';

const TS = '2026-10-23T10:00:00.000Z';
const HERE: LonLat = [11.9688, 57.7072];
/** Metres north of HERE, as latitude. */
const north = (m: number) => HERE[1] + m / 110_540;

function storeWith(channels: Record<string, [ChannelKind, ChannelItem[]]>): ChannelStore {
  const store = new ChannelStore();
  for (const [name, [kind, items]] of Object.entries(channels)) {
    store.register(name, kind, 'test');
    store.replace(name, items);
  }
  return store;
}

const event = (id: string, coordinates: LonLat, precision = 'exact'): ChannelItem => ({
  id,
  source: 'test',
  category: 'Test',
  severity: 'minor',
  title: `Event ${id}`,
  geometry: { type: 'Point', coordinates },
  locationPrecision: precision as 'exact',
  start: TS,
});
const camera = (id: string, metresNorth: number): ChannelItem => ({
  id,
  source: 'trafikverket',
  kind: 'camera',
  lon: HERE[0],
  lat: north(metresNorth),
  label: `Camera ${id}`,
  ts: TS,
});
const box = (w: number, s: number, e: number, n: number) =>
  encodeLine([
    [w, s],
    [e, s],
    [e, n],
    [w, n],
  ]);

describe('spot report', () => {
  it('finds the district, nearby precise events and the nearest cameras', () => {
    const store = storeWith({
      'context.districts': [
        'areas',
        [
          {
            id: 'far',
            source: 'scb',
            label: 'Elsewhere',
            polygons: [[box(12.1, 57.8, 12.2, 57.9)]],
            ts: TS,
          },
          {
            id: 'inom',
            source: 'scb',
            label: 'Inom Vallgraven',
            polygons: [[box(11.95, 57.7, 11.98, 57.71)]],
            ts: TS,
            props: { population: 4038 },
          },
        ],
      ],
      'events.road': [
        'events',
        [event('near', [HERE[0], north(100)]), event('far', [HERE[0], north(800)])],
      ],
      'events.police': ['events', [event('vague', HERE, 'municipality')]],
      'events.city-traffic': ['events', [event('nearest', [HERE[0], north(20)])]],
      'cameras.road': [
        'entities',
        [
          camera('c1', 3000),
          camera('c2', 400),
          camera('c3', 900),
          camera('c4', 1200),
          camera('c5', 6000),
        ],
      ],
    });

    const report = spotReport(store, ...HERE);
    expect(report.district).toEqual({
      channel: 'context.districts',
      id: 'inom',
      label: 'Inom Vallgraven',
      props: { population: 4038 },
    });
    expect(report.events.map((e) => [e.channel, e.event.id, e.distanceM])).toEqual([
      ['events.city-traffic', 'nearest', 20],
      ['events.road', 'near', 100],
    ]);
    expect(report.cameras.map((c) => [c.entity.id, c.distanceM])).toEqual([
      ['c2', 400],
      ['c3', 900],
      ['c4', 1200],
    ]);
  });

  it('is empty, not an error, without the channels', () => {
    expect(spotReport(new ChannelStore(), ...HERE)).toEqual({
      lon: HERE[0],
      lat: HERE[1],
      events: [],
      cameras: [],
    });
  });
});

describe('Wikipedia nearby', () => {
  it('accepts rounded Gothenburg coordinates only', () => {
    expect(parseNearbyPath('nearby/sv/57.707/11.969.json')).toEqual({
      lang: 'sv',
      lat: 57.707,
      lon: 11.969,
    });
    for (const path of [
      'nearby/de/57.707/11.969.json',
      'nearby/sv/57.7071/11.969.json',
      'nearby/sv/59.330/18.060.json',
      'nearby/sv/../11.969.json',
    ]) {
      expect(parseNearbyPath(path), path).toBeUndefined();
    }
  });

  it('turns geosearch results into article links', () => {
    expect(
      parseGeosearch(
        {
          query: {
            geosearch: [
              { pageid: 1, title: 'Brunnsparken, Göteborg', dist: 21.6, lat: 57.7, lon: 11.9 },
            ],
          },
        },
        'sv',
      ),
    ).toEqual({
      articles: [
        {
          title: 'Brunnsparken, Göteborg',
          url: 'https://sv.wikipedia.org/wiki/Brunnsparken%2C_G%C3%B6teborg',
          distanceM: 22,
        },
      ],
    });
    expect(parseGeosearch({ batchcomplete: true }, 'en')).toEqual({ articles: [] });
  });
});
