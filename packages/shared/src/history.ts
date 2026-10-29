import { z } from 'zod';
import { IsoTime } from './model';

/** `[epoch ms, value]` samples of one series over the last 24 hours, oldest first. */
export const SeriesSchema = z.object({
  key: z.string().min(1).max(200),
  unit: z.string().max(32),
  points: z.array(z.tuple([z.number(), z.number()])).max(1000),
});
export type Series = z.infer<typeof SeriesSchema>;

/** Where a moving object has been in the last 24 hours: `[epoch ms, lon, lat, alt m]`, oldest first. */
export const TrackSchema = z.object({
  key: z.string().min(1).max(200),
  points: z.array(z.tuple([z.number(), z.number(), z.number(), z.number()])).max(2000),
});
export type Track = z.infer<typeof TrackSchema>;

/** Sensor readings kept as 24-hour series per entity (`channel/entityId/prop`), with their units. */
export const ENTITY_SERIES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'env.harbour': { windMs: 'm/s', gustMs: 'm/s', waterLevelCm: 'cm', currentKn: 'kn' },
  'env.water-levels': { levelM: 'm' },
  'env.air-quality': { aqi: 'index' },
  'env.road-weather': { surfaceTempC: '°C', airTempC: '°C' },
  'aviation.metar': { windKt: 'kt', ceilingFt: 'ft' },
  'transit.rail': { delayMin: 'min' },
};

/** Moving objects with a 24-hour track. Västtrafik vehicles and anonymised craft have none. */
export const TRACK_CHANNELS: ReadonlySet<string> = new Set([
  'maritime.ships',
  'aviation.aircraft',
  'transit.rail',
]);

export const BriefLevel = z.enum(['info', 'notice', 'warning', 'alert']);
export type BriefLevel = z.infer<typeof BriefLevel>;

/** What a brief line points at; the app finds the layer by channel and selects or flies to it. */
export const BriefTarget = z.object({
  channel: z.string().max(64),
  ids: z.array(z.string().max(128)).max(50),
  lon: z.number().optional(),
  lat: z.number().optional(),
});
export type BriefTarget = z.infer<typeof BriefTarget>;

export const BriefItemSchema = z.object({
  id: z.string().min(1).max(128),
  level: BriefLevel,
  text: z.string().min(1).max(300),
  detail: z.string().max(500).optional(),
  target: BriefTarget.optional(),
});
export type BriefItem = z.infer<typeof BriefItemSchema>;

export const BriefSectionSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(80),
  items: z.array(BriefItemSchema).max(30),
});
export type BriefSection = z.infer<typeof BriefSectionSchema>;

/** Worst delays across the departure boards, by line and by hub. */
export const DelayEntrySchema = z.object({
  name: z.string().min(1).max(120),
  mode: z.string().max(16),
  departures: z.number().int().nonnegative(),
  late: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  meanDelayMin: z.number(),
  maxDelayMin: z.number(),
});
export type DelayEntry = z.infer<typeof DelayEntrySchema>;

/** A rule-based "now in Gothenburg" summary, with statistical flags against the last 24 hours. */
export const BriefSchema = z.object({
  ts: IsoTime,
  sections: z.array(BriefSectionSchema).max(12),
  delays: z.object({
    lines: z.array(DelayEntrySchema).max(10),
    hubs: z.array(DelayEntrySchema).max(10),
  }),
  /** How many hours of history the anomaly flags could use (they need at least a few). */
  historyHours: z.number().nonnegative(),
});
export type Brief = z.infer<typeof BriefSchema>;
