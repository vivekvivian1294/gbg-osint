import { DepartureSchema, EntitySchema, EventSchema } from '@gbg-osint/shared';
import { describe, expect, it } from 'vitest';
import {
  applyAisMessage,
  createAisState,
  parseAisTime,
  pruneAis,
  shipCategory,
  shipEntities,
} from './aisstream';
import {
  airQualityIndex,
  dotNetDate,
  parseAirQuality,
  parseCityTraffic,
  parseWaterLevels,
} from './goteborg';
import { parseFlights } from './swedavia';
import {
  parseCameras,
  parseRoadWeather,
  parseSituations,
  parseTrainAnnouncements,
  roadSeverity,
} from './trafikverket';
import { bearing, parseWktPoint } from './util';
import { parseDepartures, parseVehicles, type Track } from './vasttrafik';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const valid = <T>(schema: { safeParse(v: unknown): { success: boolean } }, items: T[]) => {
  for (const item of items) expect(schema.safeParse(item).success).toBe(true);
};

describe('util', () => {
  it('parses WKT points and computes bearings', () => {
    expect(parseWktPoint('POINT (12.1691798975154 57.8049186928478)')).toEqual([
      12.1691798975154, 57.8049186928478,
    ]);
    expect(parseWktPoint('LINESTRING (1 2, 3 4)')).toBeUndefined();
    expect(parseWktPoint('POINT (500 2)')).toBeUndefined();
    expect(bearing({ lon: 12, lat: 57 }, { lon: 12, lat: 58 })).toBeCloseTo(0);
    expect(bearing({ lon: 12, lat: 57 }, { lon: 13, lat: 57 })).toBeCloseTo(89.6, 0);
  });
});

describe('västtrafik', () => {
  const position = (ref: string, lon: number, lat: number) => ({
    detailsReference: ref,
    line: {
      name: '11',
      backgroundColor: '#000000',
      foregroundColor: '#ffffff',
      transportMode: 'tram',
      isRealtimeJourney: false,
      operator: 'Göteborgs Spårvägar',
    },
    direction: 'Saltholmen',
    directionDetails: { shortDirection: 'Saltholmen' },
    latitude: lat,
    longitude: lon,
  });

  it('derives headings from movement and keeps them through GPS noise', () => {
    const first = parseVehicles(
      [position('a', 11.95, 57.7), { bad: true }],
      new Map(),
      '2026-10-23T12:00:00.000Z',
    );
    expect(first.entities[0]?.heading).toBeUndefined();
    const ts = '2026-10-23T12:00:15.000Z';
    const second = parseVehicles([position('a', 11.95, 57.701)], first.tracks, ts);
    expect(second.entities[0]?.heading).toBeCloseTo(0, 0);
    const noisy = parseVehicles([position('a', 11.95001, 57.701)], second.tracks, ts);
    expect(noisy.entities[0]?.heading).toBeCloseTo(0, 0);
    expect(second.entities[0]).toMatchObject({
      kind: 'tram',
      label: '11',
      props: { direction: 'Saltholmen', color: '#000000', textColor: '#ffffff' },
    });
    valid(EntitySchema, [...first.entities, ...second.entities]);
  });

  it('deduplicates vehicles returned by overlapping queries', () => {
    const { entities } = parseVehicles(
      [position('a', 11.95, 57.7), position('a', 11.95, 57.7)],
      new Map<string, Track>(),
      'x',
    );
    expect(entities).toHaveLength(1);
  });

  it('maps departure board rows', () => {
    const rows = parseDepartures(
      {
        results: [
          {
            detailsReference: 'ref1',
            serviceJourney: {
              direction: 'Saltholmen',
              directionDetails: { shortDirection: 'Saltholmen' },
              line: {
                name: 'Spårvagn 11',
                shortName: '11',
                backgroundColor: '#000000',
                foregroundColor: '#ffffff',
                transportMode: 'tram',
              },
            },
            stopPoint: { platform: 'C1' },
            plannedTime: '2026-10-23T14:14:00.0000000+02:00',
            estimatedTime: '2026-10-23T14:15:00.0000000+02:00',
            isCancelled: false,
          },
          { broken: true },
        ],
      },
      { gid: '9021014001760000', name: 'Brunnsparken' },
    );
    expect(rows).toEqual([
      expect.objectContaining({
        id: '9021014001760000-ref1',
        board: 'Brunnsparken',
        line: '11',
        place: 'Saltholmen',
        planned: '2026-10-23T12:14:00.000Z',
        expected: '2026-10-23T12:15:00.000Z',
        platform: 'C1',
        cancelled: false,
      }),
    ]);
    valid(DepartureSchema, rows);
  });
});

