import type { Metric } from '@gbg-osint/shared';
import { z } from 'zod';
import type { PollConnector } from '../core/connector';

const WEATHER_CHANNEL = 'env.weather';
const SEA_CHANNEL = 'env.sea-level';

const STATION = { key: '71420', name: 'Göteborg A', lon: 11.9924, lat: 57.7156 };

/** SMHI metobs parameter keys for the hourly observations we show. */
const WEATHER_PARAMS = [
  { key: 1, id: 'temp', name: 'Temperature', unit: '°C' },
  { key: 4, id: 'wind', name: 'Wind', unit: 'm/s' },
  { key: 21, id: 'gust', name: 'Gusts', unit: 'm/s' },
  { key: 3, id: 'wind-dir', name: 'Wind direction', unit: '°' },
  { key: 6, id: 'humidity', name: 'Humidity', unit: '%' },
  { key: 7, id: 'precip', name: 'Precipitation (1 h)', unit: 'mm' },
  { key: 9, id: 'pressure', name: 'Pressure', unit: 'hPa' },
] as const;

const SEA_STATIONS = [
  { key: '35120', id: 'tangudden', name: 'Sea level (Tångudden)', lon: 11.8722, lat: 57.6821 },
  { key: '33097', id: 'hisingsbron', name: 'Göta älv (Hisingsbron)', lon: 11.9687, lat: 57.7149 },
] as const;

const Observations = z.object({
  value: z
    .array(z.object({ date: z.number(), value: z.union([z.string(), z.number()]) }))
    .nullish(),
});

/** Latest value of an SMHI observation series, or undefined if there is none. */
export function latestObservation(raw: unknown): { ts: string; value: number } | undefined {
  const parsed = Observations.safeParse(raw);
  const last = parsed.success ? parsed.data.value?.at(-1) : undefined;
  if (!last || String(last.value).trim() === '') return undefined;
  const value = Number(last.value);
  return Number.isFinite(value) ? { ts: new Date(last.date).toISOString(), value } : undefined;
}

export const smhiObservations: PollConnector = {
  id: 'smhi.observations',
  name: 'SMHI – väderobservationer',
  licence: 'CC BY 4.0',
  attribution: 'SMHI',
  homepage: 'https://opendata.smhi.se/',
  mode: 'poll',
  intervalMs: 10 * 60_000,
  allowedHosts: ['opendata-download-metobs.smhi.se'],
  channels: [{ name: WEATHER_CHANNEL, kind: 'metrics' }],
  async poll(ctx) {
    const results = await Promise.allSettled(
      WEATHER_PARAMS.map(async (p): Promise<Metric | undefined> => {
        const raw = await ctx.http.getJson(
          `https://opendata-download-metobs.smhi.se/api/version/latest/parameter/${p.key}/station/${STATION.key}/period/latest-hour/data.json`,
        );
        const latest = latestObservation(raw);
        return (
          latest && {
            id: `${STATION.key}-${p.id}`,
            source: 'smhi',
            name: p.name,
            unit: p.unit,
            value: latest.value,
            ts: latest.ts,
            lon: STATION.lon,
            lat: STATION.lat,
          }
        );
      }),
    );
    const metrics = results.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
    const failed = results.find((r) => r.status === 'rejected');
    if (metrics.length === 0 && failed) throw failed.reason;
    ctx.publish.apply(WEATHER_CHANNEL, metrics);
  },
};

export const smhiSeaLevel: PollConnector = {
  id: 'smhi.sealevel',
  name: 'SMHI – vattenstånd',
  licence: 'CC BY 4.0',
  attribution: 'SMHI',
  homepage: 'https://opendata.smhi.se/',
  mode: 'poll',
  intervalMs: 15 * 60_000,
  allowedHosts: ['opendata-download-ocobs.smhi.se'],
  channels: [{ name: SEA_CHANNEL, kind: 'metrics' }],
  async poll(ctx) {
    const results = await Promise.allSettled(
      SEA_STATIONS.map(async (s): Promise<Metric | undefined> => {
        const raw = await ctx.http.getJson(
          `https://opendata-download-ocobs.smhi.se/api/version/latest/parameter/6/station/${s.key}/period/latest-day/data.json`,
        );
        const latest = latestObservation(raw);
        return (
          latest && {
            id: `${s.key}-${s.id}`,
            source: 'smhi',
            name: s.name,
            unit: 'cm',
            value: latest.value,
            ts: latest.ts,
            lon: s.lon,
            lat: s.lat,
          }
        );
      }),
    );
    const metrics = results.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
    const failed = results.find((r) => r.status === 'rejected');
    if (metrics.length === 0 && failed) throw failed.reason;
    ctx.publish.apply(SEA_CHANNEL, metrics);
  },
};
