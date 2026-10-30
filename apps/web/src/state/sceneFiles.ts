import { z } from 'zod';
import type { Tour } from '../engine/tours';

/** Tours as files: `{ format, version, title, summary?, layers?, keyframes }`. */
export const SCENE_FORMAT = 'gbg-osint-scene';
export const MAX_SCENE_BYTES = 256 * 1024;
export const MAX_IMPORTED_TOURS = 20;
const IMPORTED_KEY = 'gbg-osint:scenes';
const MAX_KEYFRAMES = 300;
const MAX_TOUR_S = 3600;

const Camera = z.object({
  lon: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
  height: z.number().min(1).max(20_000_000),
  heading: z.number().min(-360).max(720),
  pitch: z.number().min(-90).max(90),
});

const SceneFileSchema = z
  .object({
    format: z.literal(SCENE_FORMAT),
    version: z.literal(1),
    title: z.string().trim().min(1).max(80),
    summary: z.string().trim().max(300).optional(),
    layers: z
      .array(z.string().regex(/^[a-z0-9-]{1,40}$/))
      .max(100)
      .optional(),
    keyframes: z
      .array(z.object({ at: z.number().min(0).max(MAX_TOUR_S), camera: Camera }))
      .min(2, 'a tour needs at least two views')
      .max(MAX_KEYFRAMES, `a tour can have at most ${MAX_KEYFRAMES} views`),
  })
  .refine((f) => f.keyframes.every((k, i) => i === 0 || k.at > f.keyframes[i - 1]!.at), {
    message: 'Keyframe times must increase',
    path: ['keyframes'],
  });
type SceneFile = z.infer<typeof SceneFileSchema>;

const round = (v: number, digits: number) => Number(v.toFixed(digits));

/** The file contents for a tour; `layers` are the ones to switch on while it plays. */
export function sceneFile(tour: Tour, layers: readonly string[] = tour.layers ?? []): string {
  const file: SceneFile = {
    format: SCENE_FORMAT,
    version: 1,
    title: tour.title.slice(0, 80),
    ...(tour.summary && { summary: tour.summary.slice(0, 300) }),
    ...(layers.length > 0 && { layers: [...layers] }),
    keyframes: tour.keyframes.map(({ at, camera: c }) => ({
      at: round(at, 2),
      camera: {
        lon: round(c.lon, 6),
        lat: round(c.lat, 6),
        height: round(c.height, 1),
        heading: round(c.heading, 2),
        pitch: round(c.pitch, 2),
      },
    })),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

const toTour = (file: SceneFile, id: string): Tour => ({
  id,
  title: file.title,
  summary: file.summary ?? `${file.keyframes.length} views`,
  ...(file.layers && { layers: file.layers }),
  keyframes: file.keyframes,
});

const newId = () => `file-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A tour read from a file; throws an Error with a message fit to show the user. */
export function parseSceneFile(text: string, id = newId()): Tour {
  if (text.length > MAX_SCENE_BYTES) throw new Error('The file is too large for a tour.');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  if ((raw as { format?: unknown } | null)?.format !== SCENE_FORMAT) {
    throw new Error('This is not a GBG OSINT tour file.');
  }
  const parsed = SceneFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` (${issue.path.join('.')})` : '';
    throw new Error(`The tour file is invalid${where}: ${issue?.message ?? 'unknown problem'}.`);
  }
  return toTour(parsed.data, id);
}

export function loadImportedTours(): Tour[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(IMPORTED_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, MAX_IMPORTED_TOURS).flatMap((entry: unknown) => {
      const { id, file } = (entry ?? {}) as { id?: unknown; file?: unknown };
      const parsed = SceneFileSchema.safeParse(file);
      return typeof id === 'string' && /^file-[a-z0-9]{1,24}$/.test(id) && parsed.success
        ? [toTour(parsed.data, id)]
        : [];
    });
  } catch {
    return [];
  }
}

export function saveImportedTours(tours: readonly Tour[]): void {
  try {
    const entries = tours
      .slice(0, MAX_IMPORTED_TOURS)
      .map((t) => ({ id: t.id, file: JSON.parse(sceneFile(t)) as unknown }));
    localStorage.setItem(IMPORTED_KEY, JSON.stringify(entries));
  } catch {
    // Storage may be unavailable (private mode); imports then last for this visit only.
  }
}