describe('trafikverket', () => {
  const deviation = {
    Id: 'SE_STA_1',
    MessageType: 'Olycka',
    MessageTypeValue: 'Accident',
    MessageCode: 'Olycka',
    Message: 'Trafikolycka med flera fordon.',
    SeverityCode: 2,
    RoadNumber: 'E6',
    LocationDescriptor: 'E6 vid Tingstadstunneln',
    StartTime: '2026-10-23T13:30:00.000+02:00',
    EndTime: '2026-10-23T16:00:00.000+02:00',
    Geometry: { Point: { WGS84: 'POINT (11.98 57.72)' } },
  };

  it('keeps current deviations inside Gothenburg and raises accidents', () => {
    const events = parseSituations(
      [
        {
          Deviation: [
            deviation,
            deviation,
            { ...deviation, Id: 'far', Geometry: { Point: { WGS84: 'POINT (18.0 59.3)' } } },
            { ...deviation, Id: 'future', StartTime: '2026-10-24T08:00:00.000+02:00' },
            { ...deviation, Id: 'over', EndTime: '2026-10-23T10:00:00.000+02:00' },
          ],
        },
      ],
      NOW,
    );
    expect(events.map((e) => e.id)).toEqual(['SE_STA_1']);
    expect(events[0]).toMatchObject({
      severity: 'major',
      title: 'Olycka: E6',
      locationPrecision: 'exact',
      geometry: { type: 'Point', coordinates: [11.98, 57.72] },
    });
    valid(EventSchema, events);
    expect(roadSeverity(5, undefined)).toBe('critical');
    expect(roadSeverity(1, 'MaintenanceWorks')).toBe('info');
  });

  it('builds the Göteborg C board with station names and statuses', () => {
    const names = new Map([
      ['Cst', 'Stockholm C'],
      ['K', 'Katrineholm C'],
    ]);
    const rows = parseTrainAnnouncements(
      [
        {
          ActivityId: 'a1',
          ActivityType: 'Avgang',
          AdvertisedTimeAtLocation: '2026-10-23T14:11:00.000+02:00',
          AdvertisedTrainIdent: '438',
          Canceled: false,
          TimeAtLocation: '2026-10-23T14:12:00.000+02:00',
          TrackAtLocation: '6',
          ToLocation: [{ LocationName: 'Cst', Order: 0 }],
          ProductInformation: [{ Description: 'SJ Snabbtåg' }],
        },
        {
          ActivityId: 'a2',
          ActivityType: 'Ankomst',
          AdvertisedTimeAtLocation: '2026-10-23T14:20:00.000+02:00',
          AdvertisedTrainIdent: '3021',
          Canceled: true,
          Deviation: [{ Description: 'Inställt' }],
          FromLocation: [{ LocationName: 'K' }],
        },
        { ActivityId: 'a3', ActivityType: 'Avgang', Deleted: true },
      ],
      names,
    );
    expect(rows).toEqual([
      expect.objectContaining({
        id: 'a1',
        direction: 'departure',
        place: 'Stockholm C',
        platform: '6',
        status: 'Departed',
        operator: 'SJ Snabbtåg',
        expected: '2026-10-23T12:12:00.000Z',
      }),
      expect.objectContaining({
        id: 'a2',
        direction: 'arrival',
        place: 'Katrineholm C',
        cancelled: true,
        status: 'Inställt',
      }),
    ]);
    valid(DepartureSchema, rows);
  });

  it('only keeps camera photo URLs on the Trafikverket image host', () => {
    const camera = {
      Id: 'cam1',
      Name: 'Tingstadsmotet',
      Direction: 330,
      Active: true,
      PhotoTime: '2026-10-23T14:15:06.000+02:00',
      PhotoUrl:
        'https://api.trafikinfo.trafikverket.se/v2/Images/data/road.infrastructure.camera/TrafficFlowCamera_1.jpg',
      Geometry: { WGS84: 'POINT (11.98 57.72)' },
    };
    const entities = parseCameras(
      [
        camera,
        { ...camera, Id: 'cam2', PhotoUrl: 'https://evil.example/x.jpg' },
        { ...camera, Id: 'cam3', Active: false },
      ],
      'x',
    );
    expect(entities.map((e) => [e.id, e.props?.photoUrl])).toEqual([
      ['cam1', camera.PhotoUrl],
      ['cam2', undefined],
    ]);
    expect(entities[0]).toMatchObject({ kind: 'camera', heading: 330 });
    valid(EntitySchema, entities);
  });

  it('reads road weather observations', () => {
    const entities = parseRoadWeather([
      {
        Id: '1520',
        Name: 'Surte',
        Geometry: { WGS84: 'POINT (12.01358 57.82452)' },
        Observation: {
          Sample: '2026-10-23T14:10:03.001+02:00',
          Air: { Temperature: { Value: 12.9 } },
          Surface: { Temperature: { Value: 0.5 }, Grip: { Value: 0.82 }, Ice: false },
          Wind: [{ Speed: { Value: 2.1 }, Direction: { Value: 199 } }],
        },
      },
      { Id: 'x', Name: 'No observation', Geometry: { WGS84: 'POINT (12 57.7)' } },
    ]);
    expect(entities).toHaveLength(1);
    expect(entities[0]?.props).toEqual({
      airTempC: 12.9,
      surfaceTempC: 0.5,
      grip: 0.82,
      ice: false,
      windMs: 2.1,
      windDirDeg: 199,
    });
    valid(EntitySchema, entities);
  });
});

