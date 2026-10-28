import { GOTHENBURG, type Building, type BuildingTile } from '@gbg-osint/shared';
import { z } from 'zod';
import type { ConnectorContext, OnDemandConnector } from '../core/connector';
import { UpstreamError } from '../core/http';
import { clipRing, decodeMvt, polygonsOf, ringArea } from './mvt';

export const OPENFREEMAP_HOST = 'tiles.openfreemap.org';
const HOST = OPENFREEMAP_HOST;
const TILEJSON_URL = `https://${HOST}/planet`;
export const BUILDING_ZOOM = 14;
const TILE_MAX_AGE_MS = 30 * 24 * 3600_000;
const TILEJSON_MAX_AGE_MS = 24 * 3600_000;
const MAX_TILE_BYTES = 8 * 1024 * 1024;
const MAX_HEIGHT_M = 400;
const MIN_RING_AREA = 16;

export function tileX(lon: number, zoom: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** zoom);
}

export function tileY(lat: number, zoom: number): number {
  const phi = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * 2 ** zoom);
}

/** Tiles covering the Gothenburg area (one tile of margin); the server serves no others. */
export const BUILDING_TILES = {
  minX: tileX(GOTHENBURG.bbox.west, BUILDING_ZOOM) - 1,
  maxX: tileX(GOTHENBURG.bbox.east, BUILDING_ZOOM) + 1,
  minY: tileY(GOTHENBURG.bbox.north, BUILDING_ZOOM) - 1,
  maxY: tileY(GOTHENBURG.bbox.south, BUILDING_ZOOM) + 1,
};

const TileJson = z.object({ tiles: z.array(z.url()).min(1) });

/** Extruded footprints from OpenMapTiles' `building` layer, clipped to the tile edges. */
export function parseBuildingTile(pbf: Uint8Array, x: number, y: number): BuildingTile {
  const layer = decodeMvt(pbf, new Set(['building']))[0];
  const extent = layer?.extent ?? 4096;
  const buildings: Building[] = [];
  for (const f of layer?.features ?? []) {
    if (f.type !== 3 || f.properties.hide_3d === true) continue;
    const height = Number(f.properties.render_height);
    const minHeight = Number(f.properties.render_min_height ?? 0);
    if (!Number.isFinite(height) || height <= 0) continue;
    const top = Math.min(height, MAX_HEIGHT_M);
    const bottom = Number.isFinite(minHeight) ? Math.max(0, Math.min(minHeight, top - 1)) : 0;
    const polygons: number[][][] = [];
    for (const rings of polygonsOf(f.geometry)) {
      const clipped = rings
        .map((ring) => clipRing(ring, extent).map(Math.round))
        .filter((ring) => ring.length >= 6);
      const [outer] = clipped;
      if (!outer || Math.abs(ringArea(outer)) < MIN_RING_AREA) continue;
      polygons.push(clipped);
    }
    if (polygons.length > 0) buildings.push([Math.round(top * 10) / 10, bottom, polygons]);
  }
  return { z: BUILDING_ZOOM, x, y, extent, buildings };
}

async function tileTemplate(ctx: ConnectorContext): Promise<string> {
  let cached = await ctx.cache.get<unknown>('tilejson', TILEJSON_MAX_AGE_MS);
  if (!cached) {
    try {
      const value = await ctx.http.getJson(TILEJSON_URL);
      await ctx.cache.set('tilejson', value);
      cached = { value, savedAt: Date.now() };
    } catch (err) {
      cached = await ctx.cache.get<unknown>('tilejson', Infinity);
      if (!cached) throw err;
    }
  }
  const template = TileJson.parse(cached.value).tiles[0]!;
  const url = new URL(template.replace(/[{}]/g, ''));
  if (url.hostname !== HOST || !template.includes('{z}/{x}/{y}')) {
    throw new UpstreamError('Unexpected tile URL template');
  }
  return template;
}

/** URL of one OpenFreeMap vector tile; the template comes from the TileJSON (cached daily). */
export async function openFreeMapTileUrl(
  ctx: ConnectorContext,
  z: number,
  x: number,
  y: number,
): Promise<string> {
  return (await tileTemplate(ctx))
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

export const openFreeMapBuildings: OnDemandConnector = {
  id: 'openfreemap.buildings',
  name: 'OpenFreeMap – 3D buildings (OpenStreetMap)',
  licence: 'ODbL 1.0 (data); OpenMapTiles schema',
  attribution: 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap',
  homepage: 'https://openfreemap.org/',
  mode: 'on-demand',
  allowedHosts: [HOST],
  channels: [],
  async serve(ctx, path) {
    const m = /^(\d{4,5})\/(\d{4,5})\.json$/.exec(path);
    if (!m) return undefined;
    const x = Number(m[1]);
    const y = Number(m[2]);
    const t = BUILDING_TILES;
    if (x < t.minX || x > t.maxX || y < t.minY || y > t.maxY) return undefined;
    const key = `t-${x}-${y}`;
    let tile = (await ctx.cache.get<BuildingTile>(key, TILE_MAX_AGE_MS))?.value;
    if (!tile) {
      try {
        const url = await openFreeMapTileUrl(ctx, BUILDING_ZOOM, x, y);
        const pbf = await ctx.http.getBytes(url, { maxBytes: MAX_TILE_BYTES, timeoutMs: 30_000 });
        tile = parseBuildingTile(pbf, x, y);
        await ctx.cache.set(key, tile);
      } catch (err) {
        tile = (await ctx.cache.get<BuildingTile>(key, Infinity))?.value;
        if (!tile) throw err;
      }
    }
    return { type: 'application/json', body: JSON.stringify(tile), maxAgeSec: 7 * 24 * 3600 };
  },
};
