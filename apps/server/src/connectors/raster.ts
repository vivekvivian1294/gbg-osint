import { crc32, deflateSync } from 'node:zlib';

/** Single-band 8-bit raster in a projected coordinate system. */
export interface GeoRaster {
  width: number;
  height: number;
  /** One byte per pixel, row by row from the top-left corner. */
  data: Uint8Array;
  /** Projected coordinates of the top-left corner of the top-left pixel. */
  originX: number;
  originY: number;
  pixelSizeX: number;
  pixelSizeY: number;
}

const MAX_PIXELS = 8_000_000;
const TYPE_SIZE: Record<number, number> = { 1: 1, 3: 2, 4: 4, 12: 8 };

function readTags(view: DataView, le: boolean): Map<number, number[]> {
  const ifd = view.getUint32(4, le);
  const count = view.getUint16(ifd, le);
  const tags = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    const tag = view.getUint16(entry, le);
    const type = view.getUint16(entry + 2, le);
    const n = view.getUint32(entry + 4, le);
    const size = TYPE_SIZE[type];
    if (!size || n > 100_000) continue;
    const at = size * n <= 4 ? entry + 8 : view.getUint32(entry + 8, le);
    if (at + size * n > view.byteLength) throw new Error('Truncated TIFF tag');
    const values: number[] = [];
    for (let k = 0; k < n; k++) {
      const p = at + k * size;
      values.push(
        type === 1
          ? view.getUint8(p)
          : type === 3
            ? view.getUint16(p, le)
            : type === 4
              ? view.getUint32(p, le)
              : view.getFloat64(p, le),
      );
    }
    tags.set(tag, values);
  }
  return tags;
}

/** TIFF LZW (MSB-first codes, 9–12 bits, early change). Returns the number of bytes written. */
export function lzwDecode(src: Uint8Array, out: Uint8Array): number {
  const prefix = new Int16Array(4096).fill(-1);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  const length = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) {
    suffix[i] = i;
    first[i] = i;
    length[i] = 1;
  }
  let next = 258;
  let codeLen = 9;
  let prev = -1;
  let outPos = 0;
  let bits = 0;
  let bitCount = 0;
  let srcPos = 0;
  for (;;) {
    while (bitCount < codeLen) {
      if (srcPos >= src.length) return outPos;
      bits = ((bits << 8) | src[srcPos++]!) & 0xffffff;
      bitCount += 8;
    }
    const code = (bits >>> (bitCount - codeLen)) & ((1 << codeLen) - 1);
    bitCount -= codeLen;
    if (code === 257) return outPos;
    if (code === 256) {
      next = 258;
      codeLen = 9;
      prev = -1;
      continue;
    }
    if (prev === -1) {
      if (code > 255) throw new Error('Corrupt LZW data');
      if (outPos < out.length) out[outPos] = code;
      outPos++;
      prev = code;
      continue;
    }
    if (code > next) throw new Error('Corrupt LZW data');
    if (next < 4096) {
      prefix[next] = prev;
      suffix[next] = code < next ? first[code]! : first[prev]!;
      first[next] = first[prev]!;
      length[next] = length[prev]! + 1;
      next++;
    }
    const len = length[code]!;
    for (let k = outPos + len - 1, p = code; k >= outPos; k--) {
      if (k < out.length) out[k] = suffix[p]!;
      p = prefix[p]!;
    }
    outPos += len;
    prev = code;
    if (next + 1 >= 1 << codeLen && codeLen < 12) codeLen++;
  }
}

/** Decodes a single-band 8-bit GeoTIFF (stripped, uncompressed or LZW) with tie point and scale. */
export function decodeGeoTiff(buf: Uint8Array): GeoRaster {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const order = String.fromCharCode(buf[0] ?? 0, buf[1] ?? 0);
  if ((order !== 'II' && order !== 'MM') || buf.length < 8) throw new Error('Not a TIFF file');
  const le = order === 'II';
  if (view.getUint16(2, le) !== 42) throw new Error('Not a classic TIFF file');
  const tags = readTags(view, le);
  const one = (tag: number, fallback?: number) => tags.get(tag)?.[0] ?? fallback;

  const width = one(256);
  const height = one(257);
  const compression = one(259, 1);
  if (!width || !height || width * height > MAX_PIXELS) throw new Error('Unsupported TIFF size');
  if (one(258, 1) !== 8 || one(277, 1) !== 1) throw new Error('Only 8-bit single-band TIFFs');
  if (compression !== 1 && compression !== 5) throw new Error('Unsupported TIFF compression');
  if (one(317, 1) !== 1) throw new Error('Unsupported TIFF predictor');
  const offsets = tags.get(273);
  const counts = tags.get(279);
  if (!offsets || !counts || offsets.length !== counts.length) {
    throw new Error('Only stripped TIFFs are supported');
  }
  const scale = tags.get(33550);
  const tie = tags.get(33922);
  if (!scale || !tie || scale.length < 2 || tie.length < 6) throw new Error('Missing georeference');

  const rowsPerStrip = Math.min(one(278, height)!, height);
  const data = new Uint8Array(width * height);
  offsets.forEach((offset, i) => {
    const start = i * rowsPerStrip * width;
    const end = Math.min(start + rowsPerStrip * width, data.length);
    if (start >= end) return;
    const src = buf.subarray(offset, offset + counts[i]!);
    const target = data.subarray(start, end);
    if (compression === 5) lzwDecode(src, target);
    else target.set(src.subarray(0, target.length));
  });

  const [sx, sy] = scale as [number, number];
  const [i, j, , x, y] = tie as [number, number, number, number, number];
  return {
    width,
    height,
    data,
    originX: x - i * sx,
    originY: y + j * sy,
    pixelSizeX: sx,
    pixelSizeY: sy,
  };
}

