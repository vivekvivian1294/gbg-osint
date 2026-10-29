import { GOTHENBURG, type Entity, type GeoEvent, type LonLat } from '@gbg-osint/shared';
import { z } from 'zod';
import type { ConnectorContext, PollConnector } from '../core/connector';
import { OPENFREEMAP_HOST } from './buildings';
import { STREET_NETWORK, placeOnNetwork, rankTiles, type StreetNetwork } from './streetNetwork';
import { TRAFIKVERKET, loadStationNames, trafikverketQuery } from './trafikverket';
import { distanceM, isoTime, parseWktPoint, truncate } from './util';

// --- Train positions ---

const RAIL = 'transit.rail';
/** Destination and delay come from announcements, refreshed less often than positions. */
const INFO_TTL_MS = 60_000;
const NETWORK_MARGIN_M = 300;
const NETWORK_FETCHES_PER_POLL = 12;
const TRAIN_NUMBER = /^\d{1,6}$/;

const TrainPosition = z.object({
  Train: z.object({
    OperationalTrainNumber: z.string().regex(TRAIN_NUMBER),
    OperationalTrainDepartureDate: z.string(),
    AdvertisedTrainNumber: z.string().regex(TRAIN_NUMBER).optional(),
  }),
  Position: z.object({ WGS84: z.string() }),
  TimeStamp: z.string(),
  Status: z.object({ Active: z.boolean() }).optional(),
  Bearing: z.number().min(0).max(360).optional(),
  Speed: z.number().nonnegative().optional(),
  Deleted: z.boolean().optional(),
});

export interface TrainReport {
  id: string;
  number: string;
  lon: number;
  lat: number;
  ts: string;
  bearing?: number;
  speedKmh?: number;
}

export function parseTrainPositions(raw: readonly unknown[]): TrainReport[] {
  const trains = new Map<string, TrainReport>();
  for (const item of raw) {
    const parsed = TrainPosition.safeParse(item);
    if (!parsed.success || parsed.data.Deleted || parsed.data.Status?.Active === false) continue;
    const p = parsed.data;
    const point = parseWktPoint(p.Position.WGS84);
    const ts = isoTime(p.TimeStamp);
    const date = isoTime(p.Train.OperationalTrainDepartureDate)?.slice(0, 10);
    if (!point || !ts || !date) continue;
    const id = `${p.Train.OperationalTrainNumber}-${date}`;
    const prev = trains.get(id);
    if (prev && prev.ts >= ts) continue;
    trains.set(id, {
      id,
      number: p.Train.AdvertisedTrainNumber ?? p.Train.OperationalTrainNumber,
      lon: point[0],
      lat: point[1],
      ts,
      ...(p.Bearing !== undefined && { bearing: p.Bearing % 360 }),
      ...(p.Speed !== undefined && { speedKmh: p.Speed }),
    });
  }
  return [...trains.values()];
}

const Station = z.object({ LocationName: z.string(), Order: z.number().optional() });
const PassedAnnouncement = z.object({
  AdvertisedTrainIdent: z.string(),
  AdvertisedTimeAtLocation: z.string(),
  TimeAtLocation: z.string(),
  LocationSignature: z.string(),
  ToLocation: z.array(Station).optional(),
  ProductInformation: z.array(z.object({ Description: z.string() })).optional(),
  Operator: z.string().optional(),
});

export interface TrainInfo {
  destination?: string;
  product?: string;
  operator?: string;
  /** Minutes late (negative = early) at the last station passed. */
  delayMin?: number;
  lastStation?: string;
}

/** Latest passed station, delay there, destination and product per advertised train number. */
export function parseTrainInfo(
  raw: readonly unknown[],
  stationNames: ReadonlyMap<string, string>,
): Map<string, TrainInfo> {
  const rows = raw
    .map((item) => PassedAnnouncement.safeParse(item))
    .flatMap((r) => (r.success ? [r.data] : []))
    .map((a) => ({ a, at: Date.parse(a.TimeAtLocation) }))
    .filter(({ at }) => Number.isFinite(at))
    .sort((x, y) => y.at - x.at);
  const name = (sig: string) => stationNames.get(sig) ?? sig;
  const info = new Map<string, TrainInfo>();
  for (const { a, at } of rows) {
    let t = info.get(a.AdvertisedTrainIdent);
    if (!t) {
      const planned = Date.parse(a.AdvertisedTimeAtLocation);
      t = {
        lastStation: truncate(name(a.LocationSignature), 80),
        ...(Number.isFinite(planned) && { delayMin: Math.round((at - planned) / 60_000) }),
      };
      info.set(a.AdvertisedTrainIdent, t);
    }
    if (!t.destination && a.ToLocation?.length) {
      const last = [...a.ToLocation].sort((x, y) => (x.Order ?? 0) - (y.Order ?? 0)).at(-1)!;
      t.destination = truncate(name(last.LocationName), 80);
    }
    const product = a.ProductInformation?.[0]?.Description;
    if (!t.product && product) t.product = truncate(product, 80);
    if (!t.operator && a.Operator) t.operator = truncate(a.Operator, 80);
  }
  return info;
}

