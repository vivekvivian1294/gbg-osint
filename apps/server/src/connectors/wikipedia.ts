import { GOTHENBURG, type WikiNearby } from '@gbg-osint/shared';
import { z } from 'zod';
import type { OnDemandConnector } from '../core/connector';
import { truncate } from './util';

const LANGS = ['sv', 'en'] as const;
type Lang = (typeof LANGS)[number];
const HOSTS = LANGS.map((l) => `${l}.wikipedia.org`);
/** `nearby/<lang>/<lat>/<lon>.json`, coordinates rounded to 3 decimals (about 100 m). */
const NEARBY_PATH = /^nearby\/(sv|en)\/(-?\d{1,2}\.\d{3})\/(-?\d{1,3}\.\d{3})\.json$/;
const RADIUS_M = 1_000;
const LIMIT = 8;
const MARGIN_DEG = 0.3;
/** Wikimedia allows more, but a research tool has no reason to be quick about it. */
const MIN_INTERVAL_MS = 500;
const MAX_CACHED = 500;
const CACHE_TTL_MS = 24 * 3600_000;

const Geosearch = z.object({
  query: z
    .object({
      geosearch: z.array(z.object({ title: z.string().min(1), dist: z.number().nonnegative() })),
    })
    .optional(),
});

export function parseNearbyPath(
  path: string,
): { lang: Lang; lat: number; lon: number } | undefined {
  const m = NEARBY_PATH.exec(path);
  if (!m) return undefined;
  const lat = Number(m[2]);
  const lon = Number(m[3]);
  const { west, south, east, north } = GOTHENBURG.bbox;
  const near =
    lon >= west - MARGIN_DEG &&
    lon <= east + MARGIN_DEG &&
    lat >= south - MARGIN_DEG &&
    lat <= north + MARGIN_DEG;
  return near ? { lang: m[1] as Lang, lat, lon } : undefined;
}

export function parseGeosearch(raw: unknown, lang: Lang): WikiNearby {
  const list = Geosearch.parse(raw).query?.geosearch ?? [];
  return {
    articles: list.slice(0, LIMIT).map((a) => ({
      title: truncate(a.title, 300),
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(a.title.replaceAll(' ', '_'))}`,
      distanceM: Math.round(a.dist),
    })),
  };
}

function createWikipedia(): OnDemandConnector {
  const cache = new Map<string, { body: string; at: number }>();
  let queue: Promise<unknown> = Promise.resolve();
  let lastRequestAt = 0;

  const throttled = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(async () => {
      const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastRequestAt = Date.now();
      return fn();
    });
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    id: 'wikipedia.nearby',
    name: 'Wikipedia – articles nearby',
    licence: 'CC BY-SA 4.0 (titles and links only)',
    attribution: 'Wikipedia contributors',
    homepage: 'https://www.mediawiki.org/wiki/API:Geosearch',
    mode: 'on-demand',
    allowedHosts: HOSTS,
    channels: [],
    async serve(ctx, path) {
      const req = parseNearbyPath(path);
      if (!req) return undefined;
      let hit = cache.get(path);
      if (!hit || Date.now() - hit.at > CACHE_TTL_MS) {
        const query = new URLSearchParams({
          action: 'query',
          list: 'geosearch',
          gscoord: `${req.lat}|${req.lon}`,
          gsradius: String(RADIUS_M),
          gslimit: String(LIMIT),
          format: 'json',
          formatversion: '2',
        });
        const raw = await throttled(() =>
          ctx.http.getJson(`https://${req.lang}.wikipedia.org/w/api.php?${query}`, {
            timeoutMs: 15_000,
          }),
        );
        hit = { body: JSON.stringify(parseGeosearch(raw, req.lang)), at: Date.now() };
        cache.delete(path);
        cache.set(path, hit);
        if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
      }
      return { type: 'application/json', body: hit.body, maxAgeSec: 24 * 3600 };
    },
  };
}

export const wikipediaNearby = createWikipedia();
