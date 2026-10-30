import { encodeLine, type Feature } from '@gbg-osint/shared';
import { describe, expect, it } from 'vitest';
import { ACCENT, MeshBuilder } from './gltf';
import { LocalFrame, pointAlong, toPath } from './path';
import { Playback } from './playback';
import { carsAt, corridorFrom } from './traffic';
import { NO_TUNNELS, portalFade, TunnelMask } from './tunnels';
import { MODELS, shipModel, shipScale, type ModelKind } from './vehicleModels';
import { flowPieces } from './waterways';

function readGlb(glb: Uint8Array) {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as {
    accessors: { count: number; min?: number[]; max?: number[] }[];
    buffers: { byteLength: number }[];
  };
  return {
    magic: view.getUint32(0, true),
    version: view.getUint32(4, true),
    length: view.getUint32(8, true),
    binLength: view.getUint32(20 + jsonLength, true),
    json,
  };
}

describe('MeshBuilder', () => {
  it('writes a valid binary glTF with positions, colours and indices', () => {
    const glb = new MeshBuilder().box([-1, -2, 0], [1, 2, 3], '#ff0000', true).toGlb();
    const { magic, version, length, binLength, json } = readGlb(glb);
    expect(magic).toBe(0x46546c67);
    expect(version).toBe(2);
    expect(length).toBe(glb.length);
    expect(length % 4).toBe(0);
    expect(binLength).toBe(json.buffers[0]!.byteLength);
    const [pos, col, idx] = json.accessors;
    expect(pos).toMatchObject({ count: 24, min: [-1, -2, 0], max: [1, 2, 3] });
    expect(col!.count).toBe(24);
    expect(idx!.count).toBe(36);
  });

  it('marks accent faces with alpha 0 and keeps their shade in red', () => {
    const glb = new MeshBuilder().box([0, 0, 0], [1, 1, 1], ACCENT).toGlb();
    const view = new DataView(glb.buffer);
    const jsonLength = view.getUint32(12, true);
    const binStart = 28 + jsonLength;
    const vertices = readGlb(glb).json.accessors[0]!.count;
    expect(vertices).toBe(20);
    const colours = glb.subarray(binStart + vertices * 12, binStart + vertices * 16);
    for (let i = 0; i < vertices; i++) {
      expect(colours[i * 4 + 3]).toBe(0);
      expect(colours[i * 4]).toBeGreaterThan(150);
    }
  });

  it('builds every vehicle and ship model within its nominal size', () => {
    for (const [kind, def] of Object.entries(MODELS) as [ModelKind, (typeof MODELS)[ModelKind]][]) {
      const { json } = readGlb(def.build().toGlb());
      const { min, max } = json.accessors[0]!;
      expect(max![0]! - min![0]!, kind).toBeLessThanOrEqual(def.length * 1.05);
      expect(max![1]! - min![1]!, kind).toBeLessThanOrEqual(def.beam * 1.6);
    }
  });

  it('picks ship models and scales them to AIS dimensions', () => {
    expect(shipModel('tanker')).toBe('tanker');
    expect(shipModel('other', 12)).toBe('motorboat');
    expect(shipModel('other', 60)).toBe('vessel');
    expect(shipScale('tug', 28, 10)).toEqual([1, 1, 1]);
    expect(shipScale('vessel')).toEqual([1, 1, 1]);
    expect(shipScale('vessel', 80)).toEqual([2, 2, 2]);
  });
});

