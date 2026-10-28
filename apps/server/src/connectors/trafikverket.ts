import {
  encodeLine,
  GOTHENBURG,
  type Departure,
  type Entity,
  type Feature,
  type GeoEvent,
  type Severity,
} from '@gbg-osint/shared';
import { z } from 'zod';
import type { ConnectorContext, PollConnector } from '../core/connector';
import { UpstreamError } from '../core/http';
import { cachedOverpass, OVERPASS_HOSTS } from './osm';
import {
  buildTrafficCorridors,
  onewayOf,
  sideBearing,
  type Corridor,
  type FlowRecord,
  type RoadWay,
} from './roadFlow';
import { inGothenburgBbox, isoTime, parseWktPoint, truncate } from './util';

const HOST = 'api.trafikinfo.trafikverket.se';
const ENDPOINT = `https://${HOST}/v2/data.json`;
const REQUIRED_ENV = ['TRAFIKVERKET_API_KEY'] as const;
const LICENCE = 'CC0 1.0';
const HOMEPAGE = 'https://data.trafikverket.se/';
const { west, south, east, north } = GOTHENBURG.bbox;
const BOX = `shape="box" value="${west} ${south}, ${east} ${north}"`;
const PHOTO_URL = /^https:\/\/api\.trafikinfo\.trafikverket\.se\/[\w./-]+\.jpg$/i;

function xmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const ApiResponse = z.object({
  RESPONSE: z.object({ RESULT: z.array(z.record(z.string(), z.unknown())) }),
});

/** Runs one query against the Trafikverket open API and returns the objects of `objectType`. */
async function query(ctx: ConnectorContext, objectType: string, queryXml: string) {
  const key = xmlAttr(ctx.env.TRAFIKVERKET_API_KEY ?? '');
  const raw = await ctx.http.postJson(
    ENDPOINT,
    `<REQUEST><LOGIN authenticationkey="${key}" />${queryXml}</REQUEST>`,
    { headers: { 'content-type': 'text/xml' } },
  );
  const result = ApiResponse.parse(raw).RESPONSE.RESULT[0] ?? {};
  if ('ERROR' in result) throw new UpstreamError(`Trafikverket rejected the ${objectType} query`);
  const items = result[objectType];
  return Array.isArray(items) ? (items as unknown[]) : [];
}

// --- Road situations (accidents, roadworks, closures) ---

const ROAD_EVENTS = 'events.road';

const Deviation = z.object({
  Id: z.string().min(1).max(128),
  MessageType: z.string().optional(),
  MessageTypeValue: z.string().optional(),
  MessageCode: z.string().optional(),
  Message: z.string().optional(),
  SeverityCode: z.number().optional(),
  RoadNumber: z.string().optional(),
  RoadName: z.string().optional(),
  LocationDescriptor: z.string().optional(),
  TrafficRestrictionType: z.string().optional(),
  StartTime: z.string().optional(),
  EndTime: z.string().optional(),
  Geometry: z
    .object({
      WGS84: z.string().optional(),
      Point: z.object({ WGS84: z.string() }).optional(),
    })
    .optional(),
});
const Situation = z.object({ Deviation: z.array(z.unknown()).optional() });

/** Trafikverket severity codes: 1 none, 2 small, 4 large, 5 very large impact. */
export function roadSeverity(code: number | undefined, typeValue: string | undefined): Severity {
  const base: Severity =
    code === 5 ? 'critical' : code === 4 ? 'major' : code === 2 ? 'minor' : 'info';
  return typeValue === 'Accident' && (base === 'info' || base === 'minor') ? 'major' : base;
}

