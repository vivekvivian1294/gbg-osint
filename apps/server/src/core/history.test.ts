import {
  BriefSchema,
  type ChannelItem,
  type ChannelKind,
  type Departure,
  type Entity,
  type GeoEvent,
  type Metric,
} from '@gbg-osint/shared';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { anomaly, buildBrief } from './brief';
import { delayIndex, lateCount } from './delays';
import { History, TRANSIT_LATE_KEY, type HistorySnapshot } from './history';
import { ChannelStore } from './store';

const T0 = Date.parse('2026-10-23T10:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();

let nextId = 0;
function dep(over: Partial<Departure> & { planned: string }): Departure {
  nextId += 1;
  return {
    id: `d${nextId}`,
    source: 'vasttrafik',
    board: 'Centralstationen',
    direction: 'departure',
    mode: 'tram',
    line: '6',
    place: 'Kortedala',
    cancelled: false,
    ...over,
  };
}
const late = (minutes: number, over: Partial<Departure> = {}) =>
  dep({ planned: iso(T0), expected: iso(T0 + minutes * MIN), ...over });

function entity(over: Partial<Entity> & { id: string }): Entity {
  return { source: 'test', kind: 'sensor', lon: 11.9, lat: 57.7, ts: iso(T0), ...over };
}
function event(over: Partial<GeoEvent> & { id: string }): GeoEvent {
  return {
    source: 'test',
    category: 'Test',
    severity: 'minor',
    title: `Event ${over.id}`,
    locationPrecision: 'exact',
    start: iso(T0 - HOUR),
    ...over,
  };
}
function metric(id: string, value: number, unit = '°C'): Metric {
  return { id, source: 'test', name: id, unit, value, ts: iso(T0) };
}

describe('History', () => {
  it('samples metrics, sensor readings, event counts and late departures every 5 minutes', () => {
    const store = new ChannelStore();
    store.register('env.weather', 'metrics', 'smhi');
    store.register('env.harbour', 'entities', 'viva');
    store.register('events.road', 'events', 'trafikverket');
    store.register('transit.departures', 'departures', 'vasttrafik');
    store.register('transit.vehicles', 'entities', 'vasttrafik');
    store.replace('env.weather', [metric('71420-temp', 7.25)]);
    store.replace('env.harbour', [entity({ id: 'viva-1', props: { windMs: 8, label: 'x' } })]);
    store.replace('events.road', [event({ id: 'a' }), event({ id: 'b' })]);
    store.replace('transit.departures', [
      late(6),
      late(1),
      dep({ planned: iso(T0), cancelled: true }),
    ]);
    store.replace('transit.vehicles', [entity({ id: 'tram-1', kind: 'tram' })]);

    const history = new History();
    history.sample(store, T0);
    store.replace('env.weather', [metric('71420-temp', 8)]);
    history.sample(store, T0 + MIN);
    history.sample(store, T0 + 5 * MIN);

    expect(history.seriesOf('env.weather/71420-temp')).toEqual({
      key: 'env.weather/71420-temp',
      unit: '°C',
      points: [
        [T0, 7.25],
        [T0 + 5 * MIN, 8],
      ],
    });
    expect(history.seriesOf('env.harbour/viva-1/windMs')?.unit).toBe('m/s');
    expect(history.seriesOf('env.harbour/viva-1/label')).toBeUndefined();
    expect(history.seriesOf('count/events.road')?.points[0]).toEqual([T0, 2]);
    expect(history.seriesOf(TRANSIT_LATE_KEY)?.points[0]).toEqual([T0, 2]);
    expect(history.seriesUnder('env.harbour/viva-1/').map((s) => s.key)).toEqual([
      'env.harbour/viva-1/windMs',
    ]);
    expect(history.trackOf('transit.vehicles/tram-1')).toBeUndefined();
    expect(history.hours(T0 + 5 * MIN)).toBe(0.1);
  });

  it('keeps tracks of ships after real movement or a long gap, but not of anonymised craft', () => {
    const store = new ChannelStore();
    store.register('maritime.ships', 'entities', 'ais');
    const ship = (lon: number) => [
      entity({ id: '265000001', kind: 'ship', lon, lat: 57.7 }),
      entity({ id: 'anon-1', kind: 'ship', lon, lat: 57.7 }),
    ];
    const history = new History();
    store.replace('maritime.ships', ship(11.8));
    history.sample(store, T0);
    store.replace('maritime.ships', ship(11.8002)); // about 12 m
    history.sample(store, T0 + MIN);
    store.replace('maritime.ships', ship(11.801)); // about 60 m from the last point
    history.sample(store, T0 + 2 * MIN);
    history.sample(store, T0 + 13 * MIN);

    expect(history.trackOf('maritime.ships/265000001')?.points).toEqual([
      [T0, 11.8, 57.7, 0],
      [T0 + 2 * MIN, 11.801, 57.7, 0],
      [T0 + 13 * MIN, 11.801, 57.7, 0],
    ]);
    expect(history.trackOf('maritime.ships/anon-1')).toBeUndefined();
  });

  it('keeps seven days, answers the last 24 hours by default and imports the old history', () => {
    const snapshot: HistorySnapshot = {
      series: {
        'env.weather/71420-temp': {
          unit: '°C',
          points: [
            [T0 - 25 * HOUR, 1],
            [T0 - HOUR, 2],
          ],
        },
        'env.weather/old': { unit: '°C', points: [[T0 - 8 * 24 * HOUR, 1]] },
      },
      tracks: { 'aviation.aircraft/abc123': [[T0 - 26 * HOUR, 12, 57.6, 3000]] },
    };
    const history = new History();
    history.restore(snapshot, T0);
    expect(history.seriesOf('env.weather/71420-temp')?.points).toEqual([[T0 - HOUR, 2]]);
    expect(history.seriesOf('env.weather/71420-temp', T0 - 48 * HOUR)?.points).toHaveLength(2);
    expect(history.seriesOf('env.weather/old', 0)).toBeUndefined();
    expect(history.trackOf('aviation.aircraft/abc123')).toBeUndefined();
    expect(history.trackOf('aviation.aircraft/abc123', T0 - 48 * HOUR)?.points).toEqual([
      [T0 - 26 * HOUR, 12, 57.6, 3000],
    ]);
    expect(history.hours(T0)).toBe(25);
    expect(history.range()).toEqual({ from: T0 - 26 * HOUR, to: T0 });
  });

  it('averages long spans down to at most 1000 points', () => {
    const history = new History();
    const points = Array.from({ length: 7 * 288 }, (_, i): [number, number] => [
      T0 - (7 * 288 - i) * 5 * MIN,
      i % 2,
    ]);
    history.restore({ series: { 'env.weather/t': { unit: '°C', points } }, tracks: {} }, T0);
    const week = history.seriesOf('env.weather/t', T0 - 7 * 24 * HOUR)!.points;
    expect(week.length).toBeLessThanOrEqual(1000);
    expect(week.length).toBeGreaterThan(600);
    expect(week[1]![0] - week[0]![0]).toBe(15 * MIN);
    expect(week[0]![1]).toBeCloseTo(1 / 3, 2);
    expect(week[1]![1]).toBeCloseTo(2 / 3, 2);
  });

  it('survives a restart in a file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'gbg-history-')), 'history.db');
    const store = new ChannelStore();
    store.register('env.weather', 'metrics', 'smhi');
    store.replace('env.weather', [metric('71420-temp', 7)]);
    const first = new History(path);
    first.sample(store, T0);
    first.close();
    const second = new History(path);
    second.sample(store, T0 + 2 * MIN);
    expect(second.seriesOf('env.weather/71420-temp', T0 - HOUR)?.points).toEqual([[T0, 7]]);
    second.close();
  });
});

