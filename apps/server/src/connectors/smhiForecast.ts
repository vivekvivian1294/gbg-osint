import { GOTHENBURG, type Metric } from '@gbg-osint/shared';
import { z } from 'zod';
import type { PollConnector } from '../core/connector';

const CHANNEL = 'env.forecast';
const HORIZON_MS = 12 * 3600_000;

const Step = z.object({
  time: z.string(),
  intervalParametersStartTime: z.string().optional(),
  data: z.object({
    air_temperature: z.number().optional(),
    wind_speed_of_gust: z.number().optional(),
    precipitation_amount_mean: z.number().optional(),
  }),
});
const Forecast = z.object({ referenceTime: z.string(), timeSeries: z.array(Step) });

/** Summary of the next 12 hours: temperature range, total precipitation and strongest gust. */
export function forecastMetrics(raw: unknown, now: number): Metric[] {
  const forecast = Forecast.parse(raw);
  const steps = forecast.timeSeries.filter((s) => {
    const t = Date.parse(s.time);
    return t > now && t <= now + HORIZON_MS;
  });
  if (steps.length === 0) return [];

  const temps = steps.flatMap((s) => s.data.air_temperature ?? []);
  const gusts = steps.flatMap((s) => s.data.wind_speed_of_gust ?? []);
  // precipitation_amount_mean is an hourly rate over each step's interval.
  const precip = steps.reduce((sum, s) => {
    const start = s.intervalParametersStartTime ? Date.parse(s.intervalParametersStartTime) : NaN;
    const hours = Number.isNaN(start) ? 1 : (Date.parse(s.time) - start) / 3600_000;
    return sum + (s.data.precipitation_amount_mean ?? 0) * hours;
  }, 0);

  const base = {
    source: 'smhi',
    ts: new Date(forecast.referenceTime).toISOString(),
    lon: GOTHENBURG.center.lon,
    lat: GOTHENBURG.center.lat,
  };
  const metrics: Metric[] = [];
  if (temps.length > 0) {
    metrics.push(
      {
        ...base,
        id: 'fc12-temp-min',
        name: 'Next 12 h low',
        unit: '°C',
        value: Math.min(...temps),
      },
      {
        ...base,
        id: 'fc12-temp-max',
        name: 'Next 12 h high',
        unit: '°C',
        value: Math.max(...temps),
      },
    );
  }
  metrics.push({
    ...base,
    id: 'fc12-precip',
    name: 'Next 12 h rain',
    unit: 'mm',
    value: Math.round(precip * 10) / 10,
  });
  if (gusts.length > 0) {
    metrics.push({
      ...base,
      id: 'fc12-gust',
      name: 'Next 12 h max gust',
      unit: 'm/s',
      value: Math.max(...gusts),
    });
  }
  return metrics;
}

export const smhiForecast: PollConnector = {
  id: 'smhi.forecast',
  name: 'SMHI – prognos',
  licence: 'CC BY 4.0',
  attribution: 'SMHI',
  homepage: 'https://opendata.smhi.se/',
  mode: 'poll',
  intervalMs: 30 * 60_000,
  allowedHosts: ['opendata-download-metfcst.smhi.se'],
  channels: [{ name: CHANNEL, kind: 'metrics' }],
  async poll(ctx) {
    const { lon, lat } = GOTHENBURG.center;
    const raw = await ctx.http.getJson(
      `https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/geotype/point/lon/${lon.toFixed(4)}/lat/${lat.toFixed(4)}/data.json`,
    );
    ctx.publish.replace(CHANNEL, forecastMetrics(raw, Date.now()));
  },
};
