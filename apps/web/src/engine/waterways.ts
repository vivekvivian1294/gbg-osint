import { decodeLine, type Feature } from '@gbg-osint/shared';
import {
  ArcType,
  Cartesian3,
  Color,
  GeometryInstance,
  Material,
  PolylineGeometry,
  PolylineMaterialAppearance,
  Primitive,
  type Scene,
} from 'cesium';
import { LocalFrame, resample, toPath } from './path';

interface FlowClass {
  widthPx: number;
  /** Distance between streaks and how fast they travel downstream (illustrative, not measured). */
  spacingM: number;
  speedMs: number;
  color: Color;
}

const CLASSES: Record<string, FlowClass> = {
  river: { widthPx: 7, spacingM: 70, speedMs: 14, color: new Color(0.25, 0.72, 0.95, 0.35) },
  canal: { widthPx: 5, spacingM: 50, speedMs: 6, color: new Color(0.25, 0.72, 0.95, 0.3) },
  stream: { widthPx: 3.5, spacingM: 40, speedMs: 9, color: new Color(0.3, 0.75, 0.95, 0.3) },
};
const STREAK = new Color(0.88, 0.97, 1.0, 0.95);
const PIECE_M = 300;
const VERTEX_SPACING_M = 12;
const HEIGHT_M = 1.5;
/** Above this camera height the streaks would be sub-pixel noise. */
const MAX_CAMERA_HEIGHT_M = 60_000;

// st.s runs 0..1 along each piece; pieces hold a whole number of streaks so they line up.
const FLOW_SOURCE = `
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  float phase = materialInput.st.s * repeat - offset;
  float f = fract(phase);
  float streak = smoothstep(0.45, 0.9, f) * (1.0 - smoothstep(0.9, 1.0, f));
  streak *= 1.0 - smoothstep(0.12, 0.35, fwidth(phase));
  float edge = 1.0 - abs(materialInput.st.t - 0.5) * 2.0;
  vec4 c = mix(color, streakColor, streak);
  material.emission = c.rgb;
  material.alpha = c.a * smoothstep(0.0, 0.5, edge);
  return material;
}
`;

export interface FlowPiece {
  cls: string;
  /** Streaks per piece. */
  repeat: number;
  pieceLengthM: number;
  /** Evenly spaced `[lon, lat]` points, so st.s is proportional to distance. */
  coords: [number, number][];
}

/** Splits waterway lines (drawn downstream) into evenly resampled pieces for the flow shader. */
export function flowPieces(features: readonly Feature[]): FlowPiece[] {
  const pieces: FlowPiece[] = [];
  for (const f of features) {
    const cls =
      typeof f.props?.class === 'string' && f.props.class in CLASSES ? f.props.class : 'stream';
    const coords = decodeLine(f.line);
    if (coords.length < 2) continue;
    const frame = new LocalFrame(coords[0]![0], coords[0]![1]);
    const path = toPath(coords.map(([lon, lat]) => frame.toXY(lon, lat)));
    const total = path[path.length - 1]!.d;
    if (total < 20) continue;
    const count = Math.max(1, Math.round(total / PIECE_M));
    const pieceLengthM = total / count;
    const repeat = Math.max(1, Math.round(pieceLengthM / CLASSES[cls]!.spacingM));
    const vertices = Math.max(2, Math.ceil(pieceLengthM / VERTEX_SPACING_M));
    for (let p = 0; p < count; p++) {
      const xy = resample(path, p * pieceLengthM, (p + 1) * pieceLengthM, vertices);
      pieces.push({
        cls,
        repeat,
        pieceLengthM,
        coords: xy.map(([x, y]) => frame.toLonLat(x, y)),
      });
    }
  }
  return pieces;
}

interface Bucket {
  primitive: Primitive;
  material: Material;
  /** Streak periods per second. */
  speed: number;
}

/** Animated streaks flowing downstream along rivers, streams and canals. */
export class WaterwayLayer {
  private buckets: Bucket[] = [];
  private visible = false;

  constructor(private readonly scene: Scene) {}

  set(features: readonly Feature[]): void {
    this.clear();
    const groups = new Map<
      string,
      { cls: string; repeat: number; length: number; instances: GeometryInstance[] }
    >();
    for (const piece of flowPieces(features)) {
      const key = `${piece.cls}:${piece.repeat}`;
      const group = groups.get(key) ?? {
        cls: piece.cls,
        repeat: piece.repeat,
        length: 0,
        instances: [],
      };
      group.length += piece.pieceLengthM;
      group.instances.push(
        new GeometryInstance({
          geometry: new PolylineGeometry({
            positions: piece.coords.map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat, HEIGHT_M)),
            width: CLASSES[piece.cls]!.widthPx,
            vertexFormat: PolylineMaterialAppearance.VERTEX_FORMAT,
            arcType: ArcType.NONE,
          }),
        }),
      );
      groups.set(key, group);
    }
    for (const g of groups.values()) {
      const cls = CLASSES[g.cls]!;
      const meanPiece = g.length / g.instances.length;
      const material = new Material({
        fabric: {
          uniforms: { offset: 0, repeat: g.repeat, color: cls.color, streakColor: STREAK },
          source: FLOW_SOURCE,
        },
        translucent: true,
      });
      const primitive = this.scene.primitives.add(
        new Primitive({
          geometryInstances: g.instances,
          appearance: new PolylineMaterialAppearance({ material, translucent: true }),
          asynchronous: false,
        }),
      );
      this.buckets.push({ primitive, material, speed: (cls.speedMs * g.repeat) / meanPiece });
    }
    this.scene.requestRender();
  }

  /** Advances the animation; returns true while streaks are on screen. */
  update(nowMs: number): boolean {
    const visible =
      this.buckets.length > 0 &&
      this.scene.camera.positionCartographic.height < MAX_CAMERA_HEIGHT_M;
    if (visible !== this.visible) {
      this.visible = visible;
      for (const b of this.buckets) b.primitive.show = visible;
    }
    if (!visible) return false;
    const seconds = nowMs / 1000;
    for (const b of this.buckets) b.material.uniforms.offset = (seconds * b.speed) % 1;
    return true;
  }

  clear(): void {
    if (!this.scene.isDestroyed()) {
      for (const b of this.buckets) this.scene.primitives.remove(b.primitive);
    }
    this.buckets = [];
    this.visible = false;
  }
}
