import { GOTHENBURG, type Geocode } from '@gbg-osint/shared';
import { z } from 'zod';
import type { OnDemandConnector } from '../core/connector';
import { truncate } from './util';

const HOST = 'photon.komoot.io';
/** `search/<query as base64url>.json`; data paths only allow URL-safe characters. */
const SEARCH_PATH = /^search\/([A-Za-z0-9_-]{3,160})\.json$/;
export const MIN_QUERY = 3;
export const MAX_QUERY = 60;
const LIMIT = 6;
/** Photon is a free community service: one request a second at most, and cache generously. */
const MIN_INTERVAL_MS = 1_000;
const MAX_CACHED = 500;
const CACHE_TTL_MS = 24 * 3600_000;

const Feature = z.object({
  geometry: z.object({
    type: z.literal('Point'),
    coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
  }),
  properties: z.object({
    name: z.string().optional(),
    street: z.string().optional(),
    housenumber: z.string().optional(),
    district: z.string().optional(),
    locality: z.string().optional(),
    city: z.string().optional(),
    osm_value: z.string().optional(),
  }),
});
const Photon = z.object({ features: z.array(z.unknown()) });

/** The search text, normalised, or undefined if the path or text is not acceptable. */
export function parseSearchPath(path: string): string | undefined {
  const m = SEARCH_PATH.exec(path);
  if (!m) return undefined;
  const text = Buffer.from(m[1]!, 'base64url').toString('utf8');
  // Reject anything that isn't the canonical encoding of valid UTF-8 text.
  if (Buffer.from(text, 'utf8').toString('base64url') !== m[1]) return undefined;
  const query = text.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (/\p{Cc}/u.test(query)) return undefined;
  return query.length >= MIN_QUERY && query.length <= MAX_QUERY ? query : undefined;
}

export function parsePhoton(raw: unknown): Geocode {
  const results: Geocode['results'] = [];
  const seen = new Set<string>();
  for (const item of Photon.parse(raw).features) {
    const f = Feature.safeParse(item);
    if (!f.success) continue;
    const p = f.data.properties;
    const [lon, lat] = f.data.geometry.coordinates;
    const address = p.street && (p.housenumber ? `${p.street} ${p.housenumber}` : p.street);
    const label = p.name ?? address ?? p.district ?? p.locality ?? p.city;
    if (!label) continue;
    const area = p.district ?? p.locality;
    const detail = [p.name ? address : undefined, area !== label ? area : undefined, p.city]
      .filter((v, i, all): v is string => !!v && v !== label && all.indexOf(v) === i)
      .join(', ');
    const key = `${label}|${lon.toFixed(4)}|${lat.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      label: truncate(label, 200),
      ...(detail && { detail: truncate(detail, 200) }),
      ...(p.osm_value && { kind: truncate(p.osm_value, 40) }),
      lon,
      lat,
    });
    if (results.length >= LIMIT) break;
  }
  return { results };
}

function createGeocoder(): OnDemandConnector {
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
    id: 'photon.geocode',
    name: 'Address search – Photon (komoot)',
    licence: 'ODbL 1.0 (OpenStreetMap data); Photon fair-use policy',
    attribution: 'Photon by komoot, © OpenStreetMap contributors',
    homepage: 'https://photon.komoot.io/',
    mode: 'on-demand',
    allowedHosts: [HOST],
    channels: [],
    async serve(ctx, path) {
      const query = parseSearchPath(path);
      if (!query) return undefined;
      const key = query.toLowerCase();
      let hit = cache.get(key);
      if (!hit || Date.now() - hit.at > CACHE_TTL_MS) {
        const { west, south, east, north } = GOTHENBURG.bbox;
        const params = new URLSearchParams({
          q: query,
          limit: String(LIMIT * 2),
          bbox: [west, south, east, north].join(','),
        });
        const raw = await throttled(() =>
          ctx.http.getJson(`https://${HOST}/api/?${params}`, { timeoutMs: 15_000 }),
        );
        hit = { body: JSON.stringify(parsePhoton(raw)), at: Date.now() };
        cache.delete(key);
        cache.set(key, hit);
        if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
      }
      return { type: 'application/json', body: hit.body, maxAgeSec: 24 * 3600 };
    },
  };
}

export const photonGeocoder = createGeocoder();
