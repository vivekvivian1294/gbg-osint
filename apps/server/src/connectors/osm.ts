import { encodeLine, GOTHENBURG, type Entity, type Feature, type LonLat } from '@gbg-osint/shared';
import { z } from 'zod';
import type { Cached } from '../core/cache';
import type { ConnectorContext, PollConnector } from '../core/connector';
import { lineLengthM, simplifyLine, truncate } from './util';

const CHANNEL = 'context.poi';
const MAX_AGE_MS = 7 * 24 * 3600_000;

const { south, west, north, east } = GOTHENBURG.bbox;
const BBOX = `${south},${west},${north},${east}`;
const QUERY =
  `[out:json][timeout:25];(` +
  `nwr["amenity"~"^(hospital|police|fire_station)$"](${BBOX});` +
  `nwr["emergency"="ambulance_station"](${BBOX});` +
  `);out center tags;`;

const Element = z.object({
  type: z.enum(['node', 'way', 'relation']),
  id: z.number(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  center: z.object({ lat: z.number(), lon: z.number() }).optional(),
  tags: z.record(z.string(), z.string()).default({}),
});
const Response = z.object({ elements: z.array(z.unknown()) });

const CATEGORY_LABELS: Record<string, string> = {
  hospital: 'Hospital',
  police: 'Police station',
  fire_station: 'Fire station',
  ambulance_station: 'Ambulance station',
};

export function parsePois(raw: unknown, fetchedAt: number): Entity[] {
  const entities: Entity[] = [];
  for (const item of Response.parse(raw).elements) {
    const parsed = Element.safeParse(item);
    if (!parsed.success) continue;
    const e = parsed.data;
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    const category = e.tags.amenity ?? e.tags.emergency;
    if (lat === undefined || lon === undefined || !category) continue;
    entities.push({
      id: `${e.type}/${e.id}`,
      source: 'osm',
      kind: 'poi',
      lon,
      lat,
      label: e.tags.name ?? CATEGORY_LABELS[category] ?? category,
      ts: new Date(fetchedAt).toISOString(),
      props: {
        category,
        ...(e.tags.operator && { operator: e.tags.operator }),
        osm: `https://www.openstreetmap.org/${e.type}/${e.id}`,
      },
    });
  }
  return entities;
}

export const osmPois: PollConnector = {
  id: 'osm.poi',
  name: 'OpenStreetMap – emergency services',
  licence: 'ODbL 1.0',
  attribution: '© OpenStreetMap contributors',
  homepage: 'https://www.openstreetmap.org/copyright',
  mode: 'poll',
  intervalMs: 24 * 3600_000,
  allowedHosts: ['overpass-api.de'],
  channels: [{ name: CHANNEL, kind: 'entities' }],
  async poll(ctx) {
    let cached = await ctx.cache.get<unknown>('pois', MAX_AGE_MS);
    if (!cached) {
      const raw = await ctx.http.getJson(
        `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(QUERY)}`,
        { timeoutMs: 40_000 },
      );
      await ctx.cache.set('pois', raw);
      cached = { value: raw, savedAt: Date.now() };
    }
    ctx.publish.replace(CHANNEL, parsePois(cached.value, cached.savedAt));
  },
};

/** Public Overpass instances, tried in order; they are often overloaded. */
export const OVERPASS_HOSTS = ['overpass-api.de', 'overpass.kumi.systems'] as const;
const OVERPASS_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Overpass result from the disk cache, or fetched when the cache is older than `maxAgeMs`.
 * A stale copy is used when every instance fails.
 */
export async function cachedOverpass(
  ctx: ConnectorContext,
  key: string,
  query: string,
  maxAgeMs: number,
): Promise<Cached<unknown>> {
  const fresh = await ctx.cache.get<unknown>(key, maxAgeMs);
  if (fresh) return fresh;
  let failure: unknown;
  for (const host of OVERPASS_HOSTS) {
    try {
      const value = await ctx.http.getJson(
        `https://${host}/api/interpreter?data=${encodeURIComponent(query)}`,
        { timeoutMs: 120_000, maxBytes: OVERPASS_MAX_BYTES },
      );
      await ctx.cache.set(key, value);
      return { value, savedAt: Date.now() };
    } catch (err) {
      failure = err;
    }
  }
  const stale = await ctx.cache.get<unknown>(key, Infinity);
  if (stale) return stale;
  throw failure;
}

// --- Rivers, streams and canals ---

const WATERWAYS = 'env.waterways';
const WATERWAY_CLASSES = new Set(['river', 'stream', 'canal']);
const WATERWAY_QUERY =
  `[out:json][timeout:90];` +
  `way["waterway"~"^(river|stream|canal)$"][!"tunnel"]["covered"!="yes"](${BBOX});` +
  `out tags geom qt;`;
const SIMPLIFY_M = 4;
const MIN_LENGTH_M = 60;

const WaterwayWay = z.object({
  type: z.literal('way'),
  id: z.number().int(),
  tags: z.record(z.string(), z.string()).default({}),
  geometry: z.array(z.object({ lat: z.number(), lon: z.number() })).min(2),
});

interface Chain {
  id: number;
  group: string;
  coords: LonLat[];
}

const pointKey = ([lon, lat]: LonLat) => `${lon.toFixed(7)},${lat.toFixed(7)}`;

/** Joins ways of the same class and name that continue each other (end node = next start node). */
function joinChains(chains: Chain[]): Chain[] {
  const startsAt = new Map<string, Chain[]>();
  const endCount = new Map<string, number>();
  for (const c of chains) {
    const start = `${c.group}|${pointKey(c.coords[0]!)}`;
    startsAt.set(start, [...(startsAt.get(start) ?? []), c]);
    const end = `${c.group}|${pointKey(c.coords[c.coords.length - 1]!)}`;
    endCount.set(end, (endCount.get(end) ?? 0) + 1);
  }
  const used = new Set<Chain>();
  const out: Chain[] = [];
  const nextOf = (c: Chain): Chain | undefined => {
    const end = `${c.group}|${pointKey(c.coords[c.coords.length - 1]!)}`;
    const next = startsAt.get(end);
    return next?.length === 1 && endCount.get(end) === 1 && !used.has(next[0]!)
      ? next[0]
      : undefined;
  };
  // Start from chains nothing flows into, so each joined line keeps the flow direction.
  const heads = chains.filter((c) => {
    const start = `${c.group}|${pointKey(c.coords[0]!)}`;
    return !endCount.has(start) || startsAt.get(start)?.length !== 1 || endCount.get(start) !== 1;
  });
  for (const head of [...heads, ...chains]) {
    if (used.has(head)) continue;
    used.add(head);
    const joined: Chain = { ...head, coords: [...head.coords] };
    for (let next = nextOf(head); next; next = nextOf(next)) {
      used.add(next);
      joined.coords.push(...next.coords.slice(1));
    }
    out.push(joined);
  }
  return out;
}

/** Waterway lines in their flow direction (OSM draws waterways downstream), culverts excluded. */
export function parseWaterways(raw: unknown, fetchedAt: number): Feature[] {
  const chains: Chain[] = [];
  for (const item of Response.parse(raw).elements) {
    const parsed = WaterwayWay.safeParse(item);
    if (!parsed.success) continue;
    const { id, tags, geometry } = parsed.data;
    const cls = tags.waterway;
    if (!cls || !WATERWAY_CLASSES.has(cls) || (tags.tunnel && tags.tunnel !== 'no')) continue;
    chains.push({
      id,
      group: `${cls}|${tags.name ?? ''}`,
      coords: geometry.map((p): LonLat => [p.lon, p.lat]),
    });
  }
  const ts = new Date(fetchedAt).toISOString();
  const features: Feature[] = [];
  for (const chain of joinChains(chains)) {
    const [cls = 'stream', name = ''] = chain.group.split('|');
    const coords = simplifyLine(chain.coords, SIMPLIFY_M);
    if (lineLengthM(coords) < MIN_LENGTH_M) continue;
    features.push({
      id: `way/${chain.id}`,
      source: 'osm',
      kind: 'waterway',
      line: encodeLine(coords),
      ...(name && { label: truncate(name, 200) }),
      ts,
      props: { class: cls },
    });
  }
  return features;
}

export const osmWaterways: PollConnector = {
  id: 'osm.waterways',
  name: 'OpenStreetMap – rivers & streams',
  licence: 'ODbL 1.0',
  attribution: '© OpenStreetMap contributors',
  homepage: 'https://www.openstreetmap.org/copyright',
  mode: 'poll',
  intervalMs: 24 * 3600_000,
  allowedHosts: OVERPASS_HOSTS,
  channels: [{ name: WATERWAYS, kind: 'features' }],
  async poll(ctx) {
    const cached = await cachedOverpass(ctx, 'waterways', WATERWAY_QUERY, MAX_AGE_MS);
    ctx.publish.replace(WATERWAYS, parseWaterways(cached.value, cached.savedAt));
  },
};