describe('replay', () => {
  const ship = (id: string, lon: number, props: Record<string, unknown> = {}) =>
    entity({ id, kind: 'ship', lon, lat: 57.7, heading: 90, label: id, props });

  function recorded() {
    const store = new ChannelStore();
    store.register('maritime.ships', 'entities', 'ais');
    store.register('events.road', 'events', 'trafikverket');
    store.register('env.harbour', 'entities', 'viva');
    store.register('env.weather', 'metrics', 'smhi');
    store.register('transit.vehicles', 'entities', 'vasttrafik');
    const history = new History();
    for (let i = 0; i <= 40; i++) {
      const t = T0 + i * MIN;
      store.replace('maritime.ships', [
        ship('265000001', 11.8 + i * 0.001, { speedKn: 10 + i }),
        ship('anon-1', 11.7),
      ]);
      store.replace('events.road', i < 20 ? [event({ id: 'a' })] : []);
      store.replace('env.harbour', [
        entity({ id: 'viva-1', label: 'Vinga', props: { windMs: i < 20 ? 5 : 12 } }),
      ]);
      store.replace('env.weather', [metric('71420-temp', i)]);
      store.replace('transit.vehicles', [entity({ id: 'tram-1', kind: 'tram' })]);
      history.sample(store, t);
    }
    return { store, history };
  }

  it('shows what was there at a past moment', () => {
    const { store, history } = recorded();
    const channels = store.list();
    const at = (t: number) => Object.fromEntries(history.at(t, channels));

    const early = at(T0 + 10 * MIN + 30_000);
    expect(early['events.road']?.map((e) => e.id)).toEqual(['a']);
    expect(early['transit.vehicles']).toBeUndefined();
    const [s] = early['maritime.ships'] as Entity[];
    expect(early['maritime.ships']).toHaveLength(1);
    expect(s).toMatchObject({ id: '265000001', label: '265000001', heading: 90 });
    expect(s!.lon).toBeCloseTo(11.8105, 4);
    expect(s!.ts).toBe(iso(T0 + 10 * MIN + 30_000));
    expect(early['env.harbour']?.[0]).toMatchObject({ props: { windMs: 5 } });
    expect(early['env.weather']?.[0]).toMatchObject({ id: '71420-temp', name: '71420-temp' });

    const late = at(T0 + 35 * MIN);
    expect(late['events.road']).toEqual([]);
    expect(late['env.harbour']?.[0]).toMatchObject({ props: { windMs: 12 } });
    expect(at(T0 - HOUR)['maritime.ships']).toEqual([]);
  });
});

