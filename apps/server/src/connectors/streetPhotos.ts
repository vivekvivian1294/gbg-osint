import type { Entity } from '@gbg-osint/shared';
import { z } from 'zod';
import type { Cached } from '../core/cache';
import type { ConnectorContext, OnDemandConnector } from '../core/connector';
import { BUILDING_TILES, BUILDING_ZOOM } from './buildings';
import { truncate } from './util';

const ID = 'streetphotos';
export const PHOTO_ZOOM = 15;
const LIST_MAX_AGE_MS = 24 * 3600_000;
const MAX_PER_TILE = 150;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_CACHE_BYTES = 48 * 1024 * 1024;
const PANORAMAX_API = 'api.panoramax.xyz';
const KARTAVIEW_API = 'api.kartaview.org';
/** Panoramax instances that host Gothenburg photos; photos on other hosts are skipped. */
const PANORAMAX_IMAGE_HOSTS = [
  'panoramax.openstreetmap.fr',
  'panoramax.mapcomplete.org',
  'images.panoramax.basi.re',
  'panoramax.ign.fr',
];
const KARTAVIEW_IMAGE_HOSTS = Array.from(
  { length: 30 },
  (_, i) => `storage${i + 1}.openstreetcam.org`,
);
const IMAGE_HOSTS = new Set([...PANORAMAX_IMAGE_HOSTS, ...KARTAVIEW_IMAGE_HOSTS]);

/** Photo tiles are z15 inside the same area as the building tiles. */
const TILES = {
  minX: BUILDING_TILES.minX * 2 ** (PHOTO_ZOOM - BUILDING_ZOOM),
  maxX: (BUILDING_TILES.maxX + 1) * 2 ** (PHOTO_ZOOM - BUILDING_ZOOM) - 1,
  minY: BUILDING_TILES.minY * 2 ** (PHOTO_ZOOM - BUILDING_ZOOM),
  maxY: (BUILDING_TILES.maxY + 1) * 2 ** (PHOTO_ZOOM - BUILDING_ZOOM) - 1,
};

export interface TileBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export function tileBounds(x: number, y: number, zoom: number): TileBounds {
  const n = 2 ** zoom;
  const lat = (row: number) =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return {
    west: (x / n) * 360 - 180,
    east: ((x + 1) / n) * 360 - 180,
    north: lat(y),
    south: lat(y + 1),
  };
}

/** A photo plus the upstream image URLs, which stay on the server. */
export interface StreetPhoto {
  id: string;
  provider: 'panoramax' | 'kartaview';
  lon: number;
  lat: number;
  heading?: number;
  takenAt?: string;
  author?: string;
  licence: string;
  pageUrl: string;
  thumbUrl: string;
  imageUrl: string;
}

const inside = (b: TileBounds, lon: number, lat: number) =>
  lon >= b.west && lon < b.east && lat > b.south && lat <= b.north;

