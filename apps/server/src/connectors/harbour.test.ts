import { DepartureSchema, EntitySchema, MetricSchema } from '@gbg-osint/shared';
import { describe, expect, it } from 'vitest';
import {
  aisEta,
  applyAisMessage,
  createAisState,
  expectedArrivals,
  isGothenburgDestination,
} from './aisstream';
import { nowcastMetrics, parseVivaStation, parseVivaStations } from './harbour';
import { stockholmTimeToIso } from './util';

describe('Swedish local times', () => {
  it('converts wall-clock times with summer and winter time', () => {
    expect(stockholmTimeToIso('2026-10-29 01:27:00')).toBe('2026-10-29T00:27:00.000Z');
    expect(stockholmTimeToIso('2026-07-01 12:00')).toBe('2026-07-01T10:00:00.000Z');
    expect(stockholmTimeToIso('2026-03-29 04:00:00')).toBe('2026-03-29T02:00:00.000Z');
    expect(stockholmTimeToIso('29/10/2026')).toBeUndefined();
  });
});

describe('ViVa harbour stations', () => {
  const station = { id: 101, name: 'Torshamnen (GBG Hamn)', lon: 11.7881, lat: 57.681105 };
  const sample = (Name: string, Type: string, Value: string, extra = {}) => ({
    Name,
    Type,
    Value,
    Heading: 0,
    Unit: '',
    Updated: '2026-10-29 01:30:00',
    Quality: 'Ok',
    ...extra,
  });

  it('keeps stations around the harbour, inlet and river', () => {
    const list = parseVivaStations({
      GetStationsResult: {
        Stations: [
          { ID: 114, Name: 'Vinga', Lat: 57.631667, Lon: 11.607583 },
          { ID: 207, Name: 'Adelsö (SMHI)', Lat: 59.357934, Lon: 17.521315 },
        ],
      },
    });
    expect(list.map((s) => s.id)).toEqual([114]);
  });

  it('reads wind, level, currents and visibility, preferring surface readings', () => {
    const entity = parseVivaStation(
      {
        GetSingleStationResult: {
          Samples: [
            sample('Ström 7m', 'stream', 'V 0.1', { Heading: 264 }),
            sample('Ström Yta', 'stream', 'NO 0.9', { Heading: 61 }),
            sample('Byvind', 'wind', 'SV 11.0', { Heading: 245 }),
            sample('Medelvind', 'wind', 'SV 9.7', { Heading: 245 }),
            sample('Vattentemp Botten', 'watertemp', '11.8'),
            sample('Vattentemp 3m', 'watertemp', '11.2'),
            sample('Vattenstånd', 'level', '-12'),
            sample('Sikt', 'sight', '>20000', { Unit: 'm' }),
            sample('Lufttryck', 'pressure', '1018', { Quality: 'Bad' }),
          ],
        },
      },
      station,
    );
    expect(entity).toMatchObject({
      id: 'viva-101',
      label: 'Torshamnen',
      ts: '2026-10-29T00:30:00.000Z',
      props: {
        windMs: 9.7,
        gustMs: 11,
        windFromDeg: 245,
        currentKn: 0.9,
        currentTowardsDeg: 61,
        waterTempC: 11.2,
        waterLevelCm: -12,
        visibility: '>20000 m',
        operator: 'GBG Hamn',
      },
    });
    expect(entity!.props?.pressureHpa).toBeUndefined();
    expect(EntitySchema.safeParse(entity).success).toBe(true);
    expect(parseVivaStation({ GetSingleStationResult: { Samples: [] } }, station)).toBeUndefined();
  });
});

describe('rain nowcast', () => {
  const now = Date.parse('2026-10-29T12:02:00Z');
  const series = (rates: number[]) => ({
    properties: {
      meta: { radar_coverage: 'ok' },
      timeseries: rates.map((rate, i) => ({
        time: new Date(Date.parse('2026-10-29T12:00:00Z') + i * 5 * 60_000).toISOString(),
        data: { instant: { details: { precipitation_rate: rate } } },
      })),
    },
  });
  const byId = (raw: unknown) =>
    Object.fromEntries(nowcastMetrics(raw, now).map((m) => [m.id, m] as const));

  it('says when rain starts', () => {
    const m = byId(series([0, 0, 0, 0, 0, 0.8, 2.4, 1]));
    expect(m['rain-change']).toMatchObject({ name: 'Rain in', value: 25, unit: 'min' });
    expect(m['rain-max']?.value).toBe(2.4);
    for (const metric of Object.values(m))
      expect(MetricSchema.safeParse(metric).success).toBe(true);
  });

  it('says when it stops, or that nothing changes', () => {
    expect(byId(series([1.2, 0.5, 0, 0]))['rain-change']).toMatchObject({
      name: 'Dry in',
      value: 10,
    });
    expect(byId(series([0, 0, 0]))['rain-change']).toMatchObject({ name: 'Dry for at least' });
  });

  it('says nothing without radar coverage', () => {
    const raw = series([0, 1]);
    raw.properties.meta.radar_coverage = 'temporarily unavailable';
    expect(nowcastMetrics(raw, now)).toEqual([]);
  });
});

