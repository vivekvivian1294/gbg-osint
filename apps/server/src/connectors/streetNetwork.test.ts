import { EntitySchema } from '@gbg-osint/shared';
import { describe, expect, it } from 'vitest';
import {
  LineGraph,
  MATCH_OPTIONS,
  StreetNetwork,
  clipLine,
  matchMove,
  parseNetworkTile,
  tilesNear,
  type NetworkTile,
} from './streetNetwork';
import { fromLocalM, toLocalM } from './util';
import { networkTilesFor, parseVehicles } from './vasttrafik';

// --- Minimal protobuf writer for a vector tile fixture ---
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

function lineCommands(pts: number[]): number[] {
  const n = pts.length / 2;
  const cmds = [1 | (1 << 3), zz(pts[0]!), zz(pts[1]!), 2 | ((n - 1) << 3)];
  for (let i = 1; i < n; i++) {
    cmds.push(zz(pts[i * 2]! - pts[i * 2 - 2]!), zz(pts[i * 2 + 1]! - pts[i * 2 - 1]!));
  }
  return cmds;
}

const KEYS = ['class', 'subclass', 'service'];
const VALUES = ['transit', 'tram', 'minor', 'service', 'driveway', 'path', 'rail'];

function transportationTile(features: { tags: number[]; line: number[] }[]): Uint8Array {
  const layer = [
    ...field(15, 0),
    ...varint(2),
    ...str(1, 'transportation'),
    ...features.flatMap((f) =>
      bytes(2, [
        ...packed(2, f.tags),
        ...field(3, 0),
        ...varint(2),
        ...packed(4, lineCommands(f.line)),
      ]),
    ),
    ...KEYS.flatMap((k) => str(3, k)),
    ...VALUES.flatMap((v) => bytes(4, str(1, v))),
    ...field(5, 0),
    ...varint(4096),
  ];
  return Uint8Array.from(bytes(3, layer));
}

const emptyTile = (x: number, y: number): NetworkTile => ({
  x,
  y,
  tram: [],
  road: [],
  service: [],
  rail: [],
});

describe('street network tiles', () => {
  it('clips lines to the tile so neighbouring tiles abut instead of overlapping', () => {
    expect(clipLine([100, 100, 4200, 100], 4096)).toEqual([[100, 100, 4096, 100]]);
    expect(clipLine([-50, 10, 50, 10, 50, -20, 80, -20, 80, 30], 4096)).toEqual([
      [0, 10, 50, 10, 50, 0],
      [80, 0, 80, 30],
    ]);
    expect(clipLine([5000, 0, 6000, 0], 4096)).toEqual([]);
  });

  it('sorts transportation lines into tram, road, service and rail networks', () => {
    const pbf = transportationTile([
      { tags: [0, 0, 1, 1], line: [100, 100, 4200, 100] },
      { tags: [0, 2], line: [100, 200, 100, 1000] },
      { tags: [0, 3, 2, 4], line: [300, 300, 400, 300] },
      { tags: [0, 5], line: [500, 500, 600, 600] },
      { tags: [0, 6, 1, 6], line: [0, 2000, 4096, 2000] },
    ]);
    const tile = parseNetworkTile(pbf, 8736, 4959);
    expect([tile.tram.length, tile.road.length, tile.service.length, tile.rail.length]).toEqual([
      1, 1, 0, 1,
    ]);
    const [x0, y0, x1, y1] = tile.tram[0]!;
    expect(y1).toBeCloseTo(y0!, 0);
    expect(x1! - x0!).toBeGreaterThan(1250);
    expect(x1! - x0!).toBeLessThan(1300);
    const [lon, lat] = fromLocalM([x0!, y0!]);
    expect(lon).toBeGreaterThan(11.9531);
    expect(lat).toBeLessThan(57.7166);
  });

  it('lists the tiles around a point', () => {
    expect(tilesNear(11.9746, 57.7089, 10)).toEqual([[8736, 4959]]);
    expect(tilesNear(11.9746, 57.7089, 2_000).length).toBeGreaterThanOrEqual(9);
  });

  it('stitches lines across tile edges', () => {
    const net = new StreetNetwork();
    net.add({ ...emptyTile(1, 1), road: [[0, 0, 100, 0]] });
    net.add({ ...emptyTile(2, 1), road: [[100.5, 0.6, 200, 0]] });
    const g = net.graphs.road;
    const path = g.route(g.snap(10, 0, 5)!, g.snap(190, 0, 5)!, 1_000);
    expect(path).toBeDefined();
    expect(net.has(2, 1)).toBe(true);
    expect(net.tileCount).toBe(2);
  });
});

describe('line graph', () => {
  it('merges shared vertices and joins line ends that stop on another line', () => {
    const g = new LineGraph();
    g.addLine([0, 0, 200, 0]);
    const ends = g.addLine([100, 0.9, 100, 100])!;
    expect(g.joinEnd(ends[0])).toBe(true);
    const path = g.route(g.snap(10, 0, 5)!, g.snap(100, 90, 5)!, 1_000)!;
    expect(path.map(([x, y]) => [Math.round(x), Math.round(y)])).toContainEqual([100, 0]);
    expect(g.segmentCount).toBe(4);
  });

  it('snaps to the street that runs the way the vehicle is going', () => {
    const g = new LineGraph();
    g.addLine([0, 0, 200, 0]);
    g.addLine([100, -100, 100, 0, 100, 100]);
    expect(g.snap(101, 1, 10)).toBeDefined();
    const north = g.snap(101.5, 1, 10, 0, 15)!;
    const east = g.snap(101, 1.5, 10, 90, 15)!;
    expect(north.x).toBeCloseTo(100);
    expect(east.y).toBeCloseTo(0);
    expect(g.snap(150, 50, 10)).toBeUndefined();
  });

  it('routes along the network within a cost limit', () => {
    const g = new LineGraph();
    g.addLine([0, 0, 100, 0, 100, 100]);
    const from = g.snap(20, 0, 5)!;
    const to = g.snap(100, 80, 5)!;
    expect(g.route(from, to, 1_000)).toEqual([
      [20, 0],
      [100, 0],
      [100, 80],
    ]);
    expect(g.route(from, to, 100)).toBeUndefined();
  });
});

