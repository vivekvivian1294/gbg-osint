import type { OnDemandConnector } from '../core/connector';

const HOST = 'gibs.earthdata.nasa.gov';
const PRODUCT = 'VIIRS_NOAA20_CorrectedReflectance_TrueColor';
const MAX_ZOOM = 9;
const MAX_AGE_DAYS = 30;
/** Only tiles over Scandinavia are proxied: lon 0–30° E, lat 50–70° N. */
export const GIBS_REGION = { west: 0, south: 50, east: 30, north: 70 } as const;
const TILE_PATH = /^viirs\/(\d{4}-\d{2}-\d{2})\/(\d{1})\/(\d{1,3})\/(\d{1,3})\.jpg$/;
const CACHE_BYTES = 40 * 1024 * 1024;
const MAX_TILE_BYTES = 2 * 1024 * 1024;
const DAY_MS = 24 * 3600_000;

const tileLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const tileLat = (y: number, z: number) =>
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

export function parseGibsPath(
  path: string,
  now = Date.now(),
): { date: string; z: number; x: number; y: number } | undefined {
  const m = TILE_PATH.exec(path);
  if (!m) return undefined;
  const [date, z, x, y] = [m[1]!, Number(m[2]), Number(m[3]), Number(m[4])];
  const day = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(day) || day > now || now - day > MAX_AGE_DAYS * DAY_MS) return undefined;
  if (z > MAX_ZOOM || x >= 2 ** z || y >= 2 ** z) return undefined;
  const r = GIBS_REGION;
  const overlaps =
    tileLon(x + 1, z) > r.west &&
    tileLon(x, z) < r.east &&
    tileLat(y, z) > r.south &&
    tileLat(y + 1, z) < r.north;
  return overlaps ? { date, z, x, y } : undefined;
}

/** Yesterday's true-colour satellite image (NASA GIBS), proxied and cached as map tiles. */
function createGibs(): OnDemandConnector {
  const tiles = new Map<string, Buffer>();
  let bytes = 0;
  const remember = (key: string, body: Buffer) => {
    tiles.set(key, body);
    bytes += body.length;
    for (const [k, v] of tiles) {
      if (bytes <= CACHE_BYTES) break;
      tiles.delete(k);
      bytes -= v.length;
    }
  };

  return {
    id: 'nasa.gibs',
    name: 'NASA GIBS – daily satellite image (VIIRS)',
    licence: 'Public domain (NASA); no copyright on GIBS imagery',
    attribution: 'NASA EOSDIS GIBS, VIIRS NOAA-20 corrected reflectance',
    homepage:
      'https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api',
    mode: 'on-demand',
    allowedHosts: [HOST],
    channels: [],
    async serve(ctx, path) {
      const tile = parseGibsPath(path);
      if (!tile) return undefined;
      let body = tiles.get(path);
      if (!body) {
        body = await ctx.http.getBytes(
          `https://${HOST}/wmts/epsg3857/best/${PRODUCT}/default/${tile.date}/GoogleMapsCompatible_Level9/${tile.z}/${tile.y}/${tile.x}.jpg`,
          { maxBytes: MAX_TILE_BYTES, timeoutMs: 20_000 },
        );
        if (body[0] !== 0xff || body[1] !== 0xd8) return undefined;
        remember(path, body);
      } else {
        tiles.delete(path);
        tiles.set(path, body);
      }
      return { type: 'image/jpeg', body, maxAgeSec: 7 * 24 * 3600 };
    },
  };
}

export const nasaGibs = createGibs();