describe('pointAlong', () => {
  const path = toPath([
    [0, 0],
    [100, 0],
    [100, 100],
  ]);

  it('interpolates along straight segments with a compass heading', () => {
    expect(pointAlong(path, 50)).toEqual({ x: 50, y: 0, heading: 90 });
    expect(pointAlong(path, 150)).toEqual({ x: 100, y: 50, heading: 0 });
    expect(pointAlong(path, 500)).toMatchObject({ x: 100, y: 100 });
  });

  it('rounds corners so the heading turns gradually', () => {
    const before = pointAlong(path, 92, 20);
    const at = pointAlong(path, 100, 20);
    const after = pointAlong(path, 108, 20);
    expect(before.heading!).toBeLessThan(90);
    expect(before.heading!).toBeGreaterThan(at.heading!);
    expect(at.heading!).toBeCloseTo(45, 0);
    expect(after.heading!).toBeLessThan(at.heading!);
    expect(at.x).toBeLessThan(100);
  });

  it('round-trips local metres', () => {
    const frame = new LocalFrame(11.97, 57.7);
    const [lon, lat] = frame.toLonLat(...frame.toXY(12.01, 57.72));
    expect(lon).toBeCloseTo(12.01, 9);
    expect(lat).toBeCloseTo(57.72, 9);
  });
});

describe('Playback', () => {
  const frame = new LocalFrame(11.97, 57.7);
  const at = (x: number, y: number) => frame.toLonLat(x, y);

  function run(p: Playback, from: number, to: number) {
    const positions: { t: number; x: number; y: number }[] = [];
    for (let t = from; t <= to; t += 50) {
      const s = p.advance(t);
      if (s) positions.push({ t, ...pos(s.lon, s.lat) });
    }
    return positions;
  }
  const pos = (lon: number, lat: number) => {
    const [x, y] = frame.toXY(lon, lat);
    return { x, y };
  };

  it('moves continuously between updates without jumps', () => {
    const p = new Playback(20_000);
    p.push(0, ...at(0, 0));
    p.push(15_000, ...at(150, 0));
    p.push(30_000, ...at(300, 0));
    p.push(45_000, ...at(450, 0));
    const track = run(p, 0, 70_000);
    let maxStep = 0;
    for (let i = 1; i < track.length; i++) {
      maxStep = Math.max(
        maxStep,
        Math.hypot(track[i]!.x - track[i - 1]!.x, track[i]!.y - track[i - 1]!.y),
      );
    }
    expect(maxStep).toBeLessThan(1.5);
    const mid = track.find((s) => s.t === 40_000)!;
    expect(mid.x).toBeGreaterThan(150);
    expect(mid.x).toBeLessThan(300);
  });

  it('eases to a halt at the last position when updates stop, then resumes smoothly', () => {
    const p = new Playback(5_000);
    p.push(0, ...at(0, 0));
    p.push(10_000, ...at(100, 0));
    const stopped = run(p, 0, 40_000);
    const end = stopped.at(-1)!;
    expect(end.x).toBeCloseTo(100, 0);
    expect(end.x).toBeLessThanOrEqual(100);
    p.push(60_000, ...at(200, 0));
    const resumed = run(p, 40_050, 80_000);
    expect(Math.abs(resumed[0]!.x - end.x)).toBeLessThan(1);
    expect(resumed.at(-1)!.x).toBeCloseTo(200, 0);
  });

  it('starts over when the next position is implausibly far away', () => {
    const p = new Playback(5_000);
    p.push(0, ...at(0, 0));
    p.advance(0);
    p.push(15_000, ...at(5_000, 0));
    const s = p.advance(15_050)!;
    expect(pos(s.lon, s.lat).x).toBeCloseTo(5_000, 0);
  });

  /** Distance from the L-shaped route (0,0) → (100,0) → (100,100). */
  const offRoute = ({ x, y }: { x: number; y: number }) =>
    Math.min(
      x <= 100 ? Math.abs(y) : Math.hypot(x - 100, y),
      y >= 0 ? Math.abs(x - 100) : Math.hypot(x - 100, y),
    );

  it('follows the route travelled between updates instead of cutting corners', () => {
    const p = new Playback(5_000);
    p.push(0, ...at(0, 0));
    p.push(20_000, ...at(100, 100), undefined, [at(100, 0)]);
    const track = run(p, 0, 40_000);
    expect(Math.max(...track.map(offRoute))).toBeLessThan(7);
    expect(track.at(-1)!.y).toBeCloseTo(100, 0);
    // Steady speed along the 200 m route: halfway in time is near the corner.
    const half = track.find((s) => s.t === 15_000)!;
    expect(Math.hypot(half.x - 100, half.y)).toBeLessThan(15);
  });

  it('keeps a lane offset to the right of the direction of travel', () => {
    const p = new Playback(1_000);
    p.laneOffsetM = 1.6;
    p.push(0, ...at(0, 0));
    p.push(10_000, ...at(100, 0));
    const s = run(p, 0, 8_000).at(-1)!;
    expect(s.y).toBeCloseTo(-1.6, 1);
  });

  it('poses articulated sections along the path so they bend through curves', () => {
    const p = new Playback(5_000);
    p.push(0, ...at(0, 0), 90);
    const ahead = p.sectionPose(10, 5)!;
    expect(pos(ahead.lon, ahead.lat).x).toBeCloseTo(10, 1);
    expect(ahead.heading).toBeCloseTo(90, 5);
    p.push(20_000, ...at(100, 100), undefined, [at(100, 0)]);
    let best = { t: 0, diff: Infinity };
    for (let t = 0; t <= 40_000; t += 50) {
      const h = p.advance(t)?.heading;
      if (h !== undefined && Math.abs(h - 45) < best.diff) best = { t, diff: Math.abs(h - 45) };
    }
    const q = new Playback(5_000);
    q.push(0, ...at(0, 0), 90);
    q.push(20_000, ...at(100, 100), undefined, [at(100, 0)]);
    for (let t = 0; t <= best.t; t += 50) q.advance(t);
    const front = q.sectionPose(10.15, 4.75)!;
    const rear = q.sectionPose(-10.15, 4.75)!;
    expect(front.heading).toBeLessThan(45);
    expect(rear.heading).toBeGreaterThan(55);
    expect(offRoute(pos(front.lon, front.lat))).toBeLessThan(7);
    expect(offRoute(pos(rear.lon, rear.lat))).toBeLessThan(7);
  });
});

