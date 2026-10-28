/** Local model frame: x forward, y left, z up, metres. */
export type Vec3 = readonly [number, number, number];

/** `'#rrggbb'`, or `ACCENT` for parts recoloured per instance (line colour, car paint). */
export type Paint = string;
export const ACCENT: Paint = 'accent';

const LIGHT: Vec3 = normalize([0.45, 0.35, 0.82]);
const AMBIENT = 0.62;

function normalize([x, y, z]: Vec3): Vec3 {
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Flat shading baked into vertex colours so models read the same at any time of day. */
function shadeFor(normal: Vec3): number {
  const n = normalize(normal);
  const lambert = Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
  return AMBIENT + (1 - AMBIENT) * lambert;
}

function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function parseHex(hex: string): Vec3 {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`Invalid colour: ${hex}`);
  return [
    srgbToLinear(parseInt(m[1]!, 16)),
    srgbToLinear(parseInt(m[2]!, 16)),
    srgbToLinear(parseInt(m[3]!, 16)),
  ];
}

const toByte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

/**
 * Builds a flat-shaded, vertex-coloured triangle mesh and writes it as a binary glTF. Vertex
 * colours are linear; accent faces have alpha 0 and carry their shade in the red channel.
 */
export class MeshBuilder {
  private readonly positions: number[] = [];
  private readonly colors: number[] = [];
  private readonly indices: number[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  /** Convex planar polygon (3+ corners, any winding; the material is double-sided). */
  face(corners: readonly Vec3[], paint: Paint, normalHint?: Vec3): this {
    if (corners.length < 3) return this;
    let normal = cross(sub(corners[1]!, corners[0]!), sub(corners[2]!, corners[0]!));
    if (
      normalHint &&
      normal[0] * normalHint[0] + normal[1] * normalHint[1] + normal[2] * normalHint[2] < 0
    ) {
      normal = [-normal[0], -normal[1], -normal[2]];
    }
    const shade = shadeFor(normal);
    const rgba =
      paint === ACCENT
        ? [toByte(shade), 0, 0, 0]
        : [...parseHex(paint).map((c) => toByte(c * shade)), 255];
    const base = this.vertexCount;
    for (const c of corners) {
      this.positions.push(c[0], c[1], c[2]);
      this.colors.push(...rgba);
    }
    for (let i = 1; i < corners.length - 1; i++) this.indices.push(base, base + i, base + i + 1);
    return this;
  }

  /** Axis-aligned box; the bottom face is left out unless `bottom` is set. */
  box(min: Vec3, max: Vec3, paint: Paint, bottom = false): this {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    this.face(
      [
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
      ],
      paint,
      [0, 0, 1],
    );
    this.face(
      [
        [x1, y0, z0],
        [x1, y1, z0],
        [x1, y1, z1],
        [x1, y0, z1],
      ],
      paint,
      [1, 0, 0],
    );
    this.face(
      [
        [x0, y0, z0],
        [x0, y1, z0],
        [x0, y1, z1],
        [x0, y0, z1],
      ],
      paint,
      [-1, 0, 0],
    );
    this.face(
      [
        [x0, y1, z0],
        [x1, y1, z0],
        [x1, y1, z1],
        [x0, y1, z1],
      ],
      paint,
      [0, 1, 0],
    );
    this.face(
      [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y0, z1],
        [x0, y0, z1],
      ],
      paint,
      [0, -1, 0],
    );
    if (bottom)
      this.face(
        [
          [x0, y0, z0],
          [x1, y0, z0],
          [x1, y1, z0],
          [x0, y1, z0],
        ],
        paint,
        [0, 0, -1],
      );
    return this;
  }

  /** Vertical extrusion of a convex footprint given counter-clockwise in the xy plane. */
  prism(
    footprint: readonly (readonly [number, number])[],
    z0: number,
    z1: number,
    paint: Paint,
    top: Paint = paint,
  ): this {
    const n = footprint.length;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = footprint[i]!;
      const [bx, by] = footprint[(i + 1) % n]!;
      this.face(
        [
          [ax, ay, z0],
          [bx, by, z0],
          [bx, by, z1],
          [ax, ay, z1],
        ],
        paint,
        [by - ay, -(bx - ax), 0],
      );
    }
    return this.face(
      footprint.map(([x, y]): Vec3 => [x, y, z1]),
      top,
      [0, 0, 1],
    );
  }

  toGlb(): Uint8Array {
    const count = this.vertexCount;
    if (count === 0) throw new Error('Empty mesh');
    const positions = new Float32Array(this.positions);
    const colors = new Uint8Array(this.colors);
    const wide = count > 65_535;
    const indices = wide ? new Uint32Array(this.indices) : new Uint16Array(this.indices);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i++) {
      const axis = i % 3;
      min[axis] = Math.min(min[axis]!, positions[i]!);
      max[axis] = Math.max(max[axis]!, positions[i]!);
    }
    const posBytes = positions.byteLength;
    const colBytes = colors.byteLength;
    const idxBytes = indices.byteLength;
    const binLength = align4(posBytes + colBytes + idxBytes);
    const bin = new Uint8Array(binLength);
    bin.set(new Uint8Array(positions.buffer), 0);
    bin.set(colors, posBytes);
    bin.set(new Uint8Array(indices.buffer), posBytes + colBytes);

    const json = {
      asset: { version: '2.0', generator: 'gbg-osint' },
      extensionsUsed: ['KHR_materials_unlit'],
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [
        {
          primitives: [
            { attributes: { POSITION: 0, COLOR_0: 1 }, indices: 2, material: 0, mode: 4 },
          ],
        },
      ],
      materials: [
        {
          pbrMetallicRoughness: {
            baseColorFactor: [1, 1, 1, 1],
            metallicFactor: 0,
            roughnessFactor: 1,
          },
          doubleSided: true,
          extensions: { KHR_materials_unlit: {} },
        },
      ],
      buffers: [{ byteLength: binLength }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: posBytes, target: 34962 },
        { buffer: 0, byteOffset: posBytes, byteLength: colBytes, target: 34962 },
        { buffer: 0, byteOffset: posBytes + colBytes, byteLength: idxBytes, target: 34963 },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count, type: 'VEC3', min, max },
        { bufferView: 1, componentType: 5121, normalized: true, count, type: 'VEC4' },
        { bufferView: 2, componentType: wide ? 5125 : 5123, count: indices.length, type: 'SCALAR' },
      ],
    };
    const jsonRaw = new TextEncoder().encode(JSON.stringify(json));
    const jsonLength = align4(jsonRaw.length);
    const total = 12 + 8 + jsonLength + 8 + binLength;
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, total, true);
    view.setUint32(12, jsonLength, true);
    view.setUint32(16, 0x4e4f534a, true);
    out.set(jsonRaw, 20);
    out.fill(0x20, 20 + jsonRaw.length, 20 + jsonLength);
    view.setUint32(20 + jsonLength, binLength, true);
    view.setUint32(24 + jsonLength, 0x004e4942, true);
    out.set(bin, 28 + jsonLength);
    return out;
  }
}

function align4(n: number): number {
  return (n + 3) & ~3;
}

/** `data:` URI for a GLB; Cesium decodes these locally, so no network request or CSP entry. */
export function glbDataUri(glb: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < glb.length; i += 0x8000) {
    binary += String.fromCharCode(...glb.subarray(i, i + 0x8000));
  }
  return `data:model/gltf-binary;base64,${btoa(binary)}`;
}
