import { describe, expect, it } from 'vitest';
import {
  AreaSchema,
  BuildingTileSchema,
  ChannelName,
  ClientMessage,
  decodeLine,
  DepartureSchema,
  encodeLine,
  EventSchema,
  FeatureSchema,
  FrameSchema,
  isDeparture,
  isEntity,
  isEvent,
  isFeature,
  isFrame,
  isArea,
  PhotoTileSchema,
  RadioStationSchema,
  RouteSchema,
  ServerMessage,
  type LonLat,
} from './index';

const event = {
  id: 'e1',
  source: 'test',
  category: 'test',
  severity: 'info',
  title: 'Hello',
  locationPrecision: 'municipality',
  start: '2026-10-23T10:00:00+02:00',
};

describe('ChannelName', () => {
  it.each(['events.police', 'transit.vehicles', 'env.sea-level', 'a.b_c'])('accepts %s', (n) => {
    expect(ChannelName.safeParse(n).success).toBe(true);
  });

  it.each(['events', 'Events.police', 'events..police', '../etc', 'a.b c', 'x'.repeat(65)])(
    'rejects %s',
    (n) => {
      expect(ChannelName.safeParse(n).success).toBe(false);
    },
  );
});

describe('EventSchema', () => {
  it('accepts a minimal event', () => {
    expect(EventSchema.safeParse(event).success).toBe(true);
  });

  it('rejects non-http urls', () => {
    expect(EventSchema.safeParse({ ...event, url: 'javascript:alert(1)' }).success).toBe(false);
    expect(EventSchema.safeParse({ ...event, url: 'https://polisen.se/x' }).success).toBe(true);
  });
});

describe('protocol', () => {
  it('parses client subscribe messages', () => {
    expect(ClientMessage.parse({ type: 'subscribe', channels: ['events.police'] })).toEqual({
      type: 'subscribe',
      channels: ['events.police'],
    });
    expect(ClientMessage.safeParse({ type: 'subscribe', channels: [] }).success).toBe(false);
    expect(ClientMessage.safeParse({ type: 'eval', code: '1' }).success).toBe(false);
  });

  it('parses server snapshot messages', () => {
    const msg = ServerMessage.parse({
      type: 'snapshot',
      channel: 'events.police',
      items: [event],
      ts: '2026-10-23T08:00:00Z',
    });
    expect(msg.type).toBe('snapshot');
  });

  it('keeps departure rows intact and tells item types apart', () => {
    const departure = {
      id: 'd1',
      source: 'test',
      board: 'Brunnsparken',
      direction: 'departure',
      mode: 'tram',
      line: '11',
      place: 'Saltholmen',
      planned: '2026-10-23T14:14:00.000Z',
      cancelled: false,
      colors: { fg: '#ffffff', bg: '#000000' },
    } as const;
    const msg = ServerMessage.parse({
      type: 'delta',
      channel: 'transit.departures',
      upsert: [departure, event],
      remove: [],
      ts: '2026-10-23T08:00:00Z',
    });
    if (msg.type !== 'delta') throw new Error('expected delta');
    expect(msg.upsert[0]).toEqual(departure);
    expect(isDeparture(msg.upsert[0]!)).toBe(true);
    expect(isEvent(msg.upsert[0]!)).toBe(false);
    expect(isDeparture(msg.upsert[1]!)).toBe(false);
    expect(
      DepartureSchema.safeParse({ ...departure, colors: { fg: 'red', bg: '#000' } }).success,
    ).toBe(false);
  });

  it('keeps features intact and tells them apart from entities', () => {
    const feature = {
      id: 'way/1',
      source: 'osm',
      kind: 'waterway',
      line: encodeLine([
        [11.96, 57.7],
        [11.97, 57.71],
      ]),
      ts: '2026-10-23T08:00:00Z',
      props: { class: 'river' },
    } as const;
    const msg = ServerMessage.parse({
      type: 'snapshot',
      channel: 'env.waterways',
      items: [feature],
      ts: '2026-10-23T08:00:00Z',
    });
    if (msg.type !== 'snapshot') throw new Error('expected snapshot');
    expect(msg.items[0]).toEqual(feature);
    expect(isFeature(msg.items[0]!)).toBe(true);
    expect(isEntity(msg.items[0]!)).toBe(false);
    expect(FeatureSchema.safeParse({ ...feature, kind: 'tram' }).success).toBe(false);
  });
});

