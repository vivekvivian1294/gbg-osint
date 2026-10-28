import { GOTHENBURG, type GeoEvent, type LocationPrecision } from '@gbg-osint/shared';
import { z } from 'zod';
import type { PollConnector } from '../core/connector';
import { truncate } from './util';

const CHANNEL = 'events.crisis';

const Area = z.object({ type: z.string(), description: z.string() });
const Item = z.object({
  identifier: z.union([z.string(), z.number()]),
  published: z.string(),
  headline: z.string().min(1),
  preamble: z.string().nullish(),
  web: z.string().nullish(),
  area: z.array(Area).nullish(),
});
const Response = z.array(z.unknown());

/** Which areas are relevant to Gothenburg, and how precisely they locate the item. */
function relevance(areas: readonly z.infer<typeof Area>[]): LocationPrecision | undefined {
  let best: LocationPrecision | undefined;
  for (const a of areas) {
    const type = a.type.toLowerCase();
    const name = a.description.trim();
    if (type === 'municipality' && name === 'Göteborg') return 'municipality';
    if (type === 'county' && name.startsWith('Västra Götaland')) best = 'region';
    if (type === 'country' && name === 'Sverige') best ??= 'none';
  }
  return best;
}

export function parseCrisisItems(raw: unknown[], kind: 'news' | 'vma'): GeoEvent[] {
  const events: GeoEvent[] = [];
  for (const item of raw) {
    const parsed = Item.safeParse(item);
    if (!parsed.success) continue;
    const i = parsed.data;
    const precision = relevance(i.area ?? []);
    if (!precision || Number.isNaN(Date.parse(i.published))) continue;
    events.push({
      id: `${kind}-${i.identifier}`,
      source: 'krisinformation',
      category: kind === 'vma' ? 'VMA' : 'Krisinformation',
      severity: kind === 'vma' ? 'critical' : 'info',
      title: truncate(i.headline, 300),
      ...(i.preamble && { body: truncate(i.preamble, 1000) }),
      ...(precision === 'municipality' && {
        geometry: { type: 'Point', coordinates: [GOTHENBURG.center.lon, GOTHENBURG.center.lat] },
      }),
      locationPrecision: precision,
      start: new Date(i.published).toISOString(),
      ...(i.web?.startsWith('https://') && { url: i.web }),
    });
  }
  return events;
}

export const krisinformation: PollConnector = {
  id: 'krisinformation.news',
  name: 'Krisinformation.se',
  licence: 'Open data (terms at source)',
  homepage: 'https://www.krisinformation.se/',
  mode: 'poll',
  intervalMs: 5 * 60_000,
  allowedHosts: ['api.krisinformation.se'],
  channels: [{ name: CHANNEL, kind: 'events' }],
  async poll(ctx) {
    const [news, vmas] = await Promise.all([
      ctx.http.getJson('https://api.krisinformation.se/v3/news?days=7'),
      ctx.http.getJson('https://api.krisinformation.se/v3/vmas'),
    ]);
    ctx.publish.replace(CHANNEL, [
      ...parseCrisisItems(Response.parse(vmas), 'vma'),
      ...parseCrisisItems(Response.parse(news), 'news'),
    ]);
  },
};
