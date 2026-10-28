import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { BUILDING_TILES, parseBuildingTile, tileX, tileY } from './buildings';
import { clipRing, decodeMvt, polygonsOf, ringArea } from './mvt';
import {
  decodeGeoTiff,
  encodeIndexedPng,
  lzwDecode,
  reprojectToLonLat,
  toSweref99Tm,
} from './raster';
import { parseRadarListing, radarPalette } from './smhiRadar';
import { parseKartaView, parsePanoramax, photoEntities, tileBounds } from './streetPhotos';

/** TIFF-style LZW encoder (MSB-first, early change) used to build test fixtures. */
function lzwEncode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let accBits = 0;
  let codeLen = 9;
  const write = (code: number) => {
    acc = (acc << codeLen) | code;
    accBits += codeLen;
    while (accBits >= 8) {
      out.push((acc >>> (accBits - 8)) & 0xff);
      accBits -= 8;
    }
    acc &= (1 << accBits) - 1;
  };
  let dict = new Map<string, number>();
  let next = 258;
  write(256);
  let w = '';
  for (const byte of data) {
    const wc = w ? `${w},${byte}` : String(byte);
    if (w === '' || dict.has(wc)) {
      w = wc;
      continue;
    }
    write(w.includes(',') ? dict.get(w)! : Number(w));
    dict.set(wc, next++);
    if (next + 1 > 1 << codeLen && codeLen < 12) codeLen++;
    if (next >= 4093) {
      write(256);
      dict = new Map();
      next = 258;
      codeLen = 9;
    }
    w = String(byte);
  }
  if (w) write(w.includes(',') ? dict.get(w)! : Number(w));
  write(257);
  if (accBits > 0) out.push((acc << (8 - accBits)) & 0xff);
  return Uint8Array.from(out);
}

function geoTiff(width: number, height: number, strips: Uint8Array[], compression: 1 | 5) {
  const rowsPerStrip = Math.ceil(height / strips.length);
  const tags: [number, number, number[]][] = [
    [256, 3, [width]],
    [257, 3, [height]],
    [258, 3, [8]],
    [259, 3, [compression]],
    [262, 3, [1]],
    [273, 4, strips.map(() => 0)],
    [277, 3, [1]],
    [278, 3, [rowsPerStrip]],
    [279, 4, strips.map((s) => s.length)],
    [33550, 12, [1000, 2000, 0]],
    [33922, 12, [0, 0, 0, 100_000, 7_000_000, 0]],
  ];
  const size: Record<number, number> = { 3: 2, 4: 4, 12: 8 };
  const ifdSize = 2 + tags.length * 12 + 4;
  let extra = 8 + ifdSize;
  const extraOffsets = tags.map(([, type, values]) => {
    const bytes = size[type]! * values.length;
    if (bytes <= 4) return -1;
    const at = extra;
    extra += bytes;
    return at;
  });
  const stripOffsets = strips.map((s) => {
    const at = extra;
    extra += s.length;
    return at;
  });
  tags[5]![2] = stripOffsets;
  const buf = new Uint8Array(extra);
  const view = new DataView(buf.buffer);
  buf.set([0x49, 0x49, 42, 0]);
  view.setUint32(4, 8, true);
  view.setUint16(8, tags.length, true);
  tags.forEach(([tag, type, values], i) => {
    const e = 10 + i * 12;
    view.setUint16(e, tag, true);
    view.setUint16(e + 2, type, true);
    view.setUint32(e + 4, values.length, true);
    const at = extraOffsets[i]! >= 0 ? extraOffsets[i]! : e + 8;
    values.forEach((v, k) => {
      const p = at + k * size[type]!;
      if (type === 3) view.setUint16(p, v, true);
      else if (type === 4) view.setUint32(p, v, true);
      else view.setFloat64(p, v, true);
    });
    if (extraOffsets[i]! >= 0) view.setUint32(e + 8, extraOffsets[i]!, true);
  });
  strips.forEach((s, i) => buf.set(s, stripOffsets[i]!));
  return buf;
}

