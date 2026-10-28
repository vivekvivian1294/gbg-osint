import type { GeoEvent } from '@gbg-osint/shared';
import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PollConnector } from '../core/connector';
import { UpstreamError } from '../core/http';
import { toPlainText, truncate } from './util';

const CHANNEL = 'events.news';
const MAX_ITEMS_PER_FEED = 25;

const FEEDS = [
  { id: 'svt-vast', name: 'SVT Väst', url: 'https://www.svt.se/nyheter/lokalt/vast/rss.xml' },
  { id: 'gp', name: 'Göteborgs-Posten', url: 'https://www.gp.se/rss' },
] as const;

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  htmlEntities: true,
  isArray: (name) => name === 'item',
});

const Item = z.object({
  title: z.string().min(1),
  link: z.url({ protocol: /^https$/ }),
  description: z.string().optional(),
  pubDate: z.string(),
});
const Rss = z.object({ rss: z.object({ channel: z.object({ item: z.array(z.unknown()) }) }) });

/** Headline, short plain-text snippet and link only; article text is never stored. */
export function parseFeed(xml: string, feed: { id: string; name: string }): GeoEvent[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new UpstreamError(`Rejected ${feed.name} feed containing a DTD`);
  }
  const doc = Rss.safeParse(parser.parse(xml));
  if (!doc.success) throw new UpstreamError(`Unexpected ${feed.name} feed format`);
  const events: GeoEvent[] = [];
  for (const raw of doc.data.rss.channel.item.slice(0, MAX_ITEMS_PER_FEED)) {
    const parsed = Item.safeParse(raw);
    if (!parsed.success) continue;
    const item = parsed.data;
    const published = Date.parse(item.pubDate);
    const title = toPlainText(item.title);
    if (Number.isNaN(published) || !title) continue;
    const snippet = item.description ? toPlainText(item.description) : '';
    events.push({
      id: `${feed.id}-${createHash('sha256').update(item.link).digest('hex').slice(0, 16)}`,
      source: 'rss',
      category: feed.name,
      severity: 'info',
      title: truncate(title, 300),
      ...(snippet && { body: truncate(snippet, 280) }),
      locationPrecision: 'none',
      start: new Date(published).toISOString(),
      url: item.link,
    });
  }
  return events;
}

const lastGood = new Map<string, GeoEvent[]>();

export const rssNews: PollConnector = {
  id: 'rss.news',
  name: 'Local news (RSS)',
  licence: '© publishers – headlines and links only',
  mode: 'poll',
  intervalMs: 10 * 60_000,
  allowedHosts: ['www.svt.se', 'www.gp.se'],
  channels: [{ name: CHANNEL, kind: 'events' }],
  async poll(ctx) {
    const results = await Promise.allSettled(
      FEEDS.map(async (feed) => {
        const events = parseFeed(await ctx.http.getText(feed.url, { maxBytes: 2_000_000 }), feed);
        lastGood.set(feed.id, events);
      }),
    );
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length === FEEDS.length) throw failed[0]!.reason;
    for (const f of failed) ctx.log.warn({ err: f.reason }, 'news feed failed');
    ctx.publish.replace(CHANNEL, [...lastGood.values()].flat());
  },
};