export function parseSituations(raw: readonly unknown[], now: number): GeoEvent[] {
  const events = new Map<string, GeoEvent>();
  for (const item of raw) {
    const situation = Situation.safeParse(item);
    if (!situation.success) continue;
    for (const devRaw of situation.data.Deviation ?? []) {
      const parsed = Deviation.safeParse(devRaw);
      if (!parsed.success || events.has(parsed.data.Id)) continue;
      const d = parsed.data;
      const wkt = d.Geometry?.Point?.WGS84 ?? d.Geometry?.WGS84;
      const point = wkt ? parseWktPoint(wkt) : undefined;
      if (!point || !inGothenburgBbox(...point)) continue;
      const start = isoTime(d.StartTime);
      const end = isoTime(d.EndTime);
      if (!start || Date.parse(start) > now || (end && Date.parse(end) < now)) continue;
      const where = d.RoadNumber ?? d.RoadName ?? d.LocationDescriptor ?? 'Göteborg';
      const what = d.MessageCode ?? d.MessageType ?? 'Trafikhändelse';
      const body = [d.Message, d.LocationDescriptor, d.TrafficRestrictionType]
        .filter((s): s is string => Boolean(s?.trim()))
        .join(' · ');
      events.set(d.Id, {
        id: d.Id,
        source: 'trafikverket',
        category: truncate(d.MessageType ?? 'Trafikverket', 64),
        severity: roadSeverity(d.SeverityCode, d.MessageTypeValue),
        title: truncate(`${what}: ${where}`, 300),
        ...(body && { body: truncate(body, 1000) }),
        geometry: { type: 'Point', coordinates: point },
        locationPrecision: 'exact',
        start,
        ...(end && { end }),
      });
    }
  }
  return [...events.values()];
}

export const trafikverketSituations: PollConnector = {
  id: 'trafikverket.situations',
  name: 'Trafikverket – road incidents',
  licence: LICENCE,
  attribution: 'Trafikverket',
  homepage: HOMEPAGE,
  mode: 'poll',
  intervalMs: 60_000,
  allowedHosts: [HOST],
  requiredEnv: REQUIRED_ENV,
  channels: [{ name: ROAD_EVENTS, kind: 'events' }],
  async poll(ctx) {
    const raw = await query(
      ctx,
      'Situation',
      `<QUERY objecttype="Situation" namespace="road.trafficinfo" schemaversion="1.6">` +
        `<FILTER><WITHIN name="Deviation.Geometry.Point.WGS84" ${BOX} /></FILTER></QUERY>`,
    );
    ctx.publish.replace(ROAD_EVENTS, parseSituations(raw, Date.now()));
  },
};

// --- Trains at Göteborg C ---

const TRAINS = 'transit.trains';
const STATION = { signature: 'G', name: 'Göteborg C' } as const;
const STATIONS_TTL_MS = 24 * 3600_000;

const Location = z.object({ LocationName: z.string(), Order: z.number().optional() });
const Announcement = z.object({
  ActivityId: z.string().min(1).max(128),
  ActivityType: z.enum(['Avgang', 'Ankomst']),
  AdvertisedTimeAtLocation: z.string(),
  AdvertisedTrainIdent: z.string().optional(),
  Canceled: z.boolean().optional(),
  Deleted: z.boolean().optional(),
  Deviation: z.array(z.object({ Description: z.string() })).optional(),
  EstimatedTimeAtLocation: z.string().optional(),
  TimeAtLocation: z.string().optional(),
  TrackAtLocation: z.string().optional(),
  FromLocation: z.array(Location).optional(),
  ToLocation: z.array(Location).optional(),
  ProductInformation: z.array(z.object({ Description: z.string() })).optional(),
});

