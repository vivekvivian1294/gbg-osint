import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createDiskCache } from '../core/cache';
import type { ConnectorContext } from '../core/connector';
import { parseGibsPath } from './gibs';
import { parseWindGrid, windGridPoints, WIND_GRID } from './openMeteo';
import {
  assessment,
  bathingEntities,
  bathingWaters,
  latestSample,
  parseBathingSites,
  parsePollen,
  parsePollenTypes,
} from './seasonal';
import { parseSensorCommunity } from './sensorCommunity';

describe('Open-Meteo wind grid', () => {
  it('maps multi-point results back to the grid in request order', () => {
    const points = windGridPoints();
    expect(points).toHaveLength(WIND_GRID.rows * WIND_GRID.cols);
    expect(points[0]).toEqual({ row: 0, col: 0, lon: 11.4, lat: 57.4 });
    expect(points.at(-1)).toEqual({ row: 4, col: 6, lon: 12.6, lat: 58 });

    const current = (speed: number | null) => ({
      latitude: 57.39,
      longitude: 11.41,
      current: {
        time: '2026-10-29T10:45',
        wind_speed_10m: speed,
        wind_direction_10m: 270,
        wind_gusts_10m: 12.5,
      },
    });
    const entities = parseWindGrid([current(7.3), current(null), current(5)]);
    expect(entities.map((e) => e.id)).toEqual(['wind-0-0', 'wind-0-2']);
    expect(entities[0]).toMatchObject({
      lon: 11.4,
      lat: 57.4,
      ts: '2026-10-29T10:45:00.000Z',
      props: { windMs: 7.3, windFromDeg: 270, gustMs: 12.5 },
    });
  });
});

describe('Sensor.Community', () => {
  const reading = (
    location: number,
    type: string,
    timestamp: string,
    values: Record<string, string>,
    extra: Record<string, unknown> = {},
  ) => ({
    location: {
      id: location,
      latitude: '57.70234',
      longitude: '11.90461',
      indoor: 0,
      ...extra,
    },
    timestamp,
    sensor: { id: 1, sensor_type: { name: type } },
    sensordatavalues: Object.entries(values).map(([value_type, value]) => ({ value_type, value })),
  });

  it('merges a site’s sensors, keeps the latest values and rounds positions', () => {
    const entities = parseSensorCommunity([
      reading(6127, 'SDS011', '2026-10-29 10:45:00', { P1: '30.0', P2: '18.0' }),
      reading(6127, 'SDS011', '2026-10-29 10:50:00', { P1: '14.7', P2: '2.8' }),
      reading(6127, 'DHT22', '2026-10-29 10:40:00', { temperature: '13.8', humidity: '85.7' }),
      reading(7000, 'SDS011', '2026-10-29 10:50:00', { P1: '5', P2: '3' }, { indoor: 1 }),
      reading(8000, 'BME280', '2026-10-29 10:50:00', { temperature: '12' }),
      reading(9000, 'SDS011', '2026-10-29 10:50:00', { P1: '-4', P2: '2000' }),
    ]);
    expect(entities).toEqual([
      {
        id: 'sc-6127',
        source: 'sensor.community',
        kind: 'sensor',
        lon: 11.905,
        lat: 57.702,
        label: 'Citizen sensor 6127',
        ts: '2026-10-29T10:50:00.000Z',
        props: {
          pm10Ugm3: 14.7,
          pm25Ugm3: 2.8,
          tempC: 13.8,
          humidityPct: 85.7,
          aqi: 1,
          aqiLabel: 'Good',
          sensors: 'DHT22, SDS011',
        },
      },
    ]);
  });
});

describe('pollen forecast', () => {
  const REGION = '2a2a2a2a-2a2a-4a2a-aa2a-2a2a2a303a38';
  const names = parsePollenTypes({
    items: [
      { id: 'p-323332', name: 'Björk' },
      { id: 'p-323433', name: 'Gräs' },
      { id: 'p-323833', name: 'Alternaria' },
    ],
  });
  const forecast = (over: Record<string, unknown>) => ({
    items: [
      {
        regionId: REGION,
        startDate: '2026-05-11',
        endDate: '2026-05-13',
        isEndOfSeason: false,
        levelSeries: [
          { pollenId: 'p-323332', level: 2, time: '2026-05-11T00:00:00' },
          { pollenId: 'p-323332', level: 5, time: '2026-05-12T00:00:00' },
          { pollenId: 'p-323433', level: 0, time: '2026-05-12T00:00:00' },
          { pollenId: 'p-323833', level: 1, time: '2026-05-12T00:00:00' },
        ],
        ...over,
      },
    ],
  });

  it('gives today’s non-zero levels in English, highest first', () => {
    expect(parsePollen(forecast({}), names, '2026-05-12', 'T')).toEqual([
      {
        id: 'pollen-323332',
        source: 'pollenrapporten',
        name: 'Birch pollen',
        unit: 'level',
        value: 5,
        ts: 'T',
      },
      {
        id: 'pollen-323833',
        source: 'pollenrapporten',
        name: 'Alternaria spores',
        unit: 'level',
        value: 1,
        ts: 'T',
      },
    ]);
  });

  it('is empty outside the season or the forecast period', () => {
    expect(parsePollen(forecast({ isEndOfSeason: true }), names, '2026-05-12', 'T')).toEqual([]);
    expect(parsePollen(forecast({}), names, '2026-10-29', 'T')).toEqual([]);
    expect(parsePollen(forecast({ regionId: 'other' }), names, '2026-05-12', 'T')).toEqual([]);
  });
});

