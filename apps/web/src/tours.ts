import { orbit, type Tour, type TourKeyframe } from './engine/tours';
import type { CameraState } from './engine/cameraState';

const cam = (
  lon: number,
  lat: number,
  height: number,
  heading: number,
  pitch: number,
): CameraState => ({ lon, lat, height, heading, pitch });

/** Camera tours over Gothenburg, played by the scene director (S). */
export const TOURS: readonly Tour[] = [
  {
    id: 'river',
    title: 'Göta älv from the sea',
    summary: 'Under Älvsborgsbron and up the river past Eriksberg and Lindholmen to the city.',
    layers: ['buildings', 'ships', 'transit', 'waterways'],
    keyframes: [
      { at: 0, camera: cam(11.87, 57.688, 300, 70, -12) },
      { at: 15, camera: cam(11.9, 57.696, 250, 68, -13) },
      { at: 30, camera: cam(11.93, 57.702, 230, 80, -14) },
      { at: 45, camera: cam(11.952, 57.706, 220, 70, -16) },
      { at: 60, camera: cam(11.966, 57.7095, 260, 60, -22) },
      { at: 72, camera: cam(11.978, 57.714, 380, 40, -28) },
    ],
  },
  {
    id: 'centre-orbit',
    title: 'Inner city orbit',
    summary: 'A slow circle around Gustaf Adolfs torg with trams, buses and buildings.',
    layers: ['buildings', 'transit', 'traffic'],
    keyframes: orbit(11.9667, 57.7071, 700, 380, 80),
  },
  {
    id: 'harbour',
    title: 'Port of Gothenburg',
    summary: 'Over Arendal and the Skandia container terminal towards Älvsborgsbron.',
    layers: ['buildings', 'ships', 'waterways'],
    keyframes: [
      { at: 0, camera: cam(11.8, 57.68, 900, 40, -35) },
      { at: 18, camera: cam(11.825, 57.684, 700, 60, -32) },
      { at: 36, camera: cam(11.86, 57.684, 600, 80, -30) },
      { at: 54, camera: cam(11.885, 57.683, 500, 50, -25) },
    ],
  },
  {
    id: 'approach-got',
    title: 'Final approach, Landvetter',
    summary: 'Down the 3° glide path onto runway 21 at Göteborg Landvetter Airport (sped up).',
    layers: ['aircraft', 'buildings'],
    keyframes: [
      { at: 0, camera: cam(12.3945, 57.769, 630, 210, -3) },
      { at: 18, camera: cam(12.3441, 57.7223, 315, 210, -3) },
      { at: 34, camera: cam(12.3105, 57.6912, 105, 210, -3) },
      { at: 46, camera: cam(12.2937, 57.6756, 18, 210, -2) },
      { at: 52, camera: cam(12.2895, 57.6717, 6, 210, -1) },
    ],
  },
];

export const RECORDED_TOUR_ID = 'recorded';
const RECORDING_KEY = 'gbg-osint:tour';
const RECORDING_STEP_S = 8;
const MAX_KEYFRAMES = 30;

const isCamera = (c: unknown): c is CameraState =>
  typeof c === 'object' &&
  c !== null &&
  ['lon', 'lat', 'height', 'heading', 'pitch'].every((k) =>
    Number.isFinite((c as Record<string, unknown>)[k]),
  );

export function loadRecording(): TourKeyframe[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECORDING_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter(isCamera).slice(0, MAX_KEYFRAMES).map(toKeyframe) : [];
  } catch {
    return [];
  }
}

export function saveRecording(frames: readonly TourKeyframe[]): void {
  try {
    localStorage.setItem(RECORDING_KEY, JSON.stringify(frames.map((f) => f.camera)));
  } catch {
    // Storage may be unavailable (private mode); the recording then lasts for this visit only.
  }
}

function toKeyframe(camera: CameraState, index: number): TourKeyframe {
  return { at: index * RECORDING_STEP_S, camera };
}

/** Appends a view to a recording, evenly spaced in time. */
export function addKeyframe(frames: readonly TourKeyframe[], camera: CameraState): TourKeyframe[] {
  return [...frames, camera]
    .slice(-MAX_KEYFRAMES)
    .map((f, i) => toKeyframe('camera' in f ? f.camera : f, i));
}

export function recordedTour(frames: readonly TourKeyframe[]): Tour {
  return {
    id: RECORDED_TOUR_ID,
    title: 'Your tour',
    summary: `${frames.length} recorded views`,
    keyframes: frames,
  };
}
