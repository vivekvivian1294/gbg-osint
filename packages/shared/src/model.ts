import { z } from 'zod';

export const IsoTime = z.iso.datetime({ offset: true });
export const HttpUrl = z.url({ protocol: /^https?$/ });

const Lon = z.number().min(-180).max(180);
const Lat = z.number().min(-90).max(90);
const Id = z.string().min(1).max(128);
const SourceId = z.string().min(1).max(64);

export const EntityKind = z.enum([
  'tram',
  'bus',
  'ferry',
  'train',
  'ship',
  'aircraft',
  'satellite',
  'bike_station',
  'scooter',
  'vehicle',
  'poi',
  'camera',
  'sensor',
  'photo',
]);

export const EntitySchema = z.object({
  id: Id,
  source: SourceId,
  kind: EntityKind,
  lon: Lon,
  lat: Lat,
  alt: z.number().optional(),
  heading: z.number().min(0).max(360).optional(),
  speed: z.number().nonnegative().optional(),
  label: z.string().max(200).optional(),
  ts: IsoTime,
  /**
   * Route travelled since the previous update (excluding both ends), e.g. along streets or
   * tracks, so clients can play the movement back along it instead of in a straight line.
   */
  via: z
    .array(z.tuple([Lon, Lat]))
    .max(256)
    .optional(),
  props: z.record(z.string(), z.unknown()).optional(),
});
export type Entity = z.infer<typeof EntitySchema>;

export const Severity = z.enum(['info', 'minor', 'major', 'critical']);
export type Severity = z.infer<typeof Severity>;

/**
 * How precise an event's location is. Police events only carry a municipality, SMHI warnings a
 * county or sea area, and national news no location at all.
 */
export const LocationPrecision = z.enum(['exact', 'area', 'municipality', 'region', 'none']);
export type LocationPrecision = z.infer<typeof LocationPrecision>;

export const GeometrySchema = z.object({
  type: z.enum(['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon']),
  coordinates: z.array(z.unknown()),
});

export const EventSchema = z.object({
  id: Id,
  source: SourceId,
  category: z.string().min(1).max(64),
  severity: Severity,
  title: z.string().min(1).max(300),
  body: z.string().max(5000).optional(),
  geometry: GeometrySchema.optional(),
  locationPrecision: LocationPrecision,
  start: IsoTime,
  end: IsoTime.optional(),
  url: HttpUrl.optional(),
});
export type GeoEvent = z.infer<typeof EventSchema>;

export const MetricSchema = z.object({
  /** Series id, unique within the channel. */
  id: Id,
  source: SourceId,
  name: z.string().min(1).max(120),
  unit: z.string().max(32),
  value: z.number(),
  ts: IsoTime,
  lon: Lon.optional(),
  lat: Lat.optional(),
});
export type Metric = z.infer<typeof MetricSchema>;

const HexColor = z.string().regex(/^#[0-9a-f]{6}$/i);

export const TransportMode = z.enum(['tram', 'bus', 'ferry', 'train', 'flight']);
export type TransportMode = z.infer<typeof TransportMode>;

/** One row on a departure or arrival board (stop, station or airport). */
export const DepartureSchema = z.object({
  id: Id,
  source: SourceId,
  board: z.string().min(1).max(80),
  direction: z.enum(['departure', 'arrival']),
  mode: TransportMode,
  line: z.string().min(1).max(40),
  operator: z.string().max(80).optional(),
  /** Destination for departures, origin for arrivals. */
  place: z.string().min(1).max(200),
  planned: IsoTime,
  expected: IsoTime.optional(),
  platform: z.string().max(40).optional(),
  status: z.string().max(160).optional(),
  cancelled: z.boolean(),
  colors: z.object({ fg: HexColor, bg: HexColor }).optional(),
  callsign: z.string().max(16).optional(),
});
export type Departure = z.infer<typeof DepartureSchema>;

export const FeatureKind = z.enum(['waterway', 'traffic', 'travel-time']);
export type FeatureKind = z.infer<typeof FeatureKind>;

/** A map line (river, measured road stretch) that changes rarely compared with entities. */
export const FeatureSchema = z.object({
  id: Id,
  source: SourceId,
  kind: FeatureKind,
  /** Encoded polyline (see `encodeLine`), in drawing or travel order. */
  line: z.string().min(2).max(100_000),
  label: z.string().max(200).optional(),
  ts: IsoTime,
  props: z.record(z.string(), z.unknown()).optional(),
});
export type Feature = z.infer<typeof FeatureSchema>;

export const BBoxSchema = z.object({ west: Lon, south: Lat, east: Lon, north: Lat });

/** One time step of a raster overlay (e.g. radar), drawn as an image over `bbox` (lon/lat). */
export const FrameSchema = z.object({
  id: Id,
  source: SourceId,
  product: z.enum(['radar']),
  /** Time the frame is valid for. */
  ts: IsoTime,
  /** Same-origin image path served by the API (no `..` segments). */
  path: z
    .string()
    .max(200)
    .regex(/^\/api\/data\/[a-z0-9]+(?:[.-][a-z0-9]+)*\/[\w-]+(?:[./][\w-]+)*$/),
  bbox: BBoxSchema,
});
export type Frame = z.infer<typeof FrameSchema>;

const EncodedRing = z.string().min(2).max(50_000);

/** A statistical area (district) drawn as filled polygons; its figures are in `props`. */
export const AreaSchema = z.object({
  id: Id,
  source: SourceId,
  label: z.string().min(1).max(200),
  /** Polygons as `[exterior, ...holes]`, each ring an encoded polyline (see `encodeLine`). */
  polygons: z.array(z.array(EncodedRing).min(1).max(50)).min(1).max(50),
  ts: IsoTime,
  props: z.record(z.string(), z.unknown()).optional(),
});
export type Area = z.infer<typeof AreaSchema>;

export const ChannelKind = z.enum([
  'entities',
  'events',
  'metrics',
  'departures',
  'features',
  'frames',
  'areas',
]);
export type ChannelKind = z.infer<typeof ChannelKind>;

export const ITEM_SCHEMAS = {
  entities: EntitySchema,
  events: EventSchema,
  metrics: MetricSchema,
  departures: DepartureSchema,
  features: FeatureSchema,
  frames: FrameSchema,
  areas: AreaSchema,
} as const;

export const ChannelItemSchema = z.union([
  EntitySchema,
  EventSchema,
  MetricSchema,
  DepartureSchema,
  FeatureSchema,
  FrameSchema,
  AreaSchema,
]);
export type ChannelItem = Entity | GeoEvent | Metric | Departure | Feature | Frame | Area;

export function isEntity(item: ChannelItem): item is Entity {
  return 'kind' in item && 'lon' in item;
}

export function isEvent(item: ChannelItem): item is GeoEvent {
  return 'category' in item && 'title' in item;
}

export function isMetric(item: ChannelItem): item is Metric {
  return 'value' in item && 'unit' in item;
}

export function isDeparture(item: ChannelItem): item is Departure {
  return 'board' in item && 'planned' in item;
}

export function isFeature(item: ChannelItem): item is Feature {
  return 'line' in item && 'kind' in item;
}

export function isFrame(item: ChannelItem): item is Frame {
  return 'path' in item && 'product' in item;
}

export function isArea(item: ChannelItem): item is Area {
  return 'polygons' in item;
}
