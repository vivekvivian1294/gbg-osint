/** Minimal Mapbox Vector Tile (v2) decoder: layers, properties and tile-space geometry. */

export type MvtValue = string | number | boolean;

export interface MvtFeature {
  /** 1 point, 2 line, 3 polygon. */
  type: number;
  properties: Record<string, MvtValue>;
  /** Rings or lines as flat `[x0, y0, x1, y1, …]` arrays in tile units (0…extent). */
  geometry: number[][];
}

export interface MvtLayer {
  name: string;
  extent: number;
  features: MvtFeature[];
}

class Reader {
  pos: number;

  constructor(
    private readonly buf: Uint8Array,
    start = 0,
    readonly end = buf.length,
  ) {
    this.pos = start;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  varint(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (this.pos >= this.end) throw new Error('Truncated varint');
      const byte = this.buf[this.pos++]!;
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
      shift += 7;
      if (shift > 63) throw new Error('Varint too long');
    }
  }

  /** Field number and wire type of the next key. */
  key(): [number, number] {
    const k = this.varint();
    return [Math.floor(k / 8), k % 8];
  }

  /** Returns a reader over a length-delimited field and skips past it. */
  sub(): Reader {
    const len = this.varint();
    const start = this.pos;
    this.pos += len;
    if (this.pos > this.end) throw new Error('Truncated field');
    return new Reader(this.buf, start, this.pos);
  }

  string(): string {
    const r = this.sub();
    return new TextDecoder().decode(this.buf.subarray(r.pos, r.end));
  }

  fixed(bytes: 4 | 8): number {
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, bytes);
    this.pos += bytes;
    return bytes === 4 ? view.getFloat32(0, true) : view.getFloat64(0, true);
  }

  skip(wireType: number): void {
    if (wireType === 0) this.varint();
    else if (wireType === 1) this.pos += 8;
    else if (wireType === 2) this.sub();
    else if (wireType === 5) this.pos += 4;
    else throw new Error(`Unsupported wire type ${wireType}`);
  }

  /** Packed or single varints of a repeated field. */
  varints(wireType: number, into: number[]): void {
    if (wireType !== 2) {
      into.push(this.varint());
      return;
    }
    const r = this.sub();
    while (!r.done) into.push(r.varint());
  }
}

const zigzag = (n: number) => (n % 2 === 1 ? -(n + 1) / 2 : n / 2);

function readValue(r: Reader): MvtValue | undefined {
  let value: MvtValue | undefined;
  while (!r.done) {
    const [field, wt] = r.key();
    if (field === 1 && wt === 2) value = r.string();
    else if (field === 2 && wt === 5) value = r.fixed(4);
    else if (field === 3 && wt === 1) value = r.fixed(8);
    else if ((field === 4 || field === 5) && wt === 0) value = r.varint();
    else if (field === 6 && wt === 0) value = zigzag(r.varint());
    else if (field === 7 && wt === 0) value = r.varint() !== 0;
    else r.skip(wt);
  }
  return value;
}

function decodeGeometry(commands: readonly number[]): number[][] {
  const parts: number[][] = [];
  let current: number[] | undefined;
  let x = 0;
  let y = 0;
  let i = 0;
  while (i < commands.length) {
    const cmd = commands[i++]!;
    const id = cmd & 7;
    const count = cmd >> 3;
    if (id === 7) {
      current = undefined;
      continue;
    }
    if (id !== 1 && id !== 2) break;
    for (let k = 0; k < count && i + 1 < commands.length; k++) {
      x += zigzag(commands[i++]!);
      y += zigzag(commands[i++]!);
      if (id === 1 || !current) {
        current = [];
        parts.push(current);
      }
      current.push(x, y);
    }
  }
  return parts;
}

function readFeature(r: Reader, keys: readonly string[], values: readonly MvtValue[]): MvtFeature {
  const tags: number[] = [];
  const commands: number[] = [];
  let type = 0;
  while (!r.done) {
    const [field, wt] = r.key();
    if (field === 2) r.varints(wt, tags);
    else if (field === 3 && wt === 0) type = r.varint();
    else if (field === 4) r.varints(wt, commands);
    else r.skip(wt);
  }
  const properties: Record<string, MvtValue> = {};
  for (let i = 0; i + 1 < tags.length; i += 2) {
    const key = keys[tags[i]!];
    const value = values[tags[i + 1]!];
    if (key !== undefined && value !== undefined) properties[key] = value;
  }
  return { type, properties, geometry: decodeGeometry(commands) };
}

/** Decodes the named layers of a tile (all layers when `only` is omitted). */
export function decodeMvt(buf: Uint8Array, only?: ReadonlySet<string>): MvtLayer[] {
  const layers: MvtLayer[] = [];
  const tile = new Reader(buf);
  while (!tile.done) {
    const [field, wt] = tile.key();
    if (field !== 3 || wt !== 2) {
      tile.skip(wt);
      continue;
    }
    const r = tile.sub();
    let name = '';
    let extent = 4096;
    const keys: string[] = [];
    const values: MvtValue[] = [];
    const rawFeatures: Reader[] = [];
    while (!r.done) {
      const [lf, lwt] = r.key();
      if (lf === 1 && lwt === 2) name = r.string();
      else if (lf === 2 && lwt === 2) rawFeatures.push(r.sub());
      else if (lf === 3 && lwt === 2) keys.push(r.string());
      else if (lf === 4 && lwt === 2) values.push(readValue(r.sub()) ?? '');
      else if (lf === 5 && lwt === 0) extent = r.varint();
      else r.skip(lwt);
    }
    if (only && !only.has(name)) continue;
    layers.push({ name, extent, features: rawFeatures.map((f) => readFeature(f, keys, values)) });
  }
  return layers;
}

/** Surveyor's formula in tile coordinates; positive for exterior rings (MVT spec 4.3.4.4). */
export function ringArea(ring: readonly number[]): number {
  let sum = 0;
  const n = ring.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    sum += ring[i]! * ring[j + 1]! - ring[j]! * ring[i + 1]!;
  }
  return sum / 2;
}

/** Groups polygon rings into `[exterior, ...holes]` per the ring winding. */
export function polygonsOf(rings: readonly number[][]): number[][][] {
  const polygons: number[][][] = [];
  for (const ring of rings) {
    const area = ringArea(ring);
    if (area > 0) polygons.push([ring]);
    else if (area < 0) polygons.at(-1)?.push(ring);
  }
  return polygons;
}

/** Sutherland–Hodgman clip of a closed ring (no repeated end point) to `[0, size]²`. */
export function clipRing(ring: readonly number[], size: number): number[] {
  let points = [...ring];
  const edges: ((x: number, y: number) => number)[] = [
    (x) => x,
    (x) => size - x,
    (_x, y) => y,
    (_x, y) => size - y,
  ];
  for (const inside of edges) {
    const out: number[] = [];
    const n = points.length;
    for (let i = 0; i < n; i += 2) {
      const ax = points[i]!;
      const ay = points[i + 1]!;
      const bx = points[(i + 2) % n]!;
      const by = points[(i + 3) % n]!;
      const da = inside(ax, ay);
      const db = inside(bx, by);
      if (da >= 0) out.push(ax, ay);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db);
        out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
      }
    }
    points = out;
    if (points.length < 6) return [];
  }
  return points;
}