describe('encodeLine / decodeLine', () => {
  it('matches the reference polyline encoding', () => {
    const line: LonLat[] = [
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ];
    expect(encodeLine(line)).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(decodeLine('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual(line);
  });

  it('round-trips Gothenburg coordinates at ~1 m precision', () => {
    const line: LonLat[] = [
      [11.974612, 57.708934],
      [11.97002, 57.70011],
      [12.000004, 57.69999],
    ];
    const decoded = decodeLine(encodeLine(line));
    decoded.forEach(([lon, lat], i) => {
      expect(lon).toBeCloseTo(line[i]![0], 5);
      expect(lat).toBeCloseTo(line[i]![1], 5);
    });
  });

  it('rejects malformed input', () => {
    expect(decodeLine('_p~iF~ps|U_')).toEqual([]);
    expect(decodeLine('\u0001')).toEqual([]);
  });
});

describe('frames and tiles', () => {
  const frame = {
    id: 'radar_2610271245',
    source: 'smhi',
    product: 'radar',
    ts: '2026-10-27T12:45:00.000Z',
    path: '/api/data/smhi.radar/radar_2610271245.png',
    bbox: { west: 4, south: 53.5, east: 32, north: 71 },
  };

  it('accepts radar frames served by the API only', () => {
    expect(FrameSchema.parse(frame)).toEqual(frame);
    expect(isFrame(frame as never)).toBe(true);
    expect(isEntity(frame as never) || isFeature(frame as never)).toBe(false);
    for (const path of [
      'https://evil.example/x.png',
      '/api/data/../x.png',
      'javascript:alert(1)',
    ]) {
      expect(FrameSchema.safeParse({ ...frame, path }).success, path).toBe(false);
    }
  });

  it('validates building and photo tiles', () => {
    const tile = {
      z: 14,
      x: 8736,
      y: 4959,
      extent: 4096,
      buildings: [[12, 0, [[[0, 0, 10, 0, 10, 10]]]]],
    };
    expect(BuildingTileSchema.parse(tile)).toEqual(tile);
    expect(
      BuildingTileSchema.safeParse({ ...tile, buildings: [[12, 0, [[[0, 0]]]]] }).success,
    ).toBe(false);
    expect(PhotoTileSchema.safeParse({ items: [{ id: 'x' }] }).success).toBe(false);
  });
});

describe('districts, radio and routes', () => {
  it('accepts district areas and tells them apart from other items', () => {
    const area = {
      id: '1480R110',
      source: 'scb',
      label: 'Olivedal Kommendantsängen',
      polygons: [
        [
          encodeLine([
            [11.95, 57.69],
            [11.96, 57.69],
            [11.96, 57.7],
            [11.95, 57.69],
          ]),
        ],
      ],
      ts: '2026-10-27T12:00:00.000Z',
      props: { population: 4322 },
    };
    expect(AreaSchema.parse(area)).toEqual(area);
    expect(isArea(area as never)).toBe(true);
    expect(isEntity(area as never) || isFeature(area as never) || isFrame(area as never)).toBe(
      false,
    );
    expect(AreaSchema.safeParse({ ...area, polygons: [] }).success).toBe(false);
  });

  it('only allows HTTPS radio streams and well-formed routes', () => {
    const station = {
      id: 'sr-212',
      name: 'Sveriges Radio P4 Göteborg',
      provider: 'Sveriges Radio',
      stream: 'https://www.sverigesradio.se/topsy/direkt/srapi/212.mp3',
    };
    expect(RadioStationSchema.parse(station)).toEqual(station);
    expect(
      RadioStationSchema.safeParse({ ...station, stream: 'http://x.example/live' }).success,
    ).toBe(false);
    expect(
      RadioStationSchema.safeParse({ ...station, stream: 'javascript:alert(1)' }).success,
    ).toBe(false);
    expect(
      RouteSchema.safeParse({ profile: 'bike', distanceM: 10, durationS: 5, line: '_p~iF~ps|U' })
        .success,
    ).toBe(true);
    expect(
      RouteSchema.safeParse({ profile: 'plane', distanceM: 10, durationS: 5, line: 'ab' }).success,
    ).toBe(false);
  });
});
