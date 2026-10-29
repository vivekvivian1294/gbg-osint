import type { Entity } from '@gbg-osint/shared';
import { z } from 'zod';
import type { PollConnector } from '../core/connector';

const HOST = 'api.open-meteo.com';
const CHANNEL = 'env.wind';

/** A regular grid over the Gothenburg region, about 13 × 17 km between points. */
export const WIND_GRID = {
  west: 11.4,
  south: 57.4,
  stepLon: 0.2,
  stepLat: 0.15,
  cols: 7,
  rows: 5,
} as const;

export function windGridPoints(): { row: number; col: number; lon: number; lat: number }[] {
  const g = WIND_GRID;
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return Array.from({ length: g.rows * g.cols }, (_, i) => {
    const row = Math.floor(i / g.cols);
    const col = i % g.cols;
    return {
      row,
      col,
      lon: round(g.west + col * g.stepLon),
      lat: round(g.south + row * g.stepLat),
    };
  });
}

const Current = z.object({
  current: z.object({
    time: z.string(),
    wind_speed_10m: z.number().nullable(),
    wind_direction_10m: z.number().nullable(),
    wind_gusts_10m: z.number().nullable().optional(),
  }),
});

/** Open-Meteo answers a multi-point request with one result per point, in request order. */
export function parseWindGrid(raw: unknown): Entity[] {
  const results = z.array(Current).parse(Array.isArray(raw) ? raw : [raw]);
  const points = windGridPoints();
  return results.flatMap((r, i) => {
    const p = points[i];
    const c = r.current;
    if (!p || c.wind_speed_10m === null || c.wind_direction_10m === null) return [];
    const ts = Date.parse(`${c.time}Z`);
    return [
      {
        id: `wind-${p.row}-${p.col}`,
        source: 'open-meteo',
        kind: 'sensor' as const,
        lon: p.lon,
        lat: p.lat,
        label: 'Wind model grid point',
        ts: new Date(Number.isFinite(ts) ? ts : Date.now()).toISOString(),
        props: {
          windMs: c.wind_speed_10m,
          windFromDeg: c.wind_direction_10m,
          ...(typeof c.wind_gusts_10m === 'number' && { gustMs: c.wind_gusts_10m }),
        },
      },
    ];
  });
}

export const openMeteoWind: PollConnector = {
  id: 'openmeteo.wind',
  name: 'Open-Meteo – wind field',
  licence: 'CC BY 4.0',
  attribution: 'Weather data by Open-Meteo.com',
  homepage: 'https://open-meteo.com/',
  mode: 'poll',
  // The model's "current" values are updated every 15 minutes.
  intervalMs: 15 * 60_000,
  allowedHosts: [HOST],
  channels: [{ name: CHANNEL, kind: 'entities' }],
  async poll(ctx) {
    const points = windGridPoints();
    const query = new URLSearchParams({
      latitude: points.map((p) => p.lat).join(','),
      longitude: points.map((p) => p.lon).join(','),
      current: 'wind_speed_10m,wind_direction_10m,wind_gusts_10m',
      wind_speed_unit: 'ms',
    });
    const raw = await ctx.http.getJson(`https://${HOST}/v1/forecast?${query}`, {
      timeoutMs: 20_000,
    });
    ctx.publish.replace(CHANNEL, parseWindGrid(raw));
  },
};
