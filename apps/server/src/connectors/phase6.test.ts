import {
  decodeLine,
  DepartureSchema,
  EntitySchema,
  EventSchema,
  FeatureSchema,
} from '@gbg-osint/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectorContext } from '../core/connector';
import { UpstreamError } from '../core/http';
import { flightRoutes, parseFlightRoute, parseMetars } from './aviation';
import {
  parseRailEvents,
  parseTrainInfo,
  parseTrainPositions,
  railEventPoint,
  trainEntities,
} from './rail';
import { parseFerryDepartures, parseTravelTimes } from './roadsAndFerries';
import { StreetNetwork, type NetworkTile } from './streetNetwork';
import { fromLocalM, parseWktLine, toLocalM } from './util';

const position = (num: string, lon: number, lat: number, ts: string, extra = {}) => ({
  Train: {
    OperationalTrainNumber: num,
    OperationalTrainDepartureDate: '2026-10-28T00:00:00.000+01:00',
    AdvertisedTrainNumber: num,
  },
  Position: { WGS84: `POINT (${lon} ${lat})` },
  TimeStamp: ts,
  Status: { Active: true },
  Bearing: 90,
  Speed: 80,
  ...extra,
});

describe('live trains', () => {
  it('keeps the latest active report per train', () => {
    const reports = parseTrainPositions([
      position('3979', 11.97, 57.71, '2026-10-29T00:51:24.000+01:00'),
      position('3979', 11.98, 57.71, '2026-10-29T00:51:44.000+01:00'),
      position('451', 12.0, 57.72, '2026-10-29T00:51:44.000+01:00', { Status: { Active: false } }),
      position('9999', 12.0, 57.72, 'not a time'),
      { Train: { OperationalTrainNumber: 'DROP TABLE' } },
    ]);
    expect(reports).toEqual([
      {
        id: '3979-2026-10-27',
        number: '3979',
        lon: 11.98,
        lat: 57.71,
        ts: '2026-10-28T23:51:44.000Z',
        bearing: 90,
        speedKmh: 80,
      },
    ]);
  });

  it('derives delay, last station and destination from passed announcements', () => {
    const names = new Map([
      ['G', 'Göteborg C'],
      ['Or', 'Olskroken'],
      ['A', 'Alingsås'],
    ]);
    const info = parseTrainInfo(
      [
        {
          AdvertisedTrainIdent: '3979',
          AdvertisedTimeAtLocation: '2026-10-29T00:40:00.000+01:00',
          TimeAtLocation: '2026-10-29T00:46:00.000+01:00',
          LocationSignature: 'Or',
        },
        {
          AdvertisedTrainIdent: '3979',
          AdvertisedTimeAtLocation: '2026-10-29T00:20:00.000+01:00',
          TimeAtLocation: '2026-10-29T00:22:00.000+01:00',
          LocationSignature: 'A',
          ToLocation: [
            { LocationName: 'Or', Order: 0 },
            { LocationName: 'G', Order: 1 },
          ],
          ProductInformation: [{ Description: 'SJ Regional' }],
          Operator: 'SJ',
        },
      ],
      names,
    );
    expect(info.get('3979')).toEqual({
      lastStation: 'Olskroken',
      delayMin: 6,
      destination: 'Göteborg C',
      product: 'SJ Regional',
      operator: 'SJ',
    });
  });

  it('places trains on the rail network and labels them with their destination', () => {
    const [cx, cy] = toLocalM([11.9746, 57.7089]);
    const network = new StreetNetwork();
    for (let x = 8735; x <= 8737; x++) {
      for (let y = 4958; y <= 4960; y++) {
        network.add({ x, y, tram: [], road: [], service: [], rail: [] } satisfies NetworkTile);
      }
    }
    network.graphs.rail.addLine([cx - 200, cy, cx + 200, cy]);
    const [lon, lat] = fromLocalM([cx - 50, cy + 3]);
    const reports = parseTrainPositions([
      position('3979', lon, lat, '2026-10-29T00:51:24.000+01:00'),
    ]);
    const info = new Map([['3979', { destination: 'Göteborg C', delayMin: 6 }]]);
    const { entities, tracks } = trainEntities(reports, info, new Map(), network);
    expect(entities[0]).toMatchObject({
      kind: 'train',
      label: '3979 → Göteborg C',
      heading: 90,
      props: { train: '3979', delayMin: 6, speedKmh: 80, matched: 'rail' },
    });
    const [, snappedY] = toLocalM([entities[0]!.lon, entities[0]!.lat]);
    expect(snappedY - cy).toBeCloseTo(0, 0);
    expect(tracks.get('3979-2026-10-27')?.heading).toBe(90);
    expect(EntitySchema.safeParse(entities[0]).success).toBe(true);

    const raw = trainEntities(reports, new Map(), new Map());
    expect(raw.entities[0]).toMatchObject({ lon, lat, label: '3979', heading: 90 });
    expect(raw.entities[0]!.props?.matched).toBeUndefined();
  });
});

