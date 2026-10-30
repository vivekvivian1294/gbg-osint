import {
  Cartesian3,
  Ellipsoid,
  HeadingPitchRange,
  Math as CesiumMath,
  Matrix4,
  Transforms,
  type Scene,
} from 'cesium';
import type { MarkerSpec } from './markerSpec';
import type { MarkerRenderer } from './markers';
import { MODELS } from './vehicleModels';

const TRACK_PITCH = CesiumMath.toRadians(-30);
const DEFAULT_RANGE_M = 2_000;

/** Where the ride-along camera sits relative to the vehicle centre, and where it looks. */
export interface CabMount {
  /** Metres ahead of the centre along the heading (just past the front, so the body is hidden). */
  forward: number;
  up: number;
  pitchDeg: number;
}

const MOUNTS: Record<string, CabMount> = {
  tram: { forward: 15.3, up: 2.6, pitchDeg: -6 },
  bus: { forward: 6.3, up: 2.4, pitchDeg: -6 },
  train: { forward: 26.4, up: 3.2, pitchDeg: -4 },
  ferry: { forward: 15.6, up: 6.5, pitchDeg: -7 },
};

/** Cab view for a marker: driver's view for vehicles, bow view for ships, nose view for aircraft. */
export function cabMount(spec: Pick<MarkerSpec, 'icon' | 'model'>): CabMount {
  const model = spec.model;
  if (model && MOUNTS[model.kind]) return MOUNTS[model.kind]!;
  if (model) {
    const length = MODELS[model.kind].length * (model.scale?.[0] ?? 1);
    return { forward: length / 2 + 1, up: Math.max(5, length * 0.12), pitchDeg: -8 };
  }
  if (spec.icon === 'aircraft') return { forward: 25, up: -2, pitchDeg: -4 };
  return { forward: 3, up: 2.5, pitchDeg: -6 };
}

export type TrackView = 'chase' | 'cab';

/**
 * Locks the camera onto a moving marker. In chase view the camera keeps its offset while the
 * user can orbit and zoom; in cab view it rides along, looking where the object is heading.
 */
export class CameraTracker {
  private key: string | null = null;
  private view: TrackView = 'chase';
  private mount: CabMount = { forward: 0, up: 2, pitchDeg: -6 };
  private range = DEFAULT_RANGE_M;
  private readonly transform = new Matrix4();
  private readonly eye = new Cartesian3();
  private readonly local = new Cartesian3();

  constructor(
    private readonly scene: Scene,
    private readonly renderer: MarkerRenderer,
  ) {}

  get trackedKey(): string | null {
    return this.key;
  }

  /** Returns false if the marker isn't on the map (yet). */
  start(key: string, range: number): boolean {
    const position = this.renderer.positionOf(key);
    if (!position) return false;
    this.key = key;
    this.range = range;
    this.applyView();
    this.scene.requestRender();
    return true;
  }

  setView(view: TrackView): void {
    if (view === this.view) return;
    this.view = view;
    this.applyView();
  }

  stop(): void {
    if (this.scene.isDestroyed()) return;
    this.scene.screenSpaceCameraController.enableInputs = true;
    this.scene.screenSpaceCameraController.enableCollisionDetection = true;
    if (!this.key) return;
    this.key = null;
    this.scene.camera.lookAtTransform(Matrix4.IDENTITY);
  }

  /** Follows the target; returns 'lost' when it has disappeared from the map. */
  update(): 'idle' | 'following' | 'lost' {
    if (!this.key) return 'idle';
    const position = this.renderer.positionOf(this.key);
    if (!position) {
      this.stop();
      return 'lost';
    }
    Transforms.eastNorthUpToFixedFrame(position, Ellipsoid.WGS84, this.transform);
    if (this.view === 'chase') {
      this.scene.camera.lookAtTransform(this.transform);
      return 'following';
    }
    const heading = CesiumMath.toRadians(this.renderer.headingOf(this.key) ?? 0);
    const { forward, up, pitchDeg } = this.mount;
    Cartesian3.fromElements(
      Math.sin(heading) * forward,
      Math.cos(heading) * forward,
      up,
      this.local,
    );
    Matrix4.multiplyByPoint(this.transform, this.local, this.eye);
    const { camera } = this.scene;
    camera.lookAtTransform(Matrix4.IDENTITY);
    camera.setView({
      destination: this.eye,
      orientation: { heading, pitch: CesiumMath.toRadians(pitchDeg), roll: 0 },
    });
    return 'following';
  }

  private applyView(): void {
    const cab = Boolean(this.key && this.view === 'cab');
    const controller = this.scene.screenSpaceCameraController;
    controller.enableInputs = !cab;
    // The height clamp would lift a driver's-eye camera to the minimum zoom distance (50 m).
    controller.enableCollisionDetection = !cab;
    if (!this.key) return;
    const spec = this.renderer.specOf(this.key);
    if (spec) this.mount = cabMount(spec);
    const position = this.renderer.positionOf(this.key);
    if (this.view === 'chase' && position) {
      const { camera } = this.scene;
      Transforms.eastNorthUpToFixedFrame(position, Ellipsoid.WGS84, this.transform);
      camera.lookAtTransform(
        this.transform,
        new HeadingPitchRange(camera.heading, TRACK_PITCH, this.range),
      );
    }
  }
}