describe('göteborgs stad', () => {
  it('parses WCF dates', () => {
    expect(dotNetDate('/Date(1773640800000+0100)/')).toBe('2026-03-16T06:00:00.000Z');
    expect(dotNetDate('2026-03-16')).toBeUndefined();
  });

  it('keeps active city traffic situations', () => {
    const situation = (id: string, extra: object = {}) => ({
      Id: id,
      Deviation: {
        Header: 'Vegagatan',
        Message: 'FV-schakt',
        MessageCode: 'Vägarbeten',
        MessageType: 'Vägarbete',
        SeverityCode: 4,
        ValidityStatus: 'active',
        StartTime: '/Date(1773640800000+0100)/',
        EndTime: '/Date(1793977200000+0100)/',
        Lat: 57.6932,
        Long: 11.948,
        Schedule: { RecurringTimePeriodOfDay: { Start: '07:00', End: '16:00' } },
        ...extra,
      },
    });
    const events = parseCityTraffic(
      [situation('1'), situation('1'), situation('2', { ValidityStatus: 'planned' })],
      NOW,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      title: 'Vägarbeten: Vegagatan',
      severity: 'major',
      body: 'FV-schakt · Daily 07:00–16:00',
    });
    valid(EventSchema, events);
  });

  it('maps water level parameters and regulation limits', () => {
    const [site] = parseWaterLevels(
      [
        {
          Code: 'Garda',
          Description: 'Gårda dämme',
          SG: 1.25,
          DG: 1.55,
          Lat: 57.707757,
          Long: 11.989718,
          MeasureParameters: [
            { Code: 'Level', CurrentValue: 1.42 },
            { Code: 'Tapping', CurrentValue: 8.6 },
            { Code: 'Unknown', CurrentValue: 1 },
          ],
        },
      ],
      'x',
    );
    expect(site?.props).toEqual({
      levelM: 1.42,
      dischargeM3s: 8.6,
      lowLimitM: 1.25,
      highLimitM: 1.55,
    });
  });

  it('groups air quality rows per station with an indicative index', () => {
    const row = (station: string, parameter: string, value: string) => ({
      date: '2026-10-23',
      time: '13:00+01:00',
      station,
      parameter,
      raw_value: `   ${value}`,
      unit: 'microgram per cubic metre',
      latitude_wgs84: '57.70875572',
      longitude_wgs84: '11.97050571',
    });
    const entities = parseAirQuality({
      results: [
        row('Femman', 'NO2', '4.21271'),
        row('Femman', 'PM10', '45.2'),
        row('Femman', 'PM2.5', ''),
        row('Haga_Norra', 'NO2', '95'),
      ],
    });
    expect(entities.map((e) => [e.label, e.props?.aqiLabel])).toEqual([
      ['Femman', 'Moderate'],
      ['Haga Norra', 'Moderate'],
    ]);
    expect(entities[0]?.props).toMatchObject({ no2Ugm3: 4.2, pm10Ugm3: 45.2, aqi: 3 });
    expect(entities[0]?.props).not.toHaveProperty('pm25Ugm3');
    expect(entities[0]?.ts).toBe('2026-10-23T12:00:00.000Z');
    expect(airQualityIndex({ no2Ugm3: 400 })).toBe(6);
    expect(airQualityIndex({})).toBeUndefined();
    valid(EntitySchema, entities);
  });
});