describe('delay index', () => {
  it('ranks Västtrafik lines and all hubs by lateness around now', () => {
    const rows = [
      late(8, { line: '6' }),
      late(4, { line: '6' }),
      late(0, { line: '11' }),
      late(0, { line: '11' }),
      dep({ planned: iso(T0), line: '16', cancelled: true }),
      late(1, { line: '16' }),
      late(20, { line: '6', planned: iso(T0 + 3 * HOUR) }), // outside the window
      late(12, {
        source: 'trafikverket',
        mode: 'train',
        line: '3979',
        board: 'Göteborg C',
      }),
      late(30, { mode: 'flight', source: 'swedavia', board: 'Landvetter', line: 'SK123' }),
    ];
    const { lines, hubs } = delayIndex(rows, T0);
    expect(lines.map((l) => l.name)).toEqual(['Tram 16', 'Tram 6']);
    expect(lines[1]).toMatchObject({ departures: 2, late: 2, meanDelayMin: 6, maxDelayMin: 8 });
    expect(lines[0]).toMatchObject({ cancelled: 1, late: 1 });
    expect(hubs.map((h) => h.name)).toEqual(['Göteborg C', 'Centralstationen']);
    expect(
      lateCount(
        rows.filter((r) => r.mode !== 'flight'),
        T0,
      ),
    ).toBe(4);
  });
});

describe('anomaly flags', () => {
  const steady = (n: number) =>
    Array.from({ length: n }, (_, i): [number, number] => [T0 + i * 5 * MIN, [3, 4, 5, 4][i % 4]!]);

  it('needs a few hours of history', () => {
    expect(anomaly([...steady(20), [T0, 40]], 4)).toBeUndefined();
  });

  it('flags values far from the typical level in either direction', () => {
    expect(anomaly([...steady(40), [T0, 20]], 4)).toMatchObject({ value: 20, typical: 4 });
    expect(anomaly([...steady(40), [T0, -20]], 4)?.z).toBeLessThan(0);
  });

  it('ignores changes smaller than the minimum that matters', () => {
    expect(anomaly([...steady(40), [T0, 7]], 4)).toBeUndefined();
    expect(anomaly([...steady(40), [T0, 7]], 1)).toBeDefined();
  });
});

