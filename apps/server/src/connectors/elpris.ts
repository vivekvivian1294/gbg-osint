import type { Metric } from '@gbg-osint/shared';
import { z } from 'zod';
import type { PollConnector } from '../core/connector';
import { localDate } from './util';

const CHANNEL = 'energy.price-se3';

const Prices = z.array(
  z.object({ SEK_per_kWh: z.number(), time_start: z.string(), time_end: z.string() }),
);

/** Current spot price plus today's min and max, in SEK/kWh excluding VAT and fees. */
export function priceMetrics(raw: unknown, now: number): Metric[] {
  const prices = Prices.parse(raw);
  if (prices.length === 0) return [];
  const base = { source: 'elprisetjustnu', unit: 'SEK/kWh' } as const;
  const metrics: Metric[] = [];
  const current = prices.find(
    (p) => Date.parse(p.time_start) <= now && now < Date.parse(p.time_end),
  );
  if (current) {
    metrics.push({
      ...base,
      id: 'se3-now',
      name: 'Spot price SE3',
      value: current.SEK_per_kWh,
      ts: new Date(current.time_start).toISOString(),
    });
  }
  const values = prices.map((p) => p.SEK_per_kWh);
  const ts = new Date(prices[0]!.time_start).toISOString();
  metrics.push(
    { ...base, id: 'se3-min', name: 'SE3 today min', value: Math.min(...values), ts },
    { ...base, id: 'se3-max', name: 'SE3 today max', value: Math.max(...values), ts },
  );
  return metrics;
}

export const elpris: PollConnector = {
  id: 'elpris.se3',
  name: 'Elpriset just nu (SE3)',
  licence: 'Free to use with attribution',
  attribution: 'Elpriset just nu.se',
  homepage: 'https://www.elprisetjustnu.se/',
  mode: 'poll',
  intervalMs: 15 * 60_000,
  allowedHosts: ['www.elprisetjustnu.se'],
  channels: [{ name: CHANNEL, kind: 'metrics' }],
  async poll(ctx) {
    const now = Date.now();
    const date = localDate(new Date(now));
    const raw = await ctx.http.getJson(
      `https://www.elprisetjustnu.se/api/v1/prices/${date.slice(0, 4)}/${date.slice(5)}_SE3.json`,
    );
    ctx.publish.replace(CHANNEL, priceMetrics(raw, now));
  },
};