export function parseTrainAnnouncements(
  raw: readonly unknown[],
  stationNames: ReadonlyMap<string, string>,
): Departure[] {
  const rows: Departure[] = [];
  for (const item of raw) {
    const parsed = Announcement.safeParse(item);
    if (!parsed.success || parsed.data.Deleted) continue;
    const a = parsed.data;
    const planned = isoTime(a.AdvertisedTimeAtLocation);
    if (!planned) continue;
    const departure = a.ActivityType === 'Avgang';
    const ends = [...((departure ? a.ToLocation : a.FromLocation) ?? [])].sort(
      (x, y) => (x.Order ?? 0) - (y.Order ?? 0),
    );
    const place = ends.map((l) => stationNames.get(l.LocationName) ?? l.LocationName).join(', ');
    const actual = isoTime(a.TimeAtLocation);
    const expected = actual ?? isoTime(a.EstimatedTimeAtLocation);
    const status = [
      ...(actual && !a.Canceled ? [departure ? 'Departed' : 'Arrived'] : []),
      ...(a.Deviation ?? []).map((d) => d.Description),
    ].join(' · ');
    const product = a.ProductInformation?.[0]?.Description;
    rows.push({
      id: a.ActivityId,
      source: 'trafikverket',
      board: STATION.name,
      direction: departure ? 'departure' : 'arrival',
      mode: 'train',
      line: truncate(a.AdvertisedTrainIdent ?? '–', 40),
      ...(product && { operator: truncate(product, 80) }),
      place: truncate(place || '–', 200),
      planned,
      ...(expected && { expected }),
      ...(a.TrackAtLocation && { platform: truncate(a.TrackAtLocation, 40) }),
      ...(status && { status: truncate(status, 160) }),
      cancelled: a.Canceled ?? false,
    });
  }
  return rows;
}

const TrainStation = z.object({
  LocationSignature: z.string(),
  AdvertisedLocationName: z.string(),
});
let stationNames = new Map<string, string>();
let stationsLoadedAt = 0;

async function loadStationNames(ctx: ConnectorContext): Promise<Map<string, string>> {
  if (stationNames.size > 0 && Date.now() - stationsLoadedAt < STATIONS_TTL_MS) return stationNames;
  const cached = await ctx.cache.get<unknown[]>('stations', STATIONS_TTL_MS);
  const raw =
    cached?.value ??
    (await query(
      ctx,
      'TrainStation',
      `<QUERY objecttype="TrainStation" namespace="rail.infrastructure" schemaversion="1.5">` +
        `<FILTER><EQ name="Advertised" value="true" /></FILTER>` +
        `<INCLUDE>LocationSignature</INCLUDE><INCLUDE>AdvertisedLocationName</INCLUDE></QUERY>`,
    ));
  if (!cached) await ctx.cache.set('stations', raw);
  const names = new Map<string, string>();
  for (const item of raw) {
    const s = TrainStation.safeParse(item);
    if (s.success) names.set(s.data.LocationSignature, s.data.AdvertisedLocationName);
  }
  stationNames = names;
  stationsLoadedAt = cached?.savedAt ?? Date.now();
  return names;
}

const TRAIN_FIELDS = [
  'ActivityId',
  'ActivityType',
  'AdvertisedTimeAtLocation',
  'AdvertisedTrainIdent',
  'Canceled',
  'Deleted',
  'Deviation',
  'EstimatedTimeAtLocation',
  'TimeAtLocation',
  'TrackAtLocation',
  'FromLocation',
  'ToLocation',
  'ProductInformation',
];

export const trafikverketTrains: PollConnector = {
  id: 'trafikverket.trains',
  name: 'Trafikverket – trains at Göteborg C',
  licence: LICENCE,
  attribution: 'Trafikverket',
  homepage: HOMEPAGE,
  mode: 'poll',
  intervalMs: 60_000,
  allowedHosts: [HOST],
  requiredEnv: REQUIRED_ENV,
  channels: [{ name: TRAINS, kind: 'departures' }],
  async poll(ctx) {
    const names = await loadStationNames(ctx);
    const raw = await query(
      ctx,
      'TrainAnnouncement',
      `<QUERY objecttype="TrainAnnouncement" schemaversion="1.9" orderby="AdvertisedTimeAtLocation" limit="400">` +
        `<FILTER><AND>` +
        `<EQ name="LocationSignature" value="${STATION.signature}" />` +
        `<EQ name="Advertised" value="true" />` +
        `<IN name="ActivityType" value="Avgang,Ankomst" />` +
        `<GT name="AdvertisedTimeAtLocation" value="$dateadd(-00:15:00)" />` +
        `<LT name="AdvertisedTimeAtLocation" value="$dateadd(02:00:00)" />` +
        `</AND></FILTER>` +
        TRAIN_FIELDS.map((f) => `<INCLUDE>${f}</INCLUDE>`).join('') +
        `</QUERY>`,
    );
    ctx.publish.replace(TRAINS, parseTrainAnnouncements(raw, names));
  },
};