describe('rail disruptions', () => {
  it('reads operative event points in either coordinate order', () => {
    expect(railEventPoint('POINT (57.711 11.972)')).toEqual([11.972, 57.711]);
    expect(railEventPoint('POINT (11.972 57.711)')).toEqual([11.972, 57.711]);
    expect(railEventPoint('nope')).toBeUndefined();
  });

  it('lists current disruptions near Gothenburg with their section', () => {
    const now = Date.parse('2026-10-29T08:00:00Z');
    const event = (id: string, extra: Record<string, unknown>) => ({
      OperativeEventId: id,
      EventType: { Description: 'Signalfel' },
      StartDateTime: '2026-10-29T07:30:00.000+01:00',
      Deleted: false,
      Geometry: { WGS84: 'POINT (57.72 12.0)' },
      EventSection: [{ FromLocation: { Signature: 'G' }, ToLocation: { Signature: 'A' } }],
      ...extra,
    });
    const names = new Map([
      ['G', 'Göteborg C'],
      ['A', 'Alingsås'],
    ]);
    const events = parseRailEvents(
      [
        event('a', {
          TrafficImpact: [{ PublicMessage: { Header: 'Förseningar', Description: 'Kör sakta' } }],
        }),
        event('b', {}),
        event('ended', { EndDateTime: '2026-10-29T08:30:00.000+01:00' }),
        event('far', { Geometry: { WGS84: 'POINT (59.33 18.06)' } }),
        event('old', { StartDateTime: '2026-10-20T07:30:00.000+01:00' }),
      ],
      names,
      now,
    );
    expect(events.map((e) => e.id)).toEqual(['a', 'b']);
    expect(events[0]).toMatchObject({
      category: 'Rail',
      severity: 'major',
      title: 'Göteborg C–Alingsås: Förseningar',
      body: 'Kör sakta · Signalfel',
      geometry: { type: 'Point', coordinates: [12.0, 57.72] },
      locationPrecision: 'area',
    });
    expect(events[1]).toMatchObject({ severity: 'minor', title: 'Göteborg C–Alingsås: Signalfel' });
    for (const e of events) expect(EventSchema.safeParse(e).success).toBe(true);
  });
});

describe('road ferries and travel times', () => {
  it('makes one board per ferry route', () => {
    const rows = parseFerryDepartures([
      {
        Id: 5520261029005556,
        DepartureTime: '2026-10-29T00:55:00.000+01:00',
        Deleted: false,
        FromHarbor: { Name: 'Hönö' },
        ToHarbor: { Name: 'Lilla Varholmen' },
        Route: { Name: 'Hönöleden' },
      },
      { Id: 1, Deleted: true },
    ]);
    expect(rows).toEqual([
      expect.objectContaining({
        id: '5520261029005556',
        board: 'Hönöleden',
        mode: 'ferry',
        line: 'Hönö',
        place: 'Lilla Varholmen',
        planned: '2026-10-28T23:55:00.000Z',
      }),
    ]);
    expect(DepartureSchema.safeParse(rows[0]).success).toBe(true);
  });

  it('parses WKT lines', () => {
    expect(parseWktLine('LINESTRING (11.9 57.7, 11.95 57.71)')).toEqual([
      [11.9, 57.7],
      [11.95, 57.71],
    ]);
    expect(parseWktLine('LINESTRING (11.9 57.7)')).toBeUndefined();
    expect(parseWktLine('LINESTRING (11.9 97.7, 11.95 57.71)')).toBeUndefined();
    expect(parseWktLine('POINT (11.9 57.7)')).toBeUndefined();
  });

  it('turns measured stretches into line features', () => {
    const [f] = parseTravelTimes([
      {
        Id: '10381',
        Name: 'E45 Järntorget - Centrum',
        MeasureTime: '2026-10-29T00:50:00.000+01:00',
        Speed: 67.4,
        TravelTime: 95.43,
        FreeFlowTravelTime: 91.882,
        Length: 1786.594,
        TrafficStatus: 'freeflow',
        Geometry: { WGS84: 'LINESTRING (11.94696242 57.70091471, 11.95253200 57.70148448)' },
      },
    ]);
    expect(f).toMatchObject({
      kind: 'travel-time',
      label: 'E45 Järntorget - Centrum',
      props: { speedKmh: 67.4, travelTimeS: 95, freeFlowS: 92, lengthM: 1787, status: 'freeflow' },
    });
    expect(decodeLine(f!.line)[1]![0]).toBeCloseTo(11.952532, 5);
    expect(FeatureSchema.safeParse(f).success).toBe(true);
  });
});

