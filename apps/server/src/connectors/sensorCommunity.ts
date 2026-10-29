import { GOTHENBURG, type Entity } from '@gbg-osint/shared';
import { z } from 'zod';
import type { PollConnector } from '../core/connector';
import { airQualityIndex, EAQI_LABELS } from './goteborg';

const HOST = 'data.sensor.community';
const CHANNEL = 'env.air-quality-community';
const RADIUS_KM = 20;
/** Locations are published to 3 decimals (about 100 m); never show them more precisely. */
const round3 = (v: number) => Math.round(v * 1000) / 1000;

const Reading = z.object({
  location: z.object({
    id: z.number().int(),
    latitude: z.string(),
    longitude: z.string(),
    indoor: z.number().optional(),
  }),
  timestamp: z.string(),
  sensor: z.object({ sensor_type: z.object({ name: z.string().max(40) }) }),
  sensordatavalues: z.array(z.object({ value_type: z.string(), value: z.string() })),
});

/** Sensor value types and the ranges we accept (outside them a sensor is faulty). */
const VALUES: Record<string, { prop: string; min: number; max: number }> = {
  P2: { prop: 'pm25Ugm3', min: 0, max: 999 },
  P1: { prop: 'pm10Ugm3', min: 0, max: 999 },
  temperature: { prop: 'tempC', min: -40, max: 50 },
  humidity: { prop: 'humidityPct', min: 0, max: 100 },
};

/** One entity per outdoor location with particulate readings, merged across its sensors. */
export function parseSensorCommunity(raw: unknown): Entity[] {
  const sites = new Map<
    number,
    {
      lon: number;
      lat: number;
      ts: number;
      types: Set<string>;
      props: Record<string, number>;
      propTs: Record<string, number>;
    }
  >();
  for (const item of Array.isArray(raw) ? raw : []) {
    const parsed = Reading.safeParse(item);
    if (!parsed.success || parsed.data.location.indoor === 1) continue;
    const r = parsed.data;
    const lon = round3(Number(r.location.longitude));
    const lat = round3(Number(r.location.latitude));
    const ts = Date.parse(`${r.timestamp.replace(' ', 'T')}Z`);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(ts)) continue;
    let site = sites.get(r.location.id);
    if (!site) {
      site = { lon, lat, ts, types: new Set(), props: {}, propTs: {} };
      sites.set(r.location.id, site);
    }
    // The API returns several 5-minute readings per sensor; keep each value's latest.
    site.ts = Math.max(site.ts, ts);
    site.types.add(r.sensor.sensor_type.name);
    for (const { value_type, value } of r.sensordatavalues) {
      const spec = VALUES[value_type];
      const v = Number(value);
      if (!spec || !Number.isFinite(v) || v < spec.min || v > spec.max) continue;
      if (ts >= (site.propTs[spec.prop] ?? -Infinity)) {
        site.props[spec.prop] = Math.round(v * 10) / 10;
        site.propTs[spec.prop] = ts;
      }
    }
  }
  return [...sites].flatMap(([id, s]) => {
    if (s.props.pm25Ugm3 === undefined && s.props.pm10Ugm3 === undefined) return [];
    const aqi = airQualityIndex({
      ...(s.props.pm25Ugm3 !== undefined && { pm25Ugm3: s.props.pm25Ugm3 }),
      ...(s.props.pm10Ugm3 !== undefined && { pm10Ugm3: s.props.pm10Ugm3 }),
    });
    return [
      {
        id: `sc-${id}`,
        source: 'sensor.community',
        kind: 'sensor' as const,
        lon: s.lon,
        lat: s.lat,
        label: `Citizen sensor ${id}`,
        ts: new Date(s.ts).toISOString(),
        props: {
          ...s.props,
          ...(aqi !== undefined && { aqi, aqiLabel: EAQI_LABELS[aqi - 1] }),
          sensors: [...s.types].sort().join(', '),
        },
      },
    ];
  });
}

export const sensorCommunity: PollConnector = {
  id: 'sensorcommunity.air',
  name: 'Sensor.Community – citizen air sensors',
  licence: 'ODbL 1.0',
  attribution: 'Sensor.Community contributors',
  homepage: 'https://sensor.community/',
  mode: 'poll',
  intervalMs: 5 * 60_000,
  allowedHosts: [HOST],
  channels: [{ name: CHANNEL, kind: 'entities' }],
  async poll(ctx) {
    const { lat, lon } = GOTHENBURG.center;
    const raw = await ctx.http.getJson(
      `https://${HOST}/airrohr/v1/filter/area=${lat},${lon},${RADIUS_KM}`,
      { timeoutMs: 30_000 },
    );
    ctx.publish.replace(CHANNEL, parseSensorCommunity(raw));
  },
};