// GRS80 / SWEREF 99 TM (= UTM zone 33N on GRS80), Gauss–Krüger series from Lantmäteriet.
const A = 6378137;
const F = 1 / 298.257222101;
const E2 = F * (2 - F);
const N = F / (2 - F);
const A_HAT = (A / (1 + N)) * (1 + N ** 2 / 4 + N ** 4 / 64);
const K0 = 0.9996;
const FALSE_EASTING = 500_000;
const CENTRAL_MERIDIAN = (15 * Math.PI) / 180;
const CA = E2;
const CB = (5 * E2 ** 2 - E2 ** 3) / 6;
const CC = (104 * E2 ** 3 - 45 * E2 ** 4) / 120;
const CD = (1237 * E2 ** 4) / 1260;
const BETA = [
  N / 2 - (2 * N ** 2) / 3 + (5 * N ** 3) / 16 + (41 * N ** 4) / 180,
  (13 * N ** 2) / 48 - (3 * N ** 3) / 5 + (557 * N ** 4) / 1440,
  (61 * N ** 3) / 240 - (103 * N ** 4) / 140,
  (49561 * N ** 4) / 161280,
];

/** Geodetic lon/lat (degrees) to SWEREF 99 TM `[easting, northing]` in metres. */
export function toSweref99Tm(lon: number, lat: number): [number, number] {
  const phi = (lat * Math.PI) / 180;
  const s2 = Math.sin(phi) ** 2;
  const phiStar =
    phi - Math.sin(phi) * Math.cos(phi) * (CA + CB * s2 + CC * s2 ** 2 + CD * s2 ** 3);
  const dLambda = (lon * Math.PI) / 180 - CENTRAL_MERIDIAN;
  const xi = Math.atan(Math.tan(phiStar) / Math.cos(dLambda));
  const eta = Math.atanh(Math.cos(phiStar) * Math.sin(dLambda));
  let x = xi;
  let y = eta;
  BETA.forEach((b, k) => {
    const m = 2 * (k + 1);
    x += b * Math.sin(m * xi) * Math.cosh(m * eta);
    y += b * Math.cos(m * xi) * Math.sinh(m * eta);
  });
  return [K0 * A_HAT * y + FALSE_EASTING, K0 * A_HAT * x];
}

/** A regular lon/lat grid; pixel (0, 0) is at the north-west corner. */
export interface LonLatGrid {
  west: number;
  north: number;
  lonStep: number;
  latStep: number;
  width: number;
  height: number;
}

const sampleIndexCache = new Map<string, Int32Array>();

/** For each grid pixel, the index of the SWEREF 99 TM raster pixel under its centre (or -1). */
function sampleIndices(raster: GeoRaster, grid: LonLatGrid): Int32Array {
  const key = JSON.stringify([
    raster.width,
    raster.height,
    raster.originX,
    raster.originY,
    raster.pixelSizeX,
    raster.pixelSizeY,
    grid,
  ]);
  let indices = sampleIndexCache.get(key);
  if (indices) return indices;
  indices = new Int32Array(grid.width * grid.height);
  for (let row = 0; row < grid.height; row++) {
    const lat = grid.north - (row + 0.5) * grid.latStep;
    for (let col = 0; col < grid.width; col++) {
      const [e, n] = toSweref99Tm(grid.west + (col + 0.5) * grid.lonStep, lat);
      const sx = Math.floor((e - raster.originX) / raster.pixelSizeX);
      const sy = Math.floor((raster.originY - n) / raster.pixelSizeY);
      indices[row * grid.width + col] =
        sx >= 0 && sy >= 0 && sx < raster.width && sy < raster.height ? sy * raster.width + sx : -1;
    }
  }
  if (sampleIndexCache.size > 8) sampleIndexCache.clear();
  sampleIndexCache.set(key, indices);
  return indices;
}

/** Nearest-neighbour resampling of a SWEREF 99 TM raster onto a lon/lat grid. */
export function reprojectToLonLat(raster: GeoRaster, grid: LonLatGrid, nodata: number): Uint8Array {
  const indices = sampleIndices(raster, grid);
  const out = new Uint8Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    const src = indices[i]!;
    out[i] = src < 0 ? nodata : raster.data[src]!;
  }
  return out;
}

export type Rgba = readonly [number, number, number, number];

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(data, crc32(head.subarray(4))), 0);
  return Buffer.concat([head, data, crc]);
}

/** 8-bit indexed PNG; each pixel value is an index into `palette` (with per-entry alpha). */
export function encodeIndexedPng(
  width: number,
  height: number,
  pixels: Uint8Array,
  palette: readonly Rgba[],
): Buffer {
  if (pixels.length !== width * height) throw new Error('Pixel count does not match size');
  if (palette.length < 1 || palette.length > 256)
    throw new Error('Palette must have 1–256 colours');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 3, 0, 0, 0], 8);
  const rows = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    rows.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('PLTE', Uint8Array.from(palette.flatMap(([r, g, b]) => [r, g, b]))),
    chunk('tRNS', Uint8Array.from(palette.map((c) => c[3]))),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