describe('raster pipeline', () => {
  it('decodes TIFF LZW, including repeated runs', () => {
    const data = Uint8Array.from({ length: 5000 }, (_, i) =>
      i % 7 === 0 ? 200 : i % 300 < 150 ? 0 : 255,
    );
    const out = new Uint8Array(data.length);
    expect(lzwDecode(lzwEncode(data), out)).toBe(data.length);
    expect(out).toEqual(data);
  });

  it('reads stripped GeoTIFFs with their georeference', () => {
    const width = 6;
    const height = 4;
    const pixels = Uint8Array.from({ length: width * height }, (_, i) => i * 10);
    const strips = [pixels.subarray(0, 12), pixels.subarray(12)];
    for (const compression of [1, 5] as const) {
      const tif = geoTiff(
        width,
        height,
        compression === 5 ? strips.map(lzwEncode) : strips,
        compression,
      );
      const r = decodeGeoTiff(tif);
      expect(r).toMatchObject({
        width,
        height,
        originX: 100_000,
        originY: 7_000_000,
        pixelSizeX: 1000,
      });
      expect(r.data).toEqual(pixels);
    }
    expect(() => decodeGeoTiff(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow();
  });

  it('projects to SWEREF 99 TM', () => {
    const [e, n] = toSweref99Tm(15, 45);
    expect(e).toBeCloseTo(500_000, 3);
    expect(n).toBeCloseTo(4_982_950.4, 1);
    const [gbgE, gbgN] = toSweref99Tm(11.9746, 57.7089);
    expect(Math.abs(gbgE - 319_760)).toBeLessThan(200);
    expect(Math.abs(gbgN - 6_400_330)).toBeLessThan(200);
    const [west] = toSweref99Tm(14, 60);
    const [east] = toSweref99Tm(16, 60);
    expect(west + east).toBeCloseTo(1_000_000, 3);
  });

  it('resamples onto a lon/lat grid with nodata outside the source', () => {
    const [e, n] = toSweref99Tm(12, 57.7);
    const raster = {
      width: 2,
      height: 1,
      data: Uint8Array.from([7, 9]),
      originX: e - 1000,
      originY: n + 1000,
      pixelSizeX: 1000,
      pixelSizeY: 2000,
    };
    // Column centres ~500 m west, ~500 m east and ~1.5 km east of the raster's centre line.
    const grid = {
      west: 11.9832,
      north: 57.705,
      lonStep: 0.0168,
      latStep: 0.01,
      width: 3,
      height: 1,
    };
    expect([...reprojectToLonLat(raster, grid, 255)]).toEqual([7, 9, 255]);
  });

  it('writes valid indexed PNGs with transparency', () => {
    const png = encodeIndexedPng(3, 2, Uint8Array.from([0, 1, 2, 2, 1, 0]), [
      [0, 0, 0, 0],
      [255, 0, 0, 255],
      [0, 0, 255, 128],
    ]);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunks: Record<string, Buffer> = {};
    for (let p = 8; p < png.length;) {
      const len = png.readUInt32BE(p);
      chunks[png.toString('latin1', p + 4, p + 8)] = png.subarray(p + 8, p + 8 + len);
      p += 12 + len;
    }
    expect(Object.keys(chunks)).toEqual(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
    expect([...chunks.tRNS!]).toEqual([0, 255, 128]);
    expect([...inflateSync(chunks.IDAT!)]).toEqual([0, 0, 1, 2, 0, 2, 1, 0]);
  });

  it('colours radar reflectivity and hides no-echo and no-coverage pixels', () => {
    const palette = radarPalette();
    expect(palette).toHaveLength(256);
    expect(palette[0]![3]).toBe(0);
    expect(palette[255]![3]).toBe(0);
    expect(palette[60]![3]).toBe(0);
    const at = (dbz: number) => palette[Math.round((dbz + 30) / 0.4)]!;
    expect(at(10)[3]).toBeGreaterThan(100);
    expect(at(45)[0]).toBeGreaterThan(200);
    expect(at(45)[2]).toBeLessThan(60);
  });

  it('lists the latest radar GeoTIFF frames in time order', () => {
    const link = (key: string, ext: string) =>
      `https://opendata-download-radar.smhi.se/api/version/latest/area/sweden/product/comp/2026/10/27/${key}.${ext}`;
    const files = parseRadarListing({
      files: [
        {
          key: 'radar_2610271240',
          valid: '2026-10-27 12:40',
          formats: [{ key: 'tif', link: link('radar_2610271240', 'tif') }],
        },
        {
          key: 'radar_2610271235',
          valid: '2026-10-27 12:35',
          formats: [
            { key: 'png', link: link('radar_2610271235', 'png') },
            { key: 'tif', link: link('radar_2610271235', 'tif') },
          ],
        },
        {
          key: 'radar_sweden_comp_202610271240',
          valid: '2026-10-27 12:40',
          formats: [{ key: 'h5', link: link('x', 'h5') }],
        },
        {
          key: 'radar_2610271245',
          valid: '2026-10-27 12:45',
          formats: [{ key: 'tif', link: 'https://evil.example/radar.tif' }],
        },
      ],
    });
    expect(files.map((f) => [f.key, f.valid])).toEqual([
      ['radar_2610271235', '2026-10-27T12:35:00.000Z'],
      ['radar_2610271240', '2026-10-27T12:40:00.000Z'],
    ]);
  });
});

// --- Minimal protobuf writer for vector tile fixtures ---
const varint = (n: number): number[] => {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return out;
};
const field = (num: number, wt: number) => varint(num * 8 + wt);
const bytes = (num: number, data: number[]) => [...field(num, 2), ...varint(data.length), ...data];
const str = (num: number, s: string) => bytes(num, [...new TextEncoder().encode(s)]);
const zz = (n: number) => (n < 0 ? -2 * n - 1 : 2 * n);
const packed = (num: number, values: number[]) => bytes(num, values.flatMap(varint));

/** Polygon command stream for closed rings given as absolute x,y pairs. */
function polygonCommands(rings: number[][]): number[] {
  const cmds: number[] = [];
  let cx = 0;
  let cy = 0;
  for (const ring of rings) {
    const n = ring.length / 2;
    cmds.push(1 | (1 << 3), zz(ring[0]! - cx), zz(ring[1]! - cy));
    [cx, cy] = [ring[0]!, ring[1]!];
    cmds.push(2 | ((n - 1) << 3));
    for (let i = 1; i < n; i++) {
      cmds.push(zz(ring[i * 2]! - cx), zz(ring[i * 2 + 1]! - cy));
      [cx, cy] = [ring[i * 2]!, ring[i * 2 + 1]!];
    }
    cmds.push(7 | (1 << 3));
  }
  return cmds;
}

function buildingTile(features: { tags: number[]; rings: number[][] }[]): Uint8Array {
  const layer = [
    ...field(15, 0),
    ...varint(2),
    ...str(1, 'building'),
    ...features.flatMap((f) =>
      bytes(2, [
        ...packed(2, f.tags),
        ...field(3, 0),
        ...varint(3),
        ...packed(4, polygonCommands(f.rings)),
      ]),
    ),
    ...str(3, 'render_height'),
    ...str(3, 'render_min_height'),
    ...str(3, 'hide_3d'),
    ...bytes(4, [...field(5, 0), ...varint(24)]),
    ...bytes(4, [...field(5, 0), ...varint(0)]),
    ...bytes(4, [...field(7, 0), ...varint(1)]),
    ...bytes(4, [...field(3, 1), ...Array.from(new Uint8Array(new Float64Array([6.5]).buffer))]),
    ...field(5, 0),
    ...varint(4096),
  ];
  const other = [...field(15, 0), ...varint(2), ...str(1, 'poi'), ...field(5, 0), ...varint(4096)];
  return Uint8Array.from([...bytes(3, other), ...bytes(3, layer)]);
}

// Exterior rings are clockwise in tile coordinates (y down), holes counter-clockwise.
const square = (x0: number, y0: number, s: number) => [
  x0,
  y0,
  x0 + s,
  y0,
  x0 + s,
  y0 + s,
  x0,
  y0 + s,
];
const hole = (x0: number, y0: number, s: number) => [
  x0,
  y0,
  x0,
  y0 + s,
  x0 + s,
  y0 + s,
  x0 + s,
  y0,
];

describe('vector tiles and buildings', () => {
  it('decodes layers, properties and polygon rings', () => {
    const tile = buildingTile([
      { tags: [0, 0, 1, 1], rings: [square(100, 100, 50), hole(110, 110, 10)] },
    ]);
    const layers = decodeMvt(tile);
    expect(layers.map((l) => l.name)).toEqual(['poi', 'building']);
    const [f] = decodeMvt(tile, new Set(['building']))[0]!.features;
    expect(f).toMatchObject({ type: 3, properties: { render_height: 24, render_min_height: 0 } });
    expect(f!.geometry).toEqual([square(100, 100, 50), hole(110, 110, 10)]);
    expect(ringArea(f!.geometry[0]!)).toBeGreaterThan(0);
    expect(polygonsOf(f!.geometry)).toEqual([[square(100, 100, 50), hole(110, 110, 10)]]);
  });

  it('clips rings to the tile', () => {
    expect(clipRing(square(-50, 10, 100), 4096)).toEqual([0, 10, 50, 10, 50, 110, 0, 110]);
    expect(clipRing(square(5000, 10, 100), 4096)).toEqual([]);
  });

  it('turns building features into clipped, extruded footprints', () => {
    const tile = buildingTile([
      { tags: [0, 0, 1, 1], rings: [square(4000, 100, 200)] },
      { tags: [0, 3, 1, 1], rings: [square(10, 10, 2)] },
      { tags: [0, 0, 2, 2], rings: [square(500, 500, 50)] },
    ]);
    const parsed = parseBuildingTile(tile, 8736, 4960);
    expect(parsed).toMatchObject({ z: 14, x: 8736, y: 4960, extent: 4096 });
    expect(parsed.buildings).toEqual([[24, 0, [[[4000, 100, 4096, 100, 4096, 300, 4000, 300]]]]]);
  });

  it('only serves tiles around Gothenburg', () => {
    expect(tileX(11.9746, 14)).toBe(8736);
    expect(tileY(57.7089, 14)).toBe(4959);
    expect(tileY(57.7, 14)).toBe(4960);
    expect(BUILDING_TILES.minX).toBeLessThan(8736);
    expect(BUILDING_TILES.maxY).toBeGreaterThan(4960);
    expect(
      (BUILDING_TILES.maxX - BUILDING_TILES.minX + 1) *
        (BUILDING_TILES.maxY - BUILDING_TILES.minY + 1),
    ).toBeLessThan(1200);
  });
});

describe('street-level photos', () => {
  const bounds = tileBounds(17473, 9919, 15);

  it('computes tile bounds', () => {
    expect(bounds.west).toBeCloseTo(11.9641, 3);
    expect(bounds.east - bounds.west).toBeCloseTo(360 / 32768, 9);
    expect(bounds.north).toBeGreaterThan(bounds.south);
  });

  it('keeps Panoramax photos on known hosts inside the tile', () => {
    const photo = (id: string, host: string, lon = 11.966) => ({
      id,
      geometry: { coordinates: [lon, 57.705] },
      properties: {
        datetime: '2026-05-29T12:09:04+00:00',
        license: 'CC-BY-SA-4.0',
        'view:azimuth': 218,
      },
      providers: [
        { name: 'mapcomplete', roles: ['producer'] },
        { name: 'Jane Doe', roles: ['producer'] },
      ],
      assets: { thumb: { href: `https://${host}/t.jpg` }, sd: { href: `https://${host}/sd.jpg` } },
      links: [{ rel: 'via', href: 'https://panoramax.mapcomplete.org' }],
    });
    const photos = parsePanoramax(
      {
        features: [
          photo('4f3e9695-435f-4009-90bb-4db8a6789590', 'panoramax.mapcomplete.org'),
          photo('5f3e9695-435f-4009-90bb-4db8a6789590', 'evil.example'),
          photo('6f3e9695-435f-4009-90bb-4db8a6789590', 'panoramax.mapcomplete.org', 12.5),
          { id: 'not-a-photo' },
        ],
      },
      bounds,
    );
    expect(photos).toEqual([
      {
        id: 'pnx-4f3e9695-435f-4009-90bb-4db8a6789590',
        provider: 'panoramax',
        lon: 11.966,
        lat: 57.705,
        heading: 218,
        takenAt: '2026-05-29T12:09:04.000Z',
        author: 'Jane Doe',
        licence: 'CC-BY-SA-4.0',
        pageUrl:
          'https://panoramax.mapcomplete.org/#focus=pic&pic=4f3e9695-435f-4009-90bb-4db8a6789590',
        thumbUrl: 'https://panoramax.mapcomplete.org/t.jpg',
        imageUrl: 'https://panoramax.mapcomplete.org/sd.jpg',
      },
    ]);
  });

  it('parses KartaView photos and exposes only proxied image paths', () => {
    const photos = parseKartaView(
      {
        result: {
          data: [
            {
              id: '26240301',
              lat: '57.7050',
              lng: '11.9660',
              heading: '0',
              shotDate: '2017-04-05 13:42:42.000',
              sequenceId: '120299',
              sequenceIndex: '4806',
              fileurlTh: 'https://storage3.openstreetcam.org/files/photo/th/a.jpg',
              fileurlProc: 'https://storage3.openstreetcam.org/files/photo/proc/a.jpg',
            },
          ],
        },
      },
      bounds,
    );
    expect(photos).toHaveLength(1);
    expect(photos[0]).not.toHaveProperty('heading');
    expect(photos[0]).toMatchObject({
      takenAt: '2017-04-05T13:42:42.000Z',
      pageUrl: 'https://kartaview.org/details/120299/4806',
    });
    const [entity] = photoEntities(photos, 17473, 9919, '2026-10-27T12:00:00.000Z');
    expect(entity).toMatchObject({ id: 'kv-26240301', kind: 'photo', source: 'kartaview' });
    expect(JSON.stringify(entity)).not.toContain('openstreetcam');
    expect(entity!.props!.image).toBe(
      '/api/data/streetphotos/img/17473/9919/kv-26240301/image.jpg',
    );
  });
});