export interface RailTrack {
  lon: number;
  lat: number;
  heading?: number;
}

/** Train entities, placed on the rail network when it is loaded (`via` = route since last poll). */
export function trainEntities(
  reports: readonly TrainReport[],
  info: ReadonlyMap<string, TrainInfo>,
  previous: ReadonlyMap<string, RailTrack>,
  network?: StreetNetwork,
): { entities: Entity[]; tracks: Map<string, RailTrack> } {
  const entities: Entity[] = [];
  const tracks = new Map<string, RailTrack>();
  for (const r of reports) {
    const prev = previous.get(r.id);
    const placed = network ? placeOnNetwork(network, 'rail', r, prev, r.bearing) : undefined;
    const heading = placed?.heading ?? r.bearing ?? placed?.axis;
    const pos = placed ?? r;
    tracks.set(r.id, { lon: pos.lon, lat: pos.lat, ...(heading !== undefined && { heading }) });
    const t = info.get(r.number);
    entities.push({
      id: r.id,
      source: 'trafikverket',
      kind: 'train',
      lon: pos.lon,
      lat: pos.lat,
      ...(heading !== undefined && { heading }),
      label: t?.destination ? `${r.number} → ${t.destination}` : r.number,
      ts: r.ts,
      ...(placed?.via && { via: placed.via }),
      props: {
        train: r.number,
        ...(t?.destination && { destination: t.destination }),
        ...(t?.delayMin !== undefined && { delayMin: t.delayMin }),
        ...(t?.lastStation && { lastStation: t.lastStation }),
        ...(t?.product && { product: t.product }),
        ...(t?.operator && { operator: t.operator }),
        ...(r.speedKmh !== undefined && { speedKmh: r.speedKmh }),
        ...(placed && { matched: 'rail' }),
      },
    });
  }
  return { entities, tracks };
}

let railTracks = new Map<string, RailTrack>();
let trainInfo = new Map<string, TrainInfo>();
let trainInfoAt = 0;
/** Numbers already asked about; freight trains never have announcements. */
let askedNumbers = new Set<string>();

async function refreshTrainInfo(ctx: ConnectorContext, numbers: readonly string[]) {
  const missing = numbers.some((n) => !askedNumbers.has(n));
  if (numbers.length === 0 || (Date.now() - trainInfoAt < INFO_TTL_MS && !missing)) return;
  trainInfoAt = Date.now();
  askedNumbers = new Set(numbers);
  const names = await loadStationNames(ctx);
  const raw = await trafikverketQuery(
    ctx,
    'TrainAnnouncement',
    `<QUERY objecttype="TrainAnnouncement" schemaversion="1.9" orderby="TimeAtLocation desc" limit="600">` +
      `<FILTER><AND>` +
      `<IN name="AdvertisedTrainIdent" value="${numbers.join(',')}" />` +
      `<EXISTS name="TimeAtLocation" value="true" />` +
      `<GT name="TimeAtLocation" value="$dateadd(-04:00:00)" />` +
      `</AND></FILTER>` +
      [
        'AdvertisedTrainIdent',
        'AdvertisedTimeAtLocation',
        'TimeAtLocation',
        'LocationSignature',
        'ToLocation',
        'ProductInformation',
        'Operator',
      ]
        .map((f) => `<INCLUDE>${f}</INCLUDE>`)
        .join('') +
      `</QUERY>`,
  );
  trainInfo = parseTrainInfo(raw, names);
}

export const trafikverketTrainPositions: PollConnector = {
  id: 'trafikverket.trainpositions',
  name: 'Trafikverket – live train positions',
  licence: `${TRAFIKVERKET.licence}; rail network ODbL 1.0`,
  attribution: 'Trafikverket; rail network OpenFreeMap © OpenMapTiles Data from OpenStreetMap',
  homepage: TRAFIKVERKET.homepage,
  mode: 'poll',
  intervalMs: 15_000,
  allowedHosts: [TRAFIKVERKET.host, OPENFREEMAP_HOST],
  requiredEnv: TRAFIKVERKET.requiredEnv,
  channels: [{ name: RAIL, kind: 'entities' }],
  async poll(ctx) {
    const raw = await trafikverketQuery(
      ctx,
      'TrainPosition',
      `<QUERY objecttype="TrainPosition" namespace="järnväg.trafikinfo" schemaversion="1.1">` +
        `<FILTER><AND><WITHIN name="Position.WGS84" ${TRAFIKVERKET.box} />` +
        `<GT name="TimeStamp" value="$dateadd(-0.00:10:00)" /></AND></FILTER></QUERY>`,
    );
    const reports = parseTrainPositions(raw);
    try {
      await refreshTrainInfo(ctx, [...new Set(reports.map((r) => r.number))]);
    } catch (err) {
      ctx.log.warn({ err }, 'Train announcements unavailable');
    }
    const points = reports.flatMap((r) => {
      const prev = railTracks.get(r.id);
      return [{ ...r, weight: 1 }, ...(prev ? [{ ...prev, weight: 1 }] : [])];
    });
    await STREET_NETWORK.ensure(ctx, rankTiles(points, NETWORK_MARGIN_M), NETWORK_FETCHES_PER_POLL);
    const result = trainEntities(reports, trainInfo, railTracks, STREET_NETWORK);
    railTracks = result.tracks;
    ctx.publish.replace(RAIL, result.entities);
  },
};

