import type { Frame } from '@gbg-osint/shared';
import { z } from 'zod';
import type { ConnectorContext, PollConnector, ServedFile } from '../core/connector';
import { UpstreamError } from '../core/http';
import {
  decodeGeoTiff,
  encodeIndexedPng,
  reprojectToLonLat,
  type LonLatGrid,
  type Rgba,
} from './raster';

const ID = 'smhi.radar';
const CHANNEL = 'env.radar';
const HOST = 'opendata-download-radar.smhi.se';
const PRODUCT = `https://${HOST}/api/version/latest/area/sweden/product/comp`;
/** One hour of 5-minute frames. */
const FRAME_COUNT = 12;
const MAX_TIF_BYTES = 2 * 1024 * 1024;
const FRAME_KEY = /^radar_\d{10}$/;
const NODATA = 255;

/** Covers the Nordic composite; ~2 km pixels like the source. */
export const RADAR_GRID: LonLatGrid = {
  west: 4,
  north: 71,
  lonStep: 0.035,
  latStep: 0.0175,
  width: 800,
  height: 1000,
};
const BBOX = {
  west: RADAR_GRID.west,
  south: RADAR_GRID.north - RADAR_GRID.height * RADAR_GRID.latStep,
  east: RADAR_GRID.west + RADAR_GRID.width * RADAR_GRID.lonStep,
  north: RADAR_GRID.north,
};

/** Reflectivity (dBZ) colour stops; weaker echoes fade out so the map stays readable. */
const STOPS: readonly [number, Rgba][] = [
  [2, [110, 180, 255, 0]],
  [10, [80, 160, 255, 150]],
  [18, [40, 200, 150, 185]],
  [26, [130, 220, 40, 205]],
  [34, [250, 220, 30, 220]],
  [42, [255, 140, 20, 230]],
  [50, [230, 30, 30, 240]],
  [58, [210, 40, 210, 250]],
];

/** SMHI stores reflectivity as `dBZ = 0.4 · value − 30`; 0 is no echo and 255 no coverage. */
export function radarPalette(): Rgba[] {
  const palette: Rgba[] = [];
  for (let v = 0; v < 256; v++) {
    const dbz = 0.4 * v - 30;
    const [firstDbz, firstColor] = STOPS[0]!;
    if (v === 0 || v === NODATA || dbz < firstDbz) {
      palette.push([0, 0, 0, 0]);
      continue;
    }
    let color: Rgba = STOPS.at(-1)![1];
    let prev: [number, Rgba] = [firstDbz, firstColor];
    for (const stop of STOPS.slice(1)) {
      if (dbz <= stop[0]) {
        const t = (dbz - prev[0]) / (stop[0] - prev[0]);
        color = prev[1].map((c, i) => Math.round(c + (stop[1][i]! - c) * t)) as unknown as Rgba;
        break;
      }
      prev = stop;
    }
    palette.push(color);
  }
  return palette;
}

const Listing = z.object({
  files: z.array(
    z.object({
      key: z.string(),
      valid: z.string(),
      formats: z.array(z.object({ key: z.string(), link: z.url() })),
    }),
  ),
});

export interface RadarFile {
  key: string;
  /** ISO time the frame is valid for. */
  valid: string;
  tif: string;
}

/** TIF frames from a daily listing, oldest first. */
export function parseRadarListing(raw: unknown): RadarFile[] {
  const files: RadarFile[] = [];
  for (const f of Listing.parse(raw).files) {
    const tif = f.formats.find((x) => x.key === 'tif')?.link;
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/.exec(f.valid);
    if (!FRAME_KEY.test(f.key) || !tif || !m) continue;
    if (new URL(tif).hostname !== HOST) continue;
    files.push({ key: f.key, valid: `${m[1]}T${m[2]}:00.000Z`, tif });
  }
  return files.sort((a, b) => a.valid.localeCompare(b.valid));
}

/** GeoTIFF frame from SMHI to a transparent PNG on the lon/lat grid. */
export function radarPng(tif: Uint8Array): Buffer {
  const raster = decodeGeoTiff(tif);
  const pixels = reprojectToLonLat(raster, RADAR_GRID, NODATA);
  return encodeIndexedPng(RADAR_GRID.width, RADAR_GRID.height, pixels, radarPalette());
}

const dayPath = (d: Date) =>
  `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;

function createRadarConnector(): PollConnector {
  const frames = new Map<string, { valid: string; png: Buffer }>();

  async function latestFiles(ctx: ConnectorContext): Promise<RadarFile[]> {
    const today = new Date();
    let files = parseRadarListing(await ctx.http.getJson(`${PRODUCT}/${dayPath(today)}`));
    if (files.length < FRAME_COUNT) {
      const yesterday = new Date(today.getTime() - 24 * 3600_000);
      const earlier = parseRadarListing(await ctx.http.getJson(`${PRODUCT}/${dayPath(yesterday)}`));
      files = [...earlier, ...files];
    }
    return files.slice(-FRAME_COUNT);
  }

  return {
    id: ID,
    name: 'SMHI – precipitation radar',
    licence: 'CC BY 4.0',
    attribution: 'SMHI',
    homepage: 'https://www.smhi.se/data/meteorologi/radar',
    mode: 'poll',
    intervalMs: 5 * 60_000,
    allowedHosts: [HOST],
    channels: [{ name: CHANNEL, kind: 'frames' }],
    async poll(ctx) {
      const files = await latestFiles(ctx);
      if (files.length === 0) throw new UpstreamError('No radar frames listed');
      const wanted = new Set(files.map((f) => f.key));
      for (const key of frames.keys()) if (!wanted.has(key)) frames.delete(key);
      for (const file of files) {
        if (frames.has(file.key)) continue;
        const tif = await ctx.http.getBytes(file.tif, { maxBytes: MAX_TIF_BYTES });
        try {
          frames.set(file.key, { valid: file.valid, png: radarPng(tif) });
        } catch (err) {
          ctx.log.warn({ err, frame: file.key }, 'skipping unreadable radar frame');
        }
      }
      const items: Frame[] = [...frames].map(([key, f]) => ({
        id: key,
        source: 'smhi',
        product: 'radar',
        ts: f.valid,
        path: `/api/data/${ID}/${key}.png`,
        bbox: BBOX,
      }));
      ctx.publish.replace(CHANNEL, items);
    },
    async serve(_ctx, path): Promise<ServedFile | undefined> {
      const key = /^(radar_\d{10})\.png$/.exec(path)?.[1];
      const frame = key ? frames.get(key) : undefined;
      return frame && { type: 'image/png', body: frame.png, maxAgeSec: 24 * 3600 };
    },
  };
}

export const smhiRadar = createRadarConnector();