function allowedImage(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && IMAGE_HOSTS.has(url.hostname) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const PanoramaxSearch = z.object({ features: z.array(z.unknown()) });
const PanoramaxPhoto = z.object({
  id: z.uuid(),
  geometry: z.object({ coordinates: z.tuple([z.number(), z.number()]) }),
  properties: z.object({
    datetime: z.string().optional(),
    license: z.string().max(64).optional(),
    'view:azimuth': z.number().optional(),
  }),
  providers: z
    .array(z.object({ name: z.string(), roles: z.array(z.string()).optional() }))
    .optional(),
  assets: z.object({
    thumb: z.object({ href: z.string() }),
    sd: z.object({ href: z.string() }),
  }),
  links: z.array(z.object({ rel: z.string(), href: z.string() })).optional(),
});

export function parsePanoramax(raw: unknown, bounds: TileBounds): StreetPhoto[] {
  const photos: StreetPhoto[] = [];
  for (const item of PanoramaxSearch.parse(raw).features) {
    const parsed = PanoramaxPhoto.safeParse(item);
    if (!parsed.success) continue;
    const p = parsed.data;
    const [lon, lat] = p.geometry.coordinates;
    const thumbUrl = allowedImage(p.assets.thumb.href);
    const imageUrl = allowedImage(p.assets.sd.href);
    if (!inside(bounds, lon, lat) || !thumbUrl || !imageUrl) continue;
    const via = p.links?.find((l) => l.rel === 'via')?.href;
    const viewer = via?.startsWith('https://') ? new URL(via).origin : `https://${PANORAMAX_API}`;
    const people = (p.providers ?? []).filter((x) => x.roles?.includes('producer'));
    const azimuth = p.properties['view:azimuth'];
    photos.push({
      id: `pnx-${p.id}`,
      provider: 'panoramax',
      lon,
      lat,
      ...(azimuth !== undefined && azimuth >= 0 && azimuth <= 360 && { heading: azimuth % 360 }),
      ...(p.properties.datetime &&
        !Number.isNaN(Date.parse(p.properties.datetime)) && {
          takenAt: new Date(p.properties.datetime).toISOString(),
        }),
      ...(people.length > 0 && { author: truncate(people.at(-1)!.name, 80) }),
      licence: p.properties.license ?? 'CC-BY-SA-4.0',
      pageUrl: `${viewer}/#focus=pic&pic=${p.id}`,
      thumbUrl,
      imageUrl,
    });
  }
  return photos;
}

const KartaViewResponse = z.object({ result: z.object({ data: z.array(z.unknown()) }) });
const KartaViewPhoto = z.object({
  id: z.coerce.number().int(),
  lat: z.coerce.number(),
  lng: z.coerce.number(),
  heading: z.coerce.number().optional(),
  shotDate: z.string().optional(),
  sequenceId: z.coerce.number().int(),
  sequenceIndex: z.coerce.number().int(),
  fileurlTh: z.string(),
  fileurlProc: z.string(),
});

export function parseKartaView(raw: unknown, bounds: TileBounds): StreetPhoto[] {
  const photos: StreetPhoto[] = [];
  for (const item of KartaViewResponse.parse(raw).result.data) {
    const parsed = KartaViewPhoto.safeParse(item);
    if (!parsed.success) continue;
    const p = parsed.data;
    const thumbUrl = allowedImage(p.fileurlTh);
    const imageUrl = allowedImage(p.fileurlProc);
    if (!inside(bounds, p.lng, p.lat) || !thumbUrl || !imageUrl) continue;
    const shot = p.shotDate && Date.parse(`${p.shotDate.replace(' ', 'T')}Z`);
    photos.push({
      id: `kv-${p.id}`,
      provider: 'kartaview',
      lon: p.lng,
      lat: p.lat,
      ...(p.heading !== undefined &&
        p.heading > 0 &&
        p.heading <= 360 && { heading: p.heading % 360 }),
      ...(shot && !Number.isNaN(shot) && { takenAt: new Date(shot).toISOString() }),
      licence: 'CC-BY-SA-4.0',
      pageUrl: `https://kartaview.org/details/${p.sequenceId}/${p.sequenceIndex}`,
      thumbUrl,
      imageUrl,
    });
  }
  return photos;
}

/** What browsers get: photos as entities whose image links point back at this server. */
export function photoEntities(
  photos: readonly StreetPhoto[],
  x: number,
  y: number,
  ts: string,
): Entity[] {
  const base = `/api/data/${ID}/img/${x}/${y}`;
  return photos.map((p) => ({
    id: p.id,
    source: p.provider,
    kind: 'photo',
    lon: p.lon,
    lat: p.lat,
    ...(p.heading !== undefined && { heading: p.heading }),
    label: p.provider === 'panoramax' ? 'Panoramax photo' : 'KartaView photo',
    ts: p.takenAt ?? ts,
    props: {
      provider: p.provider,
      licence: p.licence,
      pageUrl: p.pageUrl,
      thumb: `${base}/${p.id}/thumb.jpg`,
      image: `${base}/${p.id}/image.jpg`,
      ...(p.takenAt && { takenAt: p.takenAt }),
      ...(p.author && { author: p.author }),
    },
  }));
}

/** Small LRU of proxied images, bounded by total bytes. */
class ImageCache {
  private readonly entries = new Map<string, Buffer>();
  private bytes = 0;

  get(key: string): Buffer | undefined {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit;
  }

  set(key: string, value: Buffer): void {
    this.entries.set(key, value);
    this.bytes += value.length;
    for (const [k, v] of this.entries) {
      if (this.bytes <= IMAGE_CACHE_BYTES) break;
      this.entries.delete(k);
      this.bytes -= v.length;
    }
  }
}

function createStreetPhotos(): OnDemandConnector {
  const images = new ImageCache();

  async function tilePhotos(
    ctx: ConnectorContext,
    x: number,
    y: number,
  ): Promise<Cached<StreetPhoto[]>> {
    const key = `p-${x}-${y}`;
    const fresh = await ctx.cache.get<StreetPhoto[]>(key, LIST_MAX_AGE_MS);
    if (fresh) return fresh;
    const b = tileBounds(x, y, PHOTO_ZOOM);
    const centerLat = (b.north + b.south) / 2;
    const radiusM = Math.ceil(
      Math.hypot(
        (b.east - b.west) * 111_320 * Math.cos((centerLat * Math.PI) / 180),
        (b.north - b.south) * 110_540,
      ) / 2,
    );
    const [panoramax, kartaview] = await Promise.allSettled([
      ctx.http.getJson(
        `https://${PANORAMAX_API}/api/search?bbox=${[b.west, b.south, b.east, b.north].map((v) => v.toFixed(6)).join(',')}&limit=${MAX_PER_TILE}`,
        { timeoutMs: 20_000 },
      ),
      ctx.http.getJson(
        `https://${KARTAVIEW_API}/2.0/photo/?lat=${centerLat.toFixed(6)}&lng=${((b.east + b.west) / 2).toFixed(6)}&radius=${radiusM}&itemsPerPage=${MAX_PER_TILE}`,
        { timeoutMs: 20_000 },
      ),
    ]);
    if (panoramax.status === 'rejected' && kartaview.status === 'rejected') {
      const stale = await ctx.cache.get<StreetPhoto[]>(key, Infinity);
      if (stale) return stale;
      throw panoramax.reason;
    }
    const photos = [
      ...(panoramax.status === 'fulfilled' ? parsePanoramax(panoramax.value, b) : []),
      ...(kartaview.status === 'fulfilled' ? parseKartaView(kartaview.value, b) : []),
    ].slice(0, MAX_PER_TILE);
    for (const r of [panoramax, kartaview]) {
      if (r.status === 'rejected') ctx.log.warn({ err: r.reason }, 'street photo provider failed');
    }
    const complete = panoramax.status === 'fulfilled' && kartaview.status === 'fulfilled';
    if (complete) await ctx.cache.set(key, photos);
    return { value: photos, savedAt: Date.now() };
  }

  return {
    id: ID,
    name: 'Street-level photos (Panoramax, KartaView)',
    licence: 'CC BY-SA 4.0 (per photo)',
    attribution: 'Panoramax contributors, KartaView contributors',
    homepage: 'https://panoramax.fr/',
    mode: 'on-demand',
    allowedHosts: [PANORAMAX_API, KARTAVIEW_API, ...IMAGE_HOSTS],
    channels: [],
    async serve(ctx, path) {
      const list = /^tiles\/(\d{4,5})\/(\d{4,5})\.json$/.exec(path);
      const img =
        /^img\/(\d{4,5})\/(\d{4,5})\/((?:pnx|kv)-[a-f0-9-]{1,40})\/(thumb|image)\.jpg$/.exec(path);
      const x = Number((list ?? img)?.[1]);
      const y = Number((list ?? img)?.[2]);
      if (!(x >= TILES.minX && x <= TILES.maxX && y >= TILES.minY && y <= TILES.maxY)) {
        return undefined;
      }
      if (list) {
        const { value, savedAt } = await tilePhotos(ctx, x, y);
        const items = photoEntities(value, x, y, new Date(savedAt).toISOString());
        return { type: 'application/json', body: JSON.stringify({ items }), maxAgeSec: 3600 };
      }
      const [, , , id, size] = img!;
      const cached = images.get(path);
      if (cached) return { type: 'image/jpeg', body: cached, maxAgeSec: 7 * 24 * 3600 };
      const photo = (await tilePhotos(ctx, x, y)).value.find((p) => p.id === id);
      if (!photo) return undefined;
      const body = await ctx.http.getBytes(size === 'thumb' ? photo.thumbUrl : photo.imageUrl, {
        maxBytes: MAX_IMAGE_BYTES,
        timeoutMs: 20_000,
      });
      if (body[0] !== 0xff || body[1] !== 0xd8) return undefined;
      images.set(path, body);
      return { type: 'image/jpeg', body, maxAgeSec: 7 * 24 * 3600 };
    },
  };
}

export const streetPhotos = createStreetPhotos();