const feature = (props: Record<string, unknown>, coords: [number, number][]): Feature => ({
  id: 'f1',
  source: 'test',
  kind: 'traffic',
  line: encodeLine(coords),
  ts: '2026-10-23T13:00:00.000Z',
  props,
});

describe('flowPieces', () => {
  it('splits waterways into evenly resampled pieces with whole streak counts', () => {
    const frame = new LocalFrame(11.97, 57.7);
    const line = [frame.toLonLat(0, 0), frame.toLonLat(900, 0)];
    const pieces = flowPieces([{ ...feature({ class: 'river' }, line), kind: 'waterway' }]);
    expect(pieces).toHaveLength(3);
    for (const p of pieces) {
      expect(p.cls).toBe('river');
      expect(Number.isInteger(p.repeat)).toBe(true);
      expect(p.pieceLengthM).toBeCloseTo(300, 0);
      const xs = p.coords.map(([lon, lat]) => frame.toXY(lon, lat)[0]);
      const steps = xs.slice(1).map((x, i) => x - xs[i]!);
      for (const s of steps) expect(s).toBeCloseTo(steps[0]!, 3);
    }
  });
});

describe('traffic corridors', () => {
  const frame = new LocalFrame(11.97, 57.7);
  const line: [number, number][] = [frame.toLonLat(0, 0), frame.toLonLat(600, 0)];

  it('derives car count from flow and speed, capped at jam density', () => {
    const free = corridorFrom(feature({ flowVehH: 1200, speedKmh: 60, lanes: 2 }, line))!;
    expect(free.lanes.flatMap((l) => l.cars)).toHaveLength(12);
    const jam = corridorFrom(feature({ flowVehH: 3000, speedKmh: 1, lanes: 1 }, line))!;
    expect(jam.lanes[0]!.cars.length).toBeLessThanOrEqual(40);
    expect(
      corridorFrom(feature({ flowVehH: 0, speedKmh: 0, lanes: 1 }, line))!.lanes[0]!.cars,
    ).toEqual([]);
  });

  it('moves cars along the road at the measured speed and keeps them in their lanes', () => {
    const c = corridorFrom(feature({ flowVehH: 600, speedKmh: 36, lanes: 2 }, line))!;
    const t0 = carsAt(c, 0);
    const t1 = carsAt(c, 1);
    const [x0] = frame.toXY(t0[0]!.lon, t0[0]!.lat);
    const [x1] = frame.toXY(t1[0]!.lon, t1[0]!.lat);
    expect(x1 - x0).toBeCloseTo(10, 0);
    expect(t0[0]!.heading).toBeCloseTo(90, 5);
    const ys = new Set(t0.map((car) => Math.round(frame.toXY(car.lon, car.lat)[1])));
    expect([...ys].sort()).toEqual([-2, 2]);
  });

  it('draws no cars inside a tunnel and fades them at the portals', () => {
    const tunnel = new TunnelMask([
      { ...feature({}, [frame.toLonLat(200, 0), frame.toLonLat(400, 0)]), kind: 'tunnel' },
    ]);
    const c = corridorFrom(feature({ flowVehH: 2400, speedKmh: 36, lanes: 1 }, line), tunnel)!;
    expect(c.hidden).toHaveLength(1);
    expect(Math.abs(c.hidden[0]![0] - 200)).toBeLessThanOrEqual(6);
    expect(Math.abs(c.hidden[0]![1] - 400)).toBeLessThanOrEqual(6);
    for (const t of [0, 7, 19]) {
      for (const car of carsAt(c, t)) {
        const [x] = frame.toXY(car.lon, car.lat);
        if (x > 207 && x < 393) expect(car.scale).toBe(0);
        if ((x > 30 && x < 165) || (x > 435 && x < 570)) expect(car.scale).toBe(1);
      }
    }
  });
});

