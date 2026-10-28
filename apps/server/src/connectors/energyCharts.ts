import type { Metric } from '@gbg-osint/shared';
import { z } from 'zod';
import type { PollConnector } from '../core/connector';
import { UpstreamError } from '../core/http';

const CHANNEL = 'energy.mix-se';
const SOURCE_URL = 'https://api.energy-charts.info/public_power?country=se';

const Response = z.object({
  unix_seconds: z.array(z.number()),
  production_types: z.array(z.object({ name: z.string(), data: z.array(z.number().nullable()) })),
});

/** Energy-Charts production types grouped into the few that matter in Sweden. */
const GROUPS: Record<string, string> = {
  Nuclear: 'Nuclear',
  'Hydro water reservoir': 'Hydro',
  'Hydro Run-of-River': 'Hydro',
  'Hydro pumped storage': 'Hydro',
  'Wind onshore': 'Wind',
  'Wind offshore': 'Wind',
  Solar: 'Solar',
};
const NOT_GENERATION = new Set([
  'Load',
  'Residual load',
  'Cross border electricity trading',
  'Renewable share of load',
  'Renewable share of generation',
  'Hydro pumped storage consumption',
]);
const ORDER = ['Hydro', 'Nuclear', 'Wind', 'Solar', 'Other'];

/** Latest quarter-hour of Swedish generation by source (GW), demand and trade. */
export function energyMixMetrics(raw: unknown): Metric[] {
  const { unix_seconds: times, production_types: types } = Response.parse(raw);
  const load = types.find((t) => t.name === 'Load')?.data ?? [];
  let i = times.length - 1;
  while (i >= 0 && (load[i] ?? null) === null) i--;
  if (i < 0) return [];
  const ts = new Date(times[i]! * 1000).toISOString();
  const at = (name: string) => types.find((t) => t.name === name)?.data[i] ?? undefined;

  const groups = new Map<string, number>();
  for (const t of types) {
    const value = t.data[i];
    if (NOT_GENERATION.has(t.name) || value === null || value === undefined) continue;
    const group = GROUPS[t.name] ?? 'Other';
    groups.set(group, (groups.get(group) ?? 0) + value);
  }
  const base = { source: 'energy-charts', ts } as const;
  const metrics: Metric[] = ORDER.filter((g) => groups.has(g)).map((g) => ({
    ...base,
    id: `se-${g.toLowerCase()}`,
    name: g,
    unit: 'GW',
    value: Math.round(groups.get(g)! / 100) / 10,
  }));
  metrics.push({
    ...base,
    id: 'se-load',
    name: 'Demand',
    unit: 'GW',
    value: Math.round(load[i]! / 100) / 10,
  });
  const trade = at('Cross border electricity trading');
  if (trade !== undefined) {
    // Energy-Charts reports imports as positive.
    metrics.push({
      ...base,
      id: 'se-trade',
      name: trade <= 0 ? 'Net export' : 'Net import',
      unit: 'GW',
      value: Math.round(Math.abs(trade) / 100) / 10,
    });
  }
  const renewable = at('Renewable share of generation');
  if (renewable !== undefined) {
    metrics.push({
      ...base,
      id: 'se-renewable',
      name: 'Renewable share',
      unit: '%',
      value: renewable,
    });
  }
  return metrics;
}

export const energyChartsSweden: PollConnector = {
  id: 'energycharts.se',
  name: 'Energy-Charts – Swedish electricity mix',
  licence: 'CC BY 4.0',
  attribution: 'Energy-Charts (Fraunhofer ISE), data ENTSO-E',
  homepage: 'https://www.energy-charts.info/',
  mode: 'poll',
  intervalMs: 15 * 60_000,
  allowedHosts: ['api.energy-charts.info'],
  channels: [{ name: CHANNEL, kind: 'metrics' }],
  async poll(ctx) {
    const metrics = energyMixMetrics(await ctx.http.getJson(SOURCE_URL, { timeoutMs: 30_000 }));
    if (metrics.length === 0) throw new UpstreamError('No recent Energy-Charts values');
    ctx.publish.replace(CHANNEL, metrics);
  },
};
