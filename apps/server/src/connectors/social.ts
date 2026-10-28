import type { GeoEvent } from '@gbg-osint/shared';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PollConnector } from '../core/connector';
import { toPlainText, truncate } from './util';

const CHANNEL = 'events.social';
const MAX_POSTS = 40;
const MAX_AGE_MS = 48 * 3600_000;
const TITLE_MAX = 160;
const BODY_MAX = 300;
const BLUESKY_HOST = 'api.bsky.app';
const BLUESKY_QUERIES = ['Göteborg', 'Gothenburg'];
const MASTODON_HOST = 'mastodon.social';
const MASTODON_TAGS = ['goteborg', 'göteborg', 'gothenburg'];
/** Self-applied or moderation labels we never show. */
const HIDDEN_LABELS = new Set([
  'porn',
  'sexual',
  'nudity',
  'graphic-media',
  'gore',
  '!hide',
  '!warn',
]);

const hashId = (prefix: string, url: string) =>
  `${prefix}-${createHash('sha256').update(url).digest('hex').slice(0, 16)}`;

/** Only text, time and a link; author names and handles are deliberately not kept. */
function post(prefix: string, category: string, text: string, url: string, created: string) {
  const ms = Date.parse(created);
  if (!text || Number.isNaN(ms)) return undefined;
  const event: GeoEvent = {
    id: hashId(prefix, url),
    source: prefix === 'bsky' ? 'bluesky' : 'mastodon',
    category,
    severity: 'info',
    title: truncate(text, TITLE_MAX),
    ...(text.length > TITLE_MAX && { body: truncate(text, BODY_MAX) }),
    locationPrecision: 'none',
    start: new Date(ms).toISOString(),
    url,
  };
  return event;
}

const Label = z.object({ val: z.string() });
const BlueskyPost = z.object({
  uri: z.string().regex(/^at:\/\/did:[a-z0-9]+:[\w.:%-]+\/app\.bsky\.feed\.post\/[\w-]+$/i),
  author: z.object({ did: z.string(), labels: z.array(Label).optional() }),
  record: z.object({ text: z.string(), createdAt: z.string() }),
  labels: z.array(Label).optional(),
});
const BlueskySearch = z.object({ posts: z.array(z.unknown()) });

export function parseBluesky(raw: unknown): GeoEvent[] {
  const events: GeoEvent[] = [];
  for (const item of BlueskySearch.parse(raw).posts) {
    const parsed = BlueskyPost.safeParse(item);
    if (!parsed.success) continue;
    const p = parsed.data;
    const labels = [...(p.labels ?? []), ...(p.author.labels ?? [])];
    if (labels.some((l) => HIDDEN_LABELS.has(l.val))) continue;
    const [, , did, , rkey] = p.uri.split('/');
    const url = `https://bsky.app/profile/${did}/post/${rkey}`;
    const text = p.record.text.replace(/\s+/g, ' ').trim();
    const event = post('bsky', 'Bluesky', text, url, p.record.createdAt);
    if (event) events.push(event);
  }
  return events;
}

const MastodonStatus = z.object({
  created_at: z.string(),
  url: z.url({ protocol: /^https$/ }),
  content: z.string(),
  sensitive: z.boolean(),
  spoiler_text: z.string(),
  account: z.object({ bot: z.boolean().optional() }),
});

export function parseMastodon(raw: unknown): GeoEvent[] {
  const events: GeoEvent[] = [];
  for (const item of z.array(z.unknown()).parse(raw)) {
    const parsed = MastodonStatus.safeParse(item);
    if (!parsed.success) continue;
    const s = parsed.data;
    if (s.sensitive || s.spoiler_text || s.account.bot) continue;
    const event = post('masto', 'Mastodon', toPlainText(s.content), s.url, s.created_at);
    if (event) events.push(event);
  }
  return events;
}

/** Newest first, de-duplicated by link, within the last two days. */
export function mergePosts(lists: readonly GeoEvent[][], now: number): GeoEvent[] {
  const seen = new Set<string>();
  return lists
    .flat()
    .filter((e) => now - Date.parse(e.start) <= MAX_AGE_MS && !seen.has(e.id) && seen.add(e.id))
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start))
    .slice(0, MAX_POSTS);
}

export const socialPosts: PollConnector = {
  id: 'social.posts',
  name: 'Social posts (Bluesky, Mastodon)',
  licence: '© post authors – short excerpts and links only',
  attribution: 'Bluesky, mastodon.social',
  homepage: 'https://bsky.app/',
  mode: 'poll',
  intervalMs: 5 * 60_000,
  allowedHosts: [BLUESKY_HOST, MASTODON_HOST],
  channels: [{ name: CHANNEL, kind: 'events' }],
  async poll(ctx) {
    const requests = [
      ...BLUESKY_QUERIES.map(async (q) =>
        parseBluesky(
          await ctx.http.getJson(
            `https://${BLUESKY_HOST}/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&sort=latest&limit=25`,
          ),
        ),
      ),
      ...MASTODON_TAGS.map(async (tag) =>
        parseMastodon(
          await ctx.http.getJson(
            `https://${MASTODON_HOST}/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=20`,
          ),
        ),
      ),
    ];
    const results = await Promise.allSettled(requests);
    const ok = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    const failed = results.filter((r) => r.status === 'rejected');
    if (ok.length === 0) throw failed[0]!.reason;
    for (const f of failed) ctx.log.warn({ err: f.reason }, 'social source failed');
    ctx.publish.replace(CHANNEL, mergePosts(ok, Date.now()));
  },
};