describe('tunnel mask', () => {
  const frame = new LocalFrame(11.97, 57.7);
  const at = (x: number, y: number) => frame.toLonLat(x, y);
  const mask = new TunnelMask([
    { ...feature({}, [at(0, 0), at(300, 0)]), kind: 'tunnel' },
    { ...feature({}, [at(0, 500), at(300, 500)]), kind: 'waterway' },
  ]);

  it('covers points on a tunnel when moving along it, not across it', () => {
    expect(mask.size).toBe(1);
    expect(mask.covers(...at(150, 3), 90)).toBe(true);
    expect(mask.covers(...at(150, 3), 270)).toBe(true);
    expect(mask.covers(...at(150, 3))).toBe(true);
    expect(mask.covers(...at(150, 3), 0)).toBe(false);
    expect(mask.covers(...at(150, 20), 90)).toBe(false);
    expect(mask.covers(...at(150, 500), 90)).toBe(false);
    expect(NO_TUNNELS.covers(...at(150, 0))).toBe(false);
  });

  it('splits a road into its open and tunnel parts', () => {
    const road = [at(-200, 4), at(500, 4)];
    const { surface, tunnel } = mask.split(road, 6);
    expect(tunnel).toHaveLength(1);
    expect(surface).toHaveLength(2);
    const xs = (part: readonly (readonly [number, number])[]) =>
      part.map(([lon, lat]) => Math.round(frame.toXY(lon, lat)[0]));
    expect(xs(tunnel[0]!)[0]).toBeCloseTo(0, -1);
    expect(xs(tunnel[0]!).at(-1)).toBeCloseTo(300, -1);
    expect(xs(surface[0]!)[0]).toBe(-200);
    expect(xs(surface[1]!).at(-1)).toBe(500);
    // A street crossing above the tunnel is not in it.
    expect(mask.split([at(150, -200), at(150, 200)], 6).tunnel).toEqual([]);
    expect(portalFade(100, [[200, 400]], 25)).toBe(1);
    expect(portalFade(190, [[200, 400]], 25)).toBeCloseTo(0.4, 5);
    expect(portalFade(300, [[200, 400]], 25)).toBe(0);
  });
});