describe('map matching', () => {
  const street = () => {
    const g = new LineGraph();
    g.addLine([0, 0, 100, 0, 100, 100]);
    return g;
  };

  it('snaps the first position and shows the street axis', () => {
    const m = matchMove(street(), undefined, 20, 3, MATCH_OPTIONS.road)!;
    expect(m).toMatchObject({ x: 20, y: 0, axis: 90, via: [] });
    expect(m.heading).toBeUndefined();
    expect(matchMove(street(), undefined, 20, 80, MATCH_OPTIONS.road)).toBeUndefined();
  });

  it('follows the street round a corner between updates', () => {
    const m = matchMove(street(), { x: 20, y: 0, heading: 90 }, 98, 60, MATCH_OPTIONS.road)!;
    expect(m.x).toBeCloseTo(100);
    expect(m.y).toBeCloseTo(60);
    expect(m.via).toHaveLength(1);
    expect(m.via[0]![0]).toBeCloseTo(100);
    expect(m.via[0]![1]).toBeCloseTo(0);
    expect(m.heading).toBeCloseTo(0);
  });

  it('holds still through GPS jitter and short backward jumps', () => {
    const prev = { x: 50, y: 0, heading: 90 };
    expect(matchMove(street(), prev, 51.5, 1, MATCH_OPTIONS.road)).toMatchObject({ x: 50, y: 0 });
    expect(matchMove(street(), prev, 40, 0, MATCH_OPTIONS.road)).toMatchObject({ x: 50, y: 0 });
    expect(matchMove(street(), prev, 60, 0, MATCH_OPTIONS.road)).toMatchObject({ x: 60, y: 0 });
  });

  it('keeps trams on the right-hand track of a double track', () => {
    const g = new LineGraph();
    g.addLine([0, 0, 200, 0]);
    g.addLine([0, -3.5, 200, -3.5]);
    const eastbound = matchMove(g, { x: 40, y: -3.5, heading: 90 }, 80, -1.5, MATCH_OPTIONS.tram);
    expect(eastbound?.y).toBeCloseTo(-3.5);
    const westbound = matchMove(g, { x: 120, y: 0, heading: 270 }, 80, -2, MATCH_OPTIONS.tram);
    expect(westbound?.y).toBeCloseTo(0);
  });
});

describe('västtrafik vehicles on the network', () => {
  const position = (lon: number, lat: number, mode = 'tram') => ({
    detailsReference: 'v1',
    line: { name: '6', transportMode: mode },
    latitude: lat,
    longitude: lon,
  });
  const [cx, cy] = toLocalM([11.9746, 57.7089]);
  const network = new StreetNetwork();
  for (let x = 8735; x <= 8737; x++)
    for (let y = 4958; y <= 4960; y++) network.add(emptyTile(x, y));
  const track = [cx, cy, cx, cy + 60, cx + 120, cy + 60];
  network.graphs.tram.addLine(track);

  it('snaps trams to the track and sends the route travelled', () => {
    const start = fromLocalM([cx + 4, cy + 5]);
    const first = parseVehicles([position(...start)], new Map(), 'a', network);
    expect(first.entities[0]).toMatchObject({ props: { matched: 'track' }, heading: 0 });
    const end = fromLocalM([cx + 80, cy + 64]);
    const second = parseVehicles(
      [position(...end)],
      first.tracks,
      '2026-10-23T12:00:15.000Z',
      network,
    );
    const e = second.entities[0]!;
    expect(e.via).toHaveLength(1);
    const [vx, vy] = toLocalM(e.via![0]!);
    expect(vx - cx).toBeCloseTo(0, 0);
    expect(vy - cy).toBeCloseTo(60, 0);
    expect(e.heading).toBeCloseTo(90, 0);
    expect(EntitySchema.safeParse(e).success).toBe(true);
  });

  it('leaves vehicles off the network (and ferries) where they are', () => {
    const far = fromLocalM([cx + 300, cy - 300]);
    const { entities } = parseVehicles([position(...far)], new Map(), 'a', network);
    expect(entities[0]!.props?.matched).toBeUndefined();
    const ferry = parseVehicles([position(...far, 'ferry')], new Map(), 'a', network);
    expect(ferry.entities[0]!.lon).toBeCloseTo(far[0], 9);
  });

  it('asks for network tiles around trams first', () => {
    const tiles = networkTilesFor(
      [position(11.9746, 57.7089, 'bus'), { ...position(11.99, 57.7089), detailsReference: 'v2' }],
      new Map(),
    );
    expect(tiles[0]).toEqual(tilesNear(11.99, 57.7089, 150)[0]);
    expect(tiles).toContainEqual([8736, 4959]);
  });
});