// --- Road cameras ---

const CAMERAS = 'cameras.road';

const Camera = z.object({
  Id: z.string().min(1).max(128),
  Name: z.string().min(1),
  Description: z.string().optional(),
  Direction: z.number().optional(),
  Type: z.string().optional(),
  Active: z.boolean().optional(),
  Deleted: z.boolean().optional(),
  PhotoUrl: z.string().optional(),
  PhotoTime: z.string().optional(),
  Geometry: z.object({ WGS84: z.string() }),
});

export function parseCameras(raw: readonly unknown[], now: string): Entity[] {
  const entities: Entity[] = [];
  for (const item of raw) {
    const parsed = Camera.safeParse(item);
    if (!parsed.success) continue;
    const c = parsed.data;
    if (c.Active === false || c.Deleted) continue;
    const point = parseWktPoint(c.Geometry.WGS84);
    if (!point || !inGothenburgBbox(...point)) continue;
    const photoUrl = c.PhotoUrl && PHOTO_URL.test(c.PhotoUrl) ? c.PhotoUrl : undefined;
    entities.push({
      id: c.Id,
      source: 'trafikverket',
      kind: 'camera',
      lon: point[0],
      lat: point[1],
      ...(c.Direction !== undefined && c.Direction >= 0 && c.Direction <= 360
        ? { heading: c.Direction % 360 }
        : {}),
      label: truncate(c.Name, 200),
      ts: isoTime(c.PhotoTime) ?? now,
      props: {
        ...(c.Description && { description: truncate(c.Description, 300) }),
        ...(c.Type && { type: c.Type }),
        ...(photoUrl && { photoUrl }),
      },
    });
  }
  return entities;
}

export const trafikverketCameras: PollConnector = {
  id: 'trafikverket.cameras',
  name: 'Trafikverket – road cameras',
  licence: LICENCE,
  attribution: 'Trafikverket',
  homepage: HOMEPAGE,
  mode: 'poll',
  intervalMs: 5 * 60_000,
  allowedHosts: [HOST],
  requiredEnv: REQUIRED_ENV,
  channels: [{ name: CAMERAS, kind: 'entities' }],
  async poll(ctx) {
    const raw = await query(
      ctx,
      'Camera',
      `<QUERY objecttype="Camera" namespace="road.infrastructure" schemaversion="1">` +
        `<FILTER><WITHIN name="Geometry.WGS84" ${BOX} /></FILTER></QUERY>`,
    );
    ctx.publish.replace(CAMERAS, parseCameras(raw, new Date().toISOString()));
  },
};

// --- Road weather stations ---

const ROAD_WEATHER = 'env.road-weather';

const Value = z.object({ Value: z.number() }).optional();
const Measurepoint = z.object({
  Id: z.string().min(1).max(64),
  Name: z.string().min(1),
  Geometry: z.object({ WGS84: z.string() }),
  Observation: z
    .object({
      Sample: z.string(),
      Weather: z.object({ Precipitation: z.string().optional() }).optional(),
      Air: z
        .object({ Temperature: Value, RelativeHumidity: Value, VisibleDistance: Value })
        .optional(),
      Surface: z
        .object({
          Temperature: Value,
          Grip: Value,
          Ice: z.boolean().optional(),
          Snow: z.boolean().optional(),
          Water: z.boolean().optional(),
        })
        .optional(),
      Wind: z.array(z.object({ Speed: Value, Direction: Value })).optional(),
    })
    .optional(),
});