describe('ships expected at Gothenburg', () => {
  it('reads AIS destinations', () => {
    for (const d of [
      'SEGOT',
      'GOTHENBORG',
      'DKFDH<>SEGOT',
      'SEGOT PEC 100012',
      'FREDERIKSHAVN>GOTEBORG',
      'SE GOT',
    ]) {
      expect(isGothenburgDestination(d), d).toBe(true);
    }
    for (const d of ['GOTEBORG>FREDERIKSHAVN', 'SKAGEN', 'VISBY GOTLAND', 'GULLMASLEDEN']) {
      expect(isGothenburgDestination(d), d).toBe(false);
    }
  });

  it('places AIS ETAs (month, day, time) in the nearest year', () => {
    const late = Date.parse('2026-12-31T20:00:00Z');
    expect(aisEta({ Month: 1, Day: 2, Hour: 6, Minute: 0 }, late)).toBe(
      Date.parse('2027-01-02T06:00:00Z'),
    );
    expect(
      aisEta({ Month: 10, Day: 24, Hour: 21, Minute: 0 }, Date.parse('2026-10-29T00:00:00Z')),
    ).toBe(Date.parse('2026-10-24T21:00:00Z'));
    expect(aisEta({ Month: 0, Day: 0, Hour: 24, Minute: 60 }, late)).toBeUndefined();
    expect(aisEta({ Month: 2, Day: 30, Hour: 1, Minute: 0 }, late)).toBeUndefined();
  });

  it('lists ships bound for Gothenburg by ETA, leaving out leisure, service and moored craft', () => {
    const state = createAisState();
    const time = '2026-10-29 00:30:00.000 +0000 UTC';
    const now = Date.parse('2026-10-29T00:30:00Z');
    const statics = (
      mmsi: number,
      name: string,
      type: number,
      dest: string,
      day: number,
      hour: number,
    ) =>
      applyAisMessage(state, {
        MessageType: 'ShipStaticData',
        MetaData: { MMSI: mmsi, latitude: 57.5, longitude: 11.2, time_utc: time },
        Message: {
          ShipStaticData: {
            Name: name,
            Type: type,
            Destination: dest,
            Dimension: { A: 120, B: 29, C: 10, D: 10 },
            Eta: { Month: 10, Day: day, Hour: hour, Minute: 0 },
          },
        },
      });
    const position = (mmsi: number, status: number, lat = 57.5) =>
      applyAisMessage(state, {
        MessageType: 'PositionReport',
        MetaData: { MMSI: mmsi, latitude: lat, longitude: 11.2, time_utc: time },
        Message: { PositionReport: { Sog: 12.5, Cog: 90, NavigationalStatus: status } },
      });
    statics(1, 'ANINA', 70, 'SEGOT', 29, 4);
    statics(2, 'STENA DANICA', 60, 'DKFDH<>SEGOT', 29, 2);
    statics(3, 'MOORED ONE', 70, 'GOTEBORG', 29, 3);
    position(3, 5);
    statics(4, 'WIND', 37, 'GOTEBORG', 29, 5);
    statics(7, 'SVITZER EMBLA', 52, 'SEGOT', 29, 1);
    statics(5, 'ELSEWHERE', 70, 'SKAGEN', 29, 5);
    statics(6, 'FAR FUTURE', 70, 'SEGOT', 30, 5);
    position(2, 0);
    const rows = expectedArrivals(state, now);
    expect(rows.map((r) => r.line)).toEqual(['STENA DANICA', 'ANINA', 'FAR FUTURE']);
    expect(rows[0]).toMatchObject({
      board: 'Expected at Gothenburg (AIS)',
      direction: 'arrival',
      mode: 'ship',
      place: 'Passenger · 149 m',
      planned: '2026-10-29T02:00:00.000Z',
      status: '12.5 kn',
    });
    expect(rows[0]!.platform).toMatch(/nm$/);
    expect(rows[1]!.status).toBe('position not received yet');
    for (const r of rows) expect(DepartureSchema.safeParse(r).success).toBe(true);
  });
});
