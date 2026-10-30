import type { CameraState } from './cameraState';

export interface TourKeyframe {
  /** Seconds from the start of the tour. */
  at: number;
  camera: CameraState;
}

export interface Tour {
  id: string;
  title: string;
  summary: string;
  /** Layers switched on for the tour (added to the current ones). */
  layers?: readonly string[];
  keyframes: readonly TourKeyframe[];
}

export interface TourState {
  id: string;
  title: string;
  elapsed: number;
  duration: number;
}

const KEYS = ['lon', 'lat', 'height', 'heading', 'pitch'] as const;

export function tourDuration(tour: Pick<Tour, 'keyframes'>): number {
  return tour.keyframes.at(-1)?.at ?? 0;
}

/** Headings rewritten so consecutive keyframes never differ by more than 180°. */
function unwrapHeadings(frames: readonly TourKeyframe[]): number[] {
  const out: number[] = [];
  for (const f of frames) {
    const prev = out.at(-1);
    if (prev === undefined) {
      out.push(f.camera.heading);
      continue;
    }
    let h = f.camera.heading;
    while (h - prev > 180) h -= 360;
    while (h - prev < -180) h += 360;
    out.push(h);
  }
  return out;
}

/**
 * Camera at `t` seconds: a cubic Hermite spline through the keyframes (Catmull–Rom tangents
 * scaled for uneven spacing), easing in at the first keyframe and out at the last.
 */
export function sampleTour(frames: readonly TourKeyframe[], t: number): CameraState {
  const first = frames[0];
  if (!first) throw new Error('A tour needs at least one keyframe');
  const last = frames.at(-1)!;
  if (frames.length === 1 || t <= first.at) return first.camera;
  if (t >= last.at) return { ...last.camera, heading: ((last.camera.heading % 360) + 360) % 360 };
  let i = 0;
  while (i < frames.length - 2 && t > frames[i + 1]!.at) i++;
  const headings = unwrapHeadings(frames);
  const value = (k: number, key: (typeof KEYS)[number]) =>
    key === 'heading' ? headings[k]! : frames[k]!.camera[key];
  const t0 = frames[i]!.at;
  const t1 = frames[i + 1]!.at;
  const span = t1 - t0;
  const u = span > 0 ? (t - t0) / span : 1;
  const tangent = (k: number, key: (typeof KEYS)[number]) => {
    if (k <= 0 || k >= frames.length - 1) return 0;
    const before = value(k, key) - value(k - 1, key);
    const after = value(k + 1, key) - value(k, key);
    // Flat at a peak or dip, so the curve never overshoots it (e.g. diving below a low pass).
    if (before * after <= 0) return 0;
    const dt = frames[k + 1]!.at - frames[k - 1]!.at;
    return dt > 0 ? ((value(k + 1, key) - value(k - 1, key)) / dt) * span : 0;
  };
  const h00 = 2 * u ** 3 - 3 * u ** 2 + 1;
  const h10 = u ** 3 - 2 * u ** 2 + u;
  const h01 = -2 * u ** 3 + 3 * u ** 2;
  const h11 = u ** 3 - u ** 2;
  const camera = Object.fromEntries(
    KEYS.map((key) => [
      key,
      h00 * value(i, key) +
        h10 * tangent(i, key) +
        h01 * value(i + 1, key) +
        h11 * tangent(i + 1, key),
    ]),
  ) as unknown as CameraState;
  camera.heading = ((camera.heading % 360) + 360) % 360;
  return camera;
}

/** Keyframes circling a point: the camera looks at it from `radiusM` away. */
export function orbit(
  lon: number,
  lat: number,
  radiusM: number,
  heightM: number,
  seconds: number,
  steps = 8,
  startBearing = 180,
): TourKeyframe[] {
  const pitch = -(Math.atan2(heightM, radiusM) * 180) / Math.PI;
  const mPerDegLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  return Array.from({ length: steps + 1 }, (_, k) => {
    const bearing = startBearing + (360 * k) / steps;
    const b = (bearing * Math.PI) / 180;
    return {
      at: (seconds * k) / steps,
      camera: {
        lon: lon + (radiusM * Math.sin(b)) / mPerDegLon,
        lat: lat + (radiusM * Math.cos(b)) / 111_320,
        height: heightM,
        heading: (((bearing + 180) % 360) + 360) % 360,
        pitch,
      },
    };
  });
}

const NOTIFY_MS = 250;

/** Plays a tour frame by frame; `frame` returns the camera to show, or undefined when idle. */
export class TourPlayer {
  private tour: Tour | null = null;
  private startedAt = 0;
  private notifiedAt = 0;

  constructor(private readonly onChange: (state: TourState | null) => void) {}

  get playing(): boolean {
    return this.tour !== null;
  }

  play(tour: Tour, now: number): void {
    if (tour.keyframes.length === 0) return;
    this.tour = tour;
    this.startedAt = now;
    this.notifiedAt = 0;
  }

  stop(): void {
    if (!this.tour) return;
    this.tour = null;
    this.onChange(null);
  }

  frame(now: number): CameraState | undefined {
    const tour = this.tour;
    if (!tour) return undefined;
    const elapsed = (now - this.startedAt) / 1000;
    const duration = tourDuration(tour);
    const camera = sampleTour(tour.keyframes, elapsed);
    if (elapsed >= duration) this.stop();
    else if (now - this.notifiedAt >= NOTIFY_MS) {
      this.notifiedAt = now;
      this.onChange({ id: tour.id, title: tour.title, elapsed, duration });
    }
    return camera;
  }
}