describe('bathing waters', () => {
  const site = (id: string, lon: string, lat: string, extra: Record<string, unknown> = {}) => ({
    bathingWater: {
      id,
      name: `Site ${id}`,
      euType: true,
      waterTypeIdText: 'Hav',
      samplingPointPosition: { latitude: lat, longitude: lon },
      municipality: { name: 'Göteborg' },
    },
    adviceAgainstBathing: [],
    abnormalSituations: [],
    ...extra,
  });

  it('keeps sites in the Gothenburg area and turns them into map points', () => {
    const sites = parseBathingSites({
      watersAndAdvisories: [
        site('SE0A21480000000001', '11.7', '57.72', {
          adviceAgainstBathing: [
            { description: 'Dålig badvattenkvalitet', startsAt: '2026-05-13T12:43:58Z' },
          ],
        }),
        site('SE0441264000000306', '13.62', '55.41'),
        site('bad id', '11.8', '57.7'),
        { bathingWater: { id: 'SE0A21480000000002', name: 'No point' } },
      ],
    });
    expect(sites.map((s) => s.bathingWater.id)).toEqual(['SE0A21480000000001']);

    const sample = latestSample({
      results: [
        { takenAt: '2026-07-07T22:00:00Z', sampleAssessIdText: 'Tjänligt' },
        {
          takenAt: '2026-08-03T22:00:00Z',
          sampleAssessIdText: 'Tjänligt m. Anm.',
          algalIdText: 'Ingen blomning',
          escherichiaColiCount: 120,
          intestinalEnterococciCount: 10,
        },
      ],
    });
    const [entity] = bathingEntities(sites, new Map([['SE0A21480000000001', sample ?? null]]), 'T');
    expect(entity).toMatchObject({
      id: 'SE0A21480000000001',
      kind: 'poi',
      lon: 11.7,
      lat: 57.72,
      props: {
        waterType: 'Sea',
        euBathingWater: true,
        adviceAgainstBathing: 'Dålig badvattenkvalitet',
        adviceSince: '2026-05-13T12:43:58Z',
        lastSample: 'Fit, with remarks',
        sampledAt: '2026-08-03T22:00:00.000Z',
        algae: 'No bloom',
        eColiPer100ml: 120,
      },
    });
    expect(latestSample({ results: [] })).toBeUndefined();
  });

  it('reads assessments in full and abbreviated form', () => {
    expect(assessment('Tjänligt')).toBe('Fit for bathing');
    expect(assessment('Tjänligt med anmärkning')).toBe('Fit, with remarks');
    expect(assessment('Otjänligt')).toBe('Unfit for bathing');
    expect(assessment(undefined)).toBe('Not assessed');
  });

  it('caches sample results on disk, so the next poll skips them', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const dir = mkdtempSync(join(tmpdir(), 'hav-'));
    const calls: string[] = [];
    const published: unknown[][] = [];
    const warn = vi.fn();
    const ctx = {
      http: {
        getJson: async (url: string) => {
          calls.push(url);
          return url.endsWith('/results')
            ? { results: [{ takenAt: '2026-08-03T22:00:00Z', sampleAssessIdText: 'Tjänligt' }] }
            : { watersAndAdvisories: [site('SE0A21480000000001', '11.7', '57.72')] };
        },
      },
      publish: { replace: (_: string, items: unknown[]) => published.push(items) },
      cache: createDiskCache(dir, 'hav.bathingwaters'),
      log: { warn },
      env: {},
      signal: new AbortController().signal,
      health: { ok: () => undefined, fail: () => undefined },
    } as unknown as ConnectorContext;
    const poll = async () => {
      let done = false;
      const run = bathingWaters.poll(ctx).finally(() => (done = true));
      while (!done) {
        await new Promise((r) => setImmediate(r));
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await run;
    };
    try {
      await poll();
      await poll();
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(warn).not.toHaveBeenCalled();
    expect(calls.filter((u) => u.endsWith('/results'))).toHaveLength(1);
    expect(published.at(-1)).toEqual([
      expect.objectContaining({
        props: expect.objectContaining({ lastSample: 'Fit for bathing' }),
      }),
    ]);
  });
});

describe('NASA GIBS tiles', () => {
  const now = Date.parse('2026-10-29T12:00:00Z');

  it('accepts recent tiles over Scandinavia only', () => {
    expect(parseGibsPath('viirs/2026-10-28/9/273/146.jpg', now)).toEqual({
      date: '2026-10-28',
      z: 9,
      x: 273,
      y: 146,
    });
    expect(parseGibsPath('viirs/2026-10-28/0/0/0.jpg', now)).toBeDefined();
    for (const path of [
      'viirs/2026-10-30/9/273/146.jpg',
      'viirs/2026-08-01/9/273/146.jpg',
      'viirs/2026-10-28/9/10/10.jpg',
      'viirs/2026-10-28/9/600/146.jpg',
      'viirs/2026-10-28/10/546/292.jpg',
      'viirs/2026-13-45/9/273/146.jpg',
      'viirs/../9/273/146.jpg',
    ]) {
      expect(parseGibsPath(path, now), path).toBeUndefined();
    }
  });
});