// --- Operational rail events (disruptions) ---

const RAIL_EVENTS = 'events.rail';
const COUNTY_VASTRA_GOTALAND = 14;
const MAX_DISTANCE_M = 80_000;
const MAX_AGE_MS = 2 * 24 * 3600_000;

const OperativeEvent = z.object({
  OperativeEventId: z.string().min(1).max(64),
  EventType: z.object({ Description: z.string() }).optional(),
  StartDateTime: z.string(),
  EndDateTime: z.string().optional(),
  Deleted: z.boolean().optional(),
  Geometry: z.object({ WGS84: z.string() }).optional(),
  EventSection: z
    .array(
      z.object({
        FromLocation: z.object({ Signature: z.string() }).optional(),
        ToLocation: z.object({ Signature: z.string() }).optional(),
      }),
    )
    .optional(),
  TrafficImpact: z
    .array(
      z.object({
        EndDateTime: z.string().optional(),
        PublicMessage: z
          .object({ Header: z.string().optional(), Description: z.string().optional() })
          .optional(),
      }),
    )
    .optional(),
});

/** Operative events give WGS84 points as `POINT (lat lon)`; accept either order in Sweden. */
export function railEventPoint(wkt: string): LonLat | undefined {
  const p = parseWktPoint(wkt);
  if (!p) return undefined;
  const [a, b] = p;
  const swapped = a > 54 && a < 70 && b > 10 && b < 25;
  return swapped ? [b, a] : [a, b];
}

export function parseRailEvents(
  raw: readonly unknown[],
  stationNames: ReadonlyMap<string, string>,
  now: number,
): GeoEvent[] {
  const centre = GOTHENBURG.center;
  const events: GeoEvent[] = [];
  for (const item of raw) {
    const parsed = OperativeEvent.safeParse(item);
    if (!parsed.success || parsed.data.Deleted) continue;
    const e = parsed.data;
    const start = isoTime(e.StartDateTime);
    const end = isoTime(e.EndDateTime);
    if (!start || Date.parse(start) > now || now - Date.parse(start) > MAX_AGE_MS) continue;
    if (end && Date.parse(end) <= now) continue;
    const point = e.Geometry ? railEventPoint(e.Geometry.WGS84) : undefined;
    if (!point || distanceM({ lon: point[0], lat: point[1] }, centre) > MAX_DISTANCE_M) continue;
    const section = e.EventSection?.[0];
    const name = (sig: string | undefined) => (sig ? (stationNames.get(sig) ?? sig) : undefined);
    const where = [name(section?.FromLocation?.Signature), name(section?.ToLocation?.Signature)]
      .filter(Boolean)
      .join('–');
    const message = e.TrafficImpact?.find((t) => t.PublicMessage?.Header)?.PublicMessage;
    const what = message?.Header ?? e.EventType?.Description ?? 'Störning';
    const body = [message?.Description, message ? e.EventType?.Description : undefined]
      .filter((s): s is string => Boolean(s?.trim()))
      .join(' · ');
    events.push({
      id: e.OperativeEventId,
      source: 'trafikverket',
      category: 'Rail',
      severity: e.TrafficImpact?.length ? 'major' : 'minor',
      title: truncate(where ? `${where}: ${what}` : what, 300),
      ...(body && { body: truncate(body, 1000) }),
      geometry: { type: 'Point', coordinates: point },
      locationPrecision: 'area',
      start,
      ...(end && { end }),
    });
  }
  return events;
}

export const trafikverketRailEvents: PollConnector = {
  id: 'trafikverket.railevents',
  name: 'Trafikverket – rail disruptions',
  licence: TRAFIKVERKET.licence,
  attribution: 'Trafikverket',
  homepage: TRAFIKVERKET.homepage,
  mode: 'poll',
  intervalMs: 2 * 60_000,
  allowedHosts: [TRAFIKVERKET.host],
  requiredEnv: TRAFIKVERKET.requiredEnv,
  channels: [{ name: RAIL_EVENTS, kind: 'events' }],
  async poll(ctx) {
    const names = await loadStationNames(ctx);
    const raw = await trafikverketQuery(
      ctx,
      'OperativeEvent',
      `<QUERY objecttype="OperativeEvent" namespace="ols.open" schemaversion="1.0" limit="200">` +
        `<FILTER><AND><EQ name="Deleted" value="false" />` +
        `<EQ name="CountyNo" value="${COUNTY_VASTRA_GOTALAND}" />` +
        `<GT name="ModifiedDateTime" value="$dateadd(-2.00:00:00)" /></AND></FILTER></QUERY>`,
    );
    ctx.publish.replace(RAIL_EVENTS, parseRailEvents(raw, names, Date.now()));
  },
};