describe('aisstream', () => {
  const position = (mmsi: number, type = 'PositionReport', extra: object = {}) => ({
    MessageType: type,
    MetaData: {
      MMSI: mmsi,
      ShipName: 'STENA DANICA        ',
      latitude: 57.7,
      longitude: 11.9,
      time_utc: '2026-10-23 12:24:06.230068183 +0000 UTC',
    },
    Message: {
      [type]: { Cog: 270, Sog: 12.3, TrueHeading: 268, NavigationalStatus: 0, ...extra },
    },
  });

  it('parses AIS timestamps', () => {
    expect(parseAisTime('2026-10-23 12:24:06.230068183 +0000 UTC')).toBe(
      Date.parse('2026-10-23T12:24:06.230Z'),
    );
    expect(parseAisTime('garbage')).toBeUndefined();
  });

  it('merges positions with static data and anonymises leisure craft', () => {
    const state = createAisState();
    applyAisMessage(state, position(265177000));
    applyAisMessage(state, {
      MessageType: 'ShipStaticData',
      MetaData: { ...position(265177000).MetaData },
      Message: {
        ShipStaticData: {
          Name: 'STENA DANICA',
          CallSign: 'SKPE  ',
          Type: 69,
          Destination: 'FREDERIKSHAVN',
          Dimension: { A: 100, B: 54, C: 10, D: 18 },
        },
      },
    });
    applyAisMessage(
      state,
      position(265000001, 'StandardClassBPositionReport', { TrueHeading: 511 }),
    );
    applyAisMessage(state, { MessageType: 'PositionReport', MetaData: { MMSI: -1 } });

    const entities = shipEntities(state, 'salt');
    expect(entities).toHaveLength(2);
    const [ferry, small] = entities;
    expect(ferry).toMatchObject({
      id: '265177000',
      label: 'STENA DANICA',
      heading: 268,
      props: {
        category: 'passenger',
        callsign: 'SKPE',
        destination: 'FREDERIKSHAVN',
        lengthM: 154,
        status: 'under way (engine)',
        aisClass: 'A',
      },
    });
    expect(small?.id).toMatch(/^anon-[0-9a-f]{16}$/);
    expect(small).toMatchObject({ label: 'Small craft', heading: 270 });
    expect(JSON.stringify(small)).not.toContain('265000001');
    expect(JSON.stringify(small)).not.toContain('STENA');
    valid(EntitySchema, entities);

    pruneAis(state, Date.parse('2026-10-23T13:00:00Z'));
    expect(shipEntities(state, 'salt')).toEqual([]);
    expect(shipCategory(37)).toBe('pleasure');
    expect(shipCategory(84)).toBe('tanker');
  });
});

describe('swedavia', () => {
  const flight = (id: string, extra: object = {}) => ({
    flightId: id,
    arrivalAirportEnglish: 'London STN',
    airlineOperator: { name: 'Ryanair Ltd' },
    departureTime: { scheduledUtc: '2026-10-23T12:45:00Z', estimatedUtc: '2026-10-23T13:05:00Z' },
    locationAndStatus: { terminal: 'T1', gate: '23', flightLegStatus: 'SCH' },
    flightLegIdentifier: { callsign: 'RYR23YL', flightDepartureDateUtc: '2026-10-23T00:00:00Z' },
    remarksEnglish: [{ text: 'New time 15:05' }],
    ...extra,
  });

  it('keeps flights in the time window and drops deleted ones', () => {
    const rows = parseFlights(
      {
        flights: [
          flight('FR965'),
          flight('W69154', { locationAndStatus: { flightLegStatus: 'DEL' } }),
          flight('SK1', { departureTime: { scheduledUtc: '2026-10-23T23:30:00Z' } }),
          flight('XX1', { departureTime: { scheduledUtc: 'nope' } }),
        ],
      },
      'departure',
      NOW,
    );
    expect(rows).toEqual([
      expect.objectContaining({
        id: 'd-FR965-2026-10-23',
        line: 'FR965',
        place: 'London STN',
        operator: 'Ryanair Ltd',
        platform: '23',
        status: 'New time 15:05',
        expected: '2026-10-23T13:05:00.000Z',
        callsign: 'RYR23YL',
      }),
    ]);
    valid(DepartureSchema, rows);
  });
});
