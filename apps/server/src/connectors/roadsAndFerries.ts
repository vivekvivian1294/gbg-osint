import { encodeLine, type Departure, type Feature } from '@gbg-osint/shared';
import { z } from 'zod';
import type { PollConnector } from '../core/connector';
import { TRAFIKVERKET, trafikverketQuery, xmlAttr } from './trafikverket';
import { isoTime, parseWktLine, truncate } from './util';

// --- Road ferries (Trafikverket Färjerederiet) ---

const FERRIES = 'transit.ferries';
/** Road ferry routes in and around Gothenburg. */
export const FERRY_ROUTES = [
  'Hönöleden',
  'Björköleden',
  'Nordöleden',
  'Kornhallsleden',
  'Lyrleden',
] as const;

const Harbor = z.object({ Name: z.string().min(1) });
const FerryAnnouncement = z.object({
  Id: z.union([z.number(), z.string()]),
  DepartureTime: z.string(),
  Deleted: z.boolean().optional(),
  FromHarbor: Harbor,
  ToHarbor: Harbor,
  Route: z.object({ Name: z.string().min(1) }),
});

/** One board per route; the line column shows where the ferry leaves from. */
export function parseFerryDepartures(raw: readonly unknown[]): Departure[] {
  const rows: Departure[] = [];
  for (const item of raw) {
    const parsed = FerryAnnouncement.safeParse(item);
    if (!parsed.success || parsed.data.Deleted) continue;
    const f = parsed.data;
    const planned = isoTime(f.DepartureTime);
    if (!planned) continue;
    rows.push({
      id: truncate(String(f.Id), 64),
      source: 'trafikverket',
      board: truncate(f.Route.Name, 80),
      direction: 'departure',
      mode: 'ferry',
      line: truncate(f.FromHarbor.Name, 40),
      place: truncate(f.ToHarbor.Name, 200),
      planned,
      cancelled: false,
    });
  }
  return rows;
}

export const trafikverketFerries: PollConnector = {
  id: 'trafikverket.ferries',
  name: 'Trafikverket – road ferry departures',
  licence: TRAFIKVERKET.licence,
  attribution: 'Trafikverket (Färjerederiet)',
  homepage: TRAFIKVERKET.homepage,
  mode: 'poll',
  intervalMs: 5 * 60_000,
  allowedHosts: [TRAFIKVERKET.host],
  requiredEnv: TRAFIKVERKET.requiredEnv,
  channels: [{ name: FERRIES, kind: 'departures' }],
  async poll(ctx) {
    const raw = await trafikverketQuery(
      ctx,
      'FerryAnnouncement',
      `<QUERY objecttype="FerryAnnouncement" schemaversion="1.2" orderby="DepartureTime" limit="600">` +
        `<FILTER><AND>` +
        `<IN name="Route.Name" value="${xmlAttr(FERRY_ROUTES.join(','))}" />` +
        `<GT name="DepartureTime" value="$dateadd(-00:10:00)" />` +
        `<LT name="DepartureTime" value="$dateadd(03:00:00)" />` +
        `</AND></FILTER></QUERY>`,
    );
    ctx.publish.replace(FERRIES, parseFerryDepartures(raw));
  },
};

// --- Measured road travel times ---

const TRAVEL_TIMES = 'roads.travel-times';
const COUNTY_VASTRA_GOTALAND = 14;

const TravelTimeRoute = z.object({
  Id: z.string().min(1).max(64),
  Name: z.string().min(1),
  MeasureTime: z.string(),
  Speed: z.number().nonnegative().optional(),
  TravelTime: z.number().positive().optional(),
  FreeFlowTravelTime: z.number().positive().optional(),
  Length: z.number().positive().optional(),
  TrafficStatus: z.string().optional(),
  Deleted: z.boolean().optional(),
  Geometry: z.object({ WGS84: z.string() }),
});

const round1 = (v: number) => Math.round(v * 10) / 10;

export function parseTravelTimes(raw: readonly unknown[]): Feature[] {
  const features: Feature[] = [];
  for (const item of raw) {
    const parsed = TravelTimeRoute.safeParse(item);
    if (!parsed.success || parsed.data.Deleted) continue;
    const r = parsed.data;
    const coords = parseWktLine(r.Geometry.WGS84);
    const ts = isoTime(r.MeasureTime);
    if (!coords || !ts) continue;
    features.push({
      id: r.Id,
      source: 'trafikverket',
      kind: 'travel-time',
      line: encodeLine(coords),
      label: truncate(r.Name, 200),
      ts,
      props: {
        ...(r.Speed !== undefined && { speedKmh: round1(r.Speed) }),
        ...(r.TravelTime !== undefined && { travelTimeS: Math.round(r.TravelTime) }),
        ...(r.FreeFlowTravelTime !== undefined && {
          freeFlowS: Math.round(r.FreeFlowTravelTime),
        }),
        ...(r.Length !== undefined && { lengthM: Math.round(r.Length) }),
        ...(r.TrafficStatus && { status: truncate(r.TrafficStatus, 40) }),
      },
    });
  }
  return features;
}

export const trafikverketTravelTimes: PollConnector = {
  id: 'trafikverket.traveltimes',
  name: 'Trafikverket – road travel times',
  licence: TRAFIKVERKET.licence,
  attribution: 'Trafikverket',
  homepage: TRAFIKVERKET.homepage,
  mode: 'poll',
  intervalMs: 2 * 60_000,
  allowedHosts: [TRAFIKVERKET.host],
  requiredEnv: TRAFIKVERKET.requiredEnv,
  channels: [{ name: TRAVEL_TIMES, kind: 'features' }],
  async poll(ctx) {
    const raw = await trafikverketQuery(
      ctx,
      'TravelTimeRoute',
      `<QUERY objecttype="TravelTimeRoute" namespace="road.trafficinfo" schemaversion="1.6">` +
        `<FILTER><EQ name="CountyNo" value="${COUNTY_VASTRA_GOTALAND}" /></FILTER></QUERY>`,
    );
    ctx.publish.replace(TRAVEL_TIMES, parseTravelTimes(raw));
  },
};
