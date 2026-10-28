import {
  Axis,
  Cartesian3,
  Color,
  CustomShader,
  Ellipsoid,
  LightingModel,
  Math as CesiumMath,
  Matrix3,
  Matrix4,
  Model,
  Transforms,
  UniformType,
  type Scene,
} from 'cesium';
import { glbDataUri } from './gltf';
import { MODELS, type ModelKind } from './vehicleModels';

export interface ModelInstance {
  key: string;
  kind: ModelKind;
  position: Cartesian3;
  /** Compass heading in degrees. */
  heading: number;
  scale?: readonly [number, number, number];
  /** CSS colour for the accent parts (line colour, car paint, funnel). */
  accent: string;
  alpha?: number;
  pick?: unknown;
}

export interface ModelLayerOptions {
  /** Keeps distant models visible; 0 shows them at true size. */
  minimumPixelSize?: number;
  maximumScale?: number;
}

interface Slot {
  kind: ModelKind;
  shader: CustomShader;
  model: Model | undefined;
  key: string | undefined;
  pick: unknown;
  accent: string;
  alpha: number;
}

const ACCENT_SHADER = `
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  vec4 vertexColor = fsInput.attributes.color_0;
  if (vertexColor.a < 0.5) {
    material.diffuse = u_accent * vertexColor.r;
  }
  material.alpha = 1.0;
}
`;

const uris = new Map<ModelKind, string>();
function uriFor(kind: ModelKind): string {
  let uri = uris.get(kind);
  if (!uri) {
    uri = glbDataUri(MODELS[kind].build().toGlb());
    uris.set(kind, uri);
  }
  return uri;
}

function linearAccent(css: string): Cartesian3 {
  const c = Color.fromCssColorString(css) ?? Color.WHITE;
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return new Cartesian3(lin(c.red), lin(c.green), lin(c.blue));
}

const scratchEnu = new Matrix4();
const scratchRot = new Matrix3();
const scratchScale = new Cartesian3();

/**
 * Low-poly glTF models for nearby moving objects. Models are pooled per kind and reused as
 * objects come and go; `update` returns the keys whose model is actually on screen.
 */
export class ModelLayer {
  private readonly slots: Slot[] = [];
  private readonly byKey = new Map<string, Slot>();
  private destroyed = false;

  constructor(
    private readonly scene: Scene,
    private readonly options: ModelLayerOptions = {},
  ) {}

  update(instances: readonly ModelInstance[]): Set<string> {
    const wanted = new Set(instances.map((i) => i.key));
    for (const [key, slot] of this.byKey) {
      if (wanted.has(key)) continue;
      slot.key = undefined;
      slot.pick = undefined;
      if (slot.model) slot.model.show = false;
      this.byKey.delete(key);
    }
    const shown = new Set<string>();
    for (const inst of instances) {
      const slot = this.byKey.get(inst.key) ?? this.acquire(inst);
      slot.pick = inst.pick;
      if (slot.accent !== inst.accent) {
        slot.accent = inst.accent;
        slot.shader.setUniform('u_accent', linearAccent(inst.accent));
      }
      const model = slot.model;
      if (!model) continue;
      this.place(model, inst);
      const alpha = inst.alpha ?? 1;
      if (slot.alpha !== alpha) {
        slot.alpha = alpha;
        model.color = alpha < 1 ? Color.WHITE.withAlpha(alpha) : Color.WHITE;
      }
      model.show = true;
      if (model.ready) shown.add(inst.key);
    }
    return shown;
  }

  /** The `pick` of the instance currently shown by a picked model, if it is one of ours. */
  pickOf(picked: unknown): unknown {
    const primitive =
      picked && typeof picked === 'object' && 'primitive' in picked ? picked.primitive : undefined;
    if (!(primitive instanceof Model)) return undefined;
    return this.slots.find((s) => s.model === primitive && s.key !== undefined)?.pick;
  }

  destroy(): void {
    this.destroyed = true;
    for (const slot of this.slots) {
      if (slot.model && !this.scene.isDestroyed()) this.scene.primitives.remove(slot.model);
    }
    this.slots.length = 0;
    this.byKey.clear();
  }

  private acquire(inst: ModelInstance): Slot {
    let slot = this.slots.find((s) => s.kind === inst.kind && s.key === undefined);
    if (!slot) {
      slot = {
        kind: inst.kind,
        shader: new CustomShader({
          lightingModel: LightingModel.UNLIT,
          uniforms: { u_accent: { type: UniformType.VEC3, value: linearAccent(inst.accent) } },
          fragmentShaderText: ACCENT_SHADER,
        }),
        model: undefined,
        key: undefined,
        pick: undefined,
        accent: inst.accent,
        alpha: 1,
      };
      this.slots.push(slot);
      this.load(slot);
    }
    slot.key = inst.key;
    this.byKey.set(inst.key, slot);
    return slot;
  }

  private load(slot: Slot): void {
    Model.fromGltfAsync({
      url: uriFor(slot.kind),
      upAxis: Axis.Z,
      forwardAxis: Axis.X,
      customShader: slot.shader,
      show: false,
      minimumPixelSize: this.options.minimumPixelSize ?? 0,
      ...(this.options.maximumScale !== undefined && { maximumScale: this.options.maximumScale }),
    }).then(
      (model) => {
        if (this.destroyed || this.scene.isDestroyed()) {
          model.destroy();
          return;
        }
        slot.model = this.scene.primitives.add(model);
        model.readyEvent.addEventListener(() => this.scene.requestRender());
        this.scene.requestRender();
      },
      (err: unknown) => console.warn('Could not build 3D model', slot.kind, err),
    );
  }

  private place(model: Model, inst: ModelInstance): void {
    const enu = Transforms.eastNorthUpToFixedFrame(inst.position, Ellipsoid.WGS84, scratchEnu);
    const rot = Matrix3.fromRotationZ(CesiumMath.toRadians(90 - inst.heading), scratchRot);
    const [sx, sy, sz] = inst.scale ?? [1, 1, 1];
    Matrix3.multiplyByScale(rot, Cartesian3.fromElements(sx, sy, sz, scratchScale), rot);
    Matrix4.multiplyByMatrix3(enu, rot, model.modelMatrix);
  }
}