describe('aviation', () => {
  it('reads METAR and TAF for the Gothenburg airports', () => {
    const [esgg, ...rest] = parseMetars([
      {
        icaoId: 'ESGG',
        reportTime: '2026-10-28T23:20:00.000Z',
        lat: 57.667,
        lon: 12.285,
        rawOb: 'METAR ESGG 282320Z 18010KT 9999 SCT012 BKN017 BKN023 09/09 Q1020',
        rawTaf: 'TAF ESGG 282330Z 2900/2924 19008KT 9999 FEW002 BKN045',
        fltCat: 'MVFR',
        temp: 9,
        dewp: 9,
        wdir: 180,
        wspd: 10,
        visib: '6+',
        altim: 1020,
        clouds: [
          { cover: 'SCT', base: 1200 },
          { cover: 'BKN', base: 1700 },
          { cover: 'BKN', base: 2300 },
        ],
      },
      { icaoId: 'KJFK', reportTime: '2026-10-28T23:20:00.000Z', lat: 40, lon: -73, rawOb: 'METAR' },
    ]);
    expect(rest).toEqual([]);
    expect(esgg).toMatchObject({
      id: 'ESGG',
      label: 'ESGG MVFR',
      props: {
        airport: 'Göteborg Landvetter',
        flightCategory: 'MVFR',
        windDir: '180',
        windKt: 10,
        visibilitySm: '6+',
        ceilingFt: 1700,
        qnhHpa: 1020,
      },
    });
    expect(String(esgg!.props?.taf)).toContain('TAF ESGG');
    expect(EntitySchema.safeParse(esgg).success).toBe(true);
    expect(parseMetars({ not: 'a list' })).toEqual([]);
  });

  const adsbdb = {
    response: {
      flightroute: {
        callsign: 'SAS1405',
        callsign_iata: 'SK1405',
        airline: { name: 'Scandinavian Airlines System' },
        origin: {
          icao_code: 'ESSA',
          iata_code: 'ARN',
          name: 'Stockholm-Arlanda Airport',
          municipality: 'Stockholm',
          country_name: 'Sweden',
        },
        destination: {
          icao_code: 'EKCH',
          iata_code: 'CPH',
          name: 'Copenhagen Kastrup Airport',
          municipality: 'Copenhagen',
        },
      },
    },
  };

  it('maps adsbdb routes', () => {
    expect(parseFlightRoute(adsbdb, 'SAS1405')).toEqual({
      callsign: 'SAS1405',
      flight: 'SK1405',
      airline: 'Scandinavian Airlines System',
      origin: {
        icao: 'ESSA',
        iata: 'ARN',
        name: 'Stockholm-Arlanda Airport',
        city: 'Stockholm',
        country: 'Sweden',
      },
      destination: {
        icao: 'EKCH',
        iata: 'CPH',
        name: 'Copenhagen Kastrup Airport',
        city: 'Copenhagen',
      },
    });
    expect(parseFlightRoute({ response: 'unknown callsign' }, 'X')).toBeUndefined();
  });

  it('serves routes by callsign, remembering unknown ones', async () => {
    const getJson = vi.fn(async (url: string) => {
      if (url.endsWith('/SAS1405')) return adsbdb;
      throw new UpstreamError('HTTP 404 from api.adsbdb.com', 404);
    });
    const ctx = { http: { getJson } } as unknown as ConnectorContext;
    const ok = await flightRoutes.serve!(ctx, 'callsign/SAS1405.json');
    expect(JSON.parse(String(ok?.body))).toMatchObject({ flight: 'SK1405' });
    expect(await flightRoutes.serve!(ctx, 'callsign/ZZZ9999.json')).toBeUndefined();
    expect(await flightRoutes.serve!(ctx, 'callsign/ZZZ9999.json')).toBeUndefined();
    expect(await flightRoutes.serve!(ctx, 'callsign/../etc.json')).toBeUndefined();
    expect(await flightRoutes.serve!(ctx, 'callsign/sas1405.json')).toBeUndefined();
    expect(getJson).toHaveBeenCalledTimes(2);
  });
});