export function parseRoadWeather(raw: readonly unknown[]): Entity[] {
  const entities: Entity[] = [];
  for (const item of raw) {
    const parsed = Measurepoint.safeParse(item);
    if (!parsed.success || !parsed.data.Observation) continue;
    const m = parsed.data;
    const o = m.Observation!;
    const point = parseWktPoint(m.Geometry.WGS84);
    const ts = isoTime(o.Sample);
    if (!point || !ts) continue;
    const wind = o.Wind?.[0];
    const props: Record<string, unknown> = {
      ...(o.Air?.Temperature && { airTempC: o.Air.Temperature.Value }),
      ...(o.Surface?.Temperature && { surfaceTempC: o.Surface.Temperature.Value }),
      ...(o.Surface?.Grip && { grip: o.Surface.Grip.Value }),
      ...(o.Surface?.Ice !== undefined && { ice: o.Surface.Ice }),
      ...(o.Surface?.Snow !== undefined && { snow: o.Surface.Snow }),
      ...(o.Surface?.Water !== undefined && { wet: o.Surface.Water }),
      ...(wind?.Speed && { windMs: wind.Speed.Value }),
      ...(wind?.Direction && { windDirDeg: wind.Direction.Value }),
      ...(o.Air?.RelativeHumidity && { humidityPct: o.Air.RelativeHumidity.Value }),
      ...(o.Air?.VisibleDistance && { visibilityM: o.Air.VisibleDistance.Value }),
      ...(o.Weather?.Precipitation && { precipitation: o.Weather.Precipitation }),
    };
    entities.push({
      id: m.Id,
      source: 'trafikverket',
      kind: 'sensor',
      lon: point[0],
      lat: point[1],
      label: truncate(m.Name, 200),
      ts,
      props,
    });
  }
  return entities;
}

export const trafikverketRoadWeather: PollConnector = {
  id: 'trafikverket.roadweather',
  name: 'Trafikverket – road weather stations',
  licence: LICENCE,
  attribution: 'Trafikverket',
  homepage: HOMEPAGE,
  mode: 'poll',
  intervalMs: 10 * 60_000,
  allowedHosts: [HOST],
  requiredEnv: REQUIRED_ENV,
  channels: [{ name: ROAD_WEATHER, kind: 'entities' }],
  async poll(ctx) {
    const raw = await query(
      ctx,
      'WeatherMeasurepoint',
      `<QUERY objecttype="WeatherMeasurepoint" namespace="road.weatherinfo" schemaversion="2.1">` +
        `<FILTER><WITHIN name="Geometry.WGS84" ${BOX} /></FILTER></QUERY>`,
    );
    ctx.publish.replace(ROAD_WEATHER, parseRoadWeather(raw));
  },
};

// --- Measured traffic flow (drives the illustrative cars) ---

const TRAFFIC_FLOW = 'roads.traffic-flow';
const ROADS_TTL_MS = 7 * 24 * 3600_000;
const ROADS_QUERY =
  `[out:json][timeout:120];` +
  `way["highway"~"^(motorway|trunk|primary|secondary|motorway_link|trunk_link|primary_link)$"]` +
  `(${south},${west},${north},${east});out body geom qt;`;

const FlowItem = z.object({
  SiteId: z.number().int(),
  MeasurementTime: z.string(),
  MeasurementSide: z.string().optional(),
  SpecificLane: z.string().optional(),
  VehicleFlowRate: z.number().nonnegative(),
  AverageVehicleSpeed: z.number().nonnegative().optional(),
  Deleted: z.boolean().optional(),
  Geometry: z.object({ WGS84: z.string() }),
});