describe('situation brief', () => {
  it('summarises the live picture with targets and statistical flags', () => {
    const store = new ChannelStore();
    const fill = (name: string, kind: ChannelKind, items: ChannelItem[]) => {
      store.register(name, kind, 'test');
      store.replace(name, items);
    };
    fill('events.road', 'events', [
      event({
        id: 'r1',
        severity: 'major',
        title: 'Accident E6',
        geometry: { type: 'Point', coordinates: [11.95, 57.7] },
      }),
      event({ id: 'r2' }),
      event({ id: 'r3', category: 'Vägarbete', severity: 'critical', title: 'Vägarbete: E45' }),
      event({ id: 'r4', severity: 'critical', title: 'Old closure', start: iso(T0 - 48 * HOUR) }),
    ]);
    fill('transit.departures', 'departures', [late(6), late(9)]);
    fill('transit.rail', 'entities', [
      entity({
        id: 'train-1',
        kind: 'train',
        label: 'Train 3979',
        lon: 12,
        lat: 57.8,
        props: { delayMin: 20 },
      }),
      entity({ id: 'train-2', kind: 'train', label: 'Train 100', props: { delayMin: 0 } }),
    ]);
    fill('env.harbour', 'entities', [
      entity({ id: 'viva-1', label: 'Vinga', props: { gustMs: 15 } }),
    ]);
    fill('maritime.expected', 'departures', [
      dep({ planned: iso(T0 + HOUR), mode: 'ship', line: 'STENA DANICA', source: 'ais' }),
      dep({ planned: iso(T0 - 2 * HOUR), mode: 'ship', line: 'OVERDUE', source: 'ais' }),
    ]);
    fill('aviation.metar', 'entities', [
      entity({ id: 'ESGG', label: 'Landvetter', props: { flightCategory: 'IFR', ceilingFt: 400 } }),
    ]);
    fill('env.weather', 'metrics', [metric('71420-temp', 6.5), metric('71420-gust', 16, 'm/s')]);

    const history = new History();
    const points = Array.from({ length: 40 }, (_, i): [number, number] => [
      T0 - (40 - i) * 5 * MIN,
      [3, 4, 5, 4][i % 4]!,
    ]);
    history.restore(
      {
        series: { 'count/events.road': { unit: 'events', points: [...points, [T0, 15]] } },
        tracks: {},
      },
      T0,
    );

    const brief = BriefSchema.parse(buildBrief(store, history, T0));
    const section = (id: string) => brief.sections.find((s) => s.id === id);
    expect(brief.sections.map((s) => s.id)).toEqual([
      'incidents',
      'transit',
      'harbour',
      'airport',
      'weather',
      'flags',
    ]);
    expect(section('incidents')?.items[0]).toMatchObject({
      level: 'warning',
      text: 'Accident E6',
      target: { channel: 'events.road', ids: ['r1'], lon: 11.95, lat: 57.7 },
    });
    expect(section('incidents')?.items.map((i) => i.id)).toEqual(['events.road:r1', 'road-count']);
    expect(section('incidents')?.items[1]).toMatchObject({
      text: '3 traffic messages and 1 roadworks on Trafikverket roads',
      detail: '1 with large impact in the last 6 h',
    });
    expect(section('transit')?.items.find((i) => i.id === 'trains')).toMatchObject({
      level: 'notice',
      text: '1 of 2 trains in the area are 5+ min late; worst Train 3979 +20 min',
      target: { channel: 'transit.rail', ids: ['train-1'], lon: 12, lat: 57.8 },
    });
    expect(section('harbour')?.items.map((i) => i.id)).toEqual(['expected', 'harbour-gust']);
    expect(section('harbour')?.items[0]?.text).toBe(
      '1 ship expected in the next 6 h: STENA DANICA 13:00',
    );
    expect(section('airport')?.items[0]).toMatchObject({ level: 'notice', id: 'metar' });
    expect(section('weather')?.items[0]?.text).toBe('6,5 °C, gusts 16,0 m/s');
    expect(section('flags')?.items[0]?.text).toBe(
      'Unusually many road incidents (Trafikverket): 15, typically 4',
    );
    expect(brief.delays.lines[0]).toMatchObject({ name: 'Tram 6', late: 2 });
    expect(brief.historyHours).toBeCloseTo(3.3, 1);
  });

  it('is empty but valid with no data', () => {
    const brief = buildBrief(new ChannelStore(), new History(), T0);
    expect(BriefSchema.parse(brief)).toMatchObject({ sections: [], historyHours: 0 });
  });
});