export function parseFlowRecords(raw: readonly unknown[]): FlowRecord[] {
  const records: FlowRecord[] = [];
  for (const item of raw) {
    const parsed = FlowItem.safeParse(item);
    if (!parsed.success || parsed.data.Deleted) continue;
    const f = parsed.data;
    const point = parseWktPoint(f.Geometry.WGS84);
    const measuredAt = isoTime(f.MeasurementTime);
    if (!point || !measuredAt || !inGothenburgBbox(...point)) continue;
    const bearing = sideBearing(f.MeasurementSide);
    records.push({
      siteId: f.SiteId,
      lon: point[0],
      lat: point[1],
      ...(bearing !== undefined && { bearing }),
      lane: f.SpecificLane ?? 'lane1',
      flowVehH: f.VehicleFlowRate,
      ...(f.AverageVehicleSpeed !== undefined && { speedKmh: f.AverageVehicleSpeed }),
      measuredAt,
    });
  }
  return records;
}

const RoadElement = z.object({
  type: z.literal('way'),
  id: z.number().int(),
  nodes: z.array(z.number().int()).min(2),
  geometry: z.array(z.object({ lat: z.number(), lon: z.number() })).min(2),
  tags: z.record(z.string(), z.string()).default({}),
});
const OverpassResponse = z.object({ elements: z.array(z.unknown()) });

export function parseRoads(raw: unknown): RoadWay[] {
  const ways: RoadWay[] = [];
  for (const item of OverpassResponse.parse(raw).elements) {
    const parsed = RoadElement.safeParse(item);
    if (!parsed.success) continue;
    const { id, nodes, geometry, tags } = parsed.data;
    if (nodes.length !== geometry.length || !tags.highway) continue;
    ways.push({
      id,
      nodes,
      coords: geometry.map((p): [number, number] => [p.lon, p.lat]),
      highway: tags.highway,
      oneway: onewayOf(tags),
      ...(tags.name && { name: truncate(tags.name, 80) }),
      ...(tags.ref && { ref: truncate(tags.ref, 40) }),
    });
  }
  return ways;
}

export function corridorFeatures(corridors: readonly Corridor[]): Feature[] {
  return corridors.map((c) => ({
    id: c.id,
    source: 'trafikverket',
    kind: 'traffic',
    line: encodeLine(c.coords),
    ...(c.road && { label: c.road }),
    ts: c.measuredAt,
    props: {
      flowVehH: c.flowVehH,
      speedKmh: c.speedKmh,
      lanes: c.lanes,
      twoWay: c.twoWay,
      sites: c.sites.length,
    },
  }));
}

let roads: { savedAt: number; ways: RoadWay[] } | undefined;

export const trafikverketTrafficFlow: PollConnector = {
  id: 'trafikverket.trafficflow',
  name: 'Trafikverket – measured traffic flow',
  licence: `${LICENCE} (flow); ODbL 1.0 (road geometry)`,
  attribution: 'Trafikverket, © OpenStreetMap contributors',
  homepage: HOMEPAGE,
  mode: 'poll',
  intervalMs: 2 * 60_000,
  allowedHosts: [HOST, ...OVERPASS_HOSTS],
  requiredEnv: REQUIRED_ENV,
  channels: [{ name: TRAFFIC_FLOW, kind: 'features' }],
  async poll(ctx) {
    const raw = await query(
      ctx,
      'TrafficFlow',
      `<QUERY objecttype="TrafficFlow" namespace="road.trafficinfo" schemaversion="1.5">` +
        `<FILTER><WITHIN name="Geometry.WGS84" ${BOX} />` +
        `<GT name="MeasurementTime" value="$dateadd(-0.00:15:00)" /></FILTER></QUERY>`,
    );
    const cached = await cachedOverpass(ctx, 'roads', ROADS_QUERY, ROADS_TTL_MS);
    if (roads?.savedAt !== cached.savedAt) {
      roads = { savedAt: cached.savedAt, ways: parseRoads(cached.value) };
    }
    const corridors = buildTrafficCorridors(roads.ways, parseFlowRecords(raw));
    ctx.publish.replace(TRAFFIC_FLOW, corridorFeatures(corridors));
  },
};
