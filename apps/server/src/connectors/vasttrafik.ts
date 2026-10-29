import { GOTHENBURG, type Departure, type Entity, type TransportMode } from '@gbg-osint/shared';
import { z } from 'zod';
import type { ConnectorContext, PollConnector } from '../core/connector';
import { UpstreamError } from '../core/http';
import { OPENFREEMAP_HOST } from './buildings';
import {
  STREET_NETWORK,
  placeOnNetwork,
  rankTiles,
  type NetworkName,
  type Placed,
  type StreetNetwork,
} from './streetNetwork';
import { bearing, distanceM, isoTime, truncate } from './util';

const HOST = 'ext-api.vasttrafik.se';
const API = `https://${HOST}/pr/v4`;
const REQUIRED_ENV = ['VASTTRAFIK_CLIENT_ID', 'VASTTRAFIK_CLIENT_SECRET'] as const;
const VEHICLES = 'transit.vehicles';
const DEPARTURES = 'transit.departures';
const LICENCE = 'Västtrafik API terms of use';

/** The positions endpoint returns at most 200 vehicles, so busy areas are split into quadrants. */
const PAGE_LIMIT = 200;
const MAX_SPLIT_DEPTH = 3;
const MAX_REQUESTS_PER_POLL = 24;
const POSITION_MODES = ['tram', 'bus', 'ferry', 'train'] as const;
/** Movement below this is GPS noise; keep the previous heading. */
const MIN_HEADING_MOVE_M = 8;
const TOKEN_MARGIN_MS = 5 * 60_000;

/** Which network each mode is matched to, and how the match is labelled. */
const NETWORK_BY_MODE: Record<string, NetworkName> = { tram: 'tram', bus: 'road', train: 'rail' };
const MATCHED: Record<NetworkName, string> = { tram: 'track', road: 'street', rail: 'rail' };
/** Network tiles are loaded this far around vehicles. */
const NETWORK_MARGIN_M = 150;
/** New network tiles fetched per poll; the disk cache keeps them for 30 days. */
const NETWORK_FETCHES_PER_POLL = 24;

/** Stop areas whose departure boards are shown. */
export const HUBS = [
  { gid: '9021014001760000', name: 'Brunnsparken' },
  { gid: '9021014004940000', name: 'Nils Ericson Terminalen' },
  { gid: '9021014003980000', name: 'Korsvägen' },
  { gid: '9021014003640000', name: 'Järntorget' },
  { gid: '9021014003180000', name: 'Hjalmar Brantingsplatsen' },
  { gid: '9021014006242000', name: 'Stenpiren' },
] as const;

const KIND_BY_MODE: Record<string, Entity['kind']> = {
  tram: 'tram',
  bus: 'bus',
  ferry: 'ferry',
  train: 'train',
};

const BOARD_MODES = new Set<TransportMode>(['tram', 'bus', 'ferry', 'train']);
const HEX = /^#[0-9a-f]{6}$/i;

function lineColors(line: { backgroundColor?: string; foregroundColor?: string }) {
  const { backgroundColor: bg, foregroundColor: fg } = line;
  return bg && fg && HEX.test(bg) && HEX.test(fg) ? { bg, fg } : undefined;
}

// --- OAuth2 client-credentials token, shared by both connectors ---

const TokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});
let token: { value: string; expiresAt: number } | undefined;
let pendingToken: Promise<string> | undefined;

async function fetchToken(ctx: ConnectorContext): Promise<string> {
  const credentials = `${ctx.env.VASTTRAFIK_CLIENT_ID}:${ctx.env.VASTTRAFIK_CLIENT_SECRET}`;
  const raw = await ctx.http.postJson(`https://${HOST}/token`, 'grant_type=client_credentials', {
    headers: {
      authorization: `Basic ${Buffer.from(credentials).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
  });
  const parsed = TokenResponse.parse(raw);
  token = { value: parsed.access_token, expiresAt: Date.now() + parsed.expires_in * 1000 };
  return parsed.access_token;
}

function getToken(ctx: ConnectorContext): Promise<string> {
  if (token && Date.now() < token.expiresAt - TOKEN_MARGIN_MS) return Promise.resolve(token.value);
  pendingToken ??= fetchToken(ctx).finally(() => {
    pendingToken = undefined;
  });
  return pendingToken;
}

async function apiGet(ctx: ConnectorContext, url: string): Promise<unknown> {
  const call = async () =>
    ctx.http.getJson(url, { headers: { authorization: `Bearer ${await getToken(ctx)}` } });
  try {
    return await call();
  } catch (err) {
    if (!(err instanceof UpstreamError) || err.status !== 401) throw err;
    token = undefined;
    return call();
  }
}

// --- Vehicle positions ---

const Line = z.object({
  name: z.string().min(1),
  backgroundColor: z.string().optional(),
  foregroundColor: z.string().optional(),
  transportMode: z.string(),
  isRealtimeJourney: z.boolean().optional(),
  operator: z.string().optional(),
});
const Position = z.object({
  detailsReference: z.string().min(1).max(128),
  line: Line,
  direction: z.string().optional(),
  directionDetails: z.object({ shortDirection: z.string().optional() }).optional(),
  latitude: z.number(),
  longitude: z.number(),
});

export interface Track {
  lon: number;
  lat: number;
  heading?: number;
}

/** Network tiles around matchable vehicles (and where they were), trams first. */
export function networkTilesFor(
  raw: readonly unknown[],
  previous: ReadonlyMap<string, Track>,
): [number, number][] {
  const points: { lon: number; lat: number; weight: number }[] = [];
  for (const item of raw) {
    const parsed = Position.safeParse(item);
    if (!parsed.success) continue;
    const p = parsed.data;
    if (!NETWORK_BY_MODE[p.line.transportMode]) continue;
    const weight = p.line.transportMode === 'tram' ? 3 : 1;
    points.push({ lon: p.longitude, lat: p.latitude, weight });
    const prev = previous.get(p.detailsReference);
    if (prev) points.push({ ...prev, weight });
  }
  return rankTiles(points, NETWORK_MARGIN_M);
}

interface Placement extends Placed {
  matched?: string;
}

/** Snaps a vehicle to its network and routes from where it was, or uses the raw position. */
function place(
  mode: string,
  here: { lon: number; lat: number },
  prev: Track | undefined,
  network: StreetNetwork | undefined,
): Placement {
  const name = NETWORK_BY_MODE[mode];
  const placed = name && network ? placeOnNetwork(network, name, here, prev) : undefined;
  if (placed) return { ...placed, matched: MATCHED[name!] };
  const heading =
    prev && distanceM(prev, here) >= MIN_HEADING_MOVE_M ? bearing(prev, here) : prev?.heading;
  return { ...here, ...(heading !== undefined && { heading }) };
}

/**
 * Vehicle entities. Trams, buses and trains are matched to the track or street network when it
 * is loaded (`via` then carries the route since the previous poll); otherwise headings are
 * derived from movement since the previous poll.
 */
export function parseVehicles(
  raw: readonly unknown[],
  previous: ReadonlyMap<string, Track>,
  ts: string,
  network?: StreetNetwork,
): { entities: Entity[]; tracks: Map<string, Track> } {
  const entities: Entity[] = [];
  const tracks = new Map<string, Track>();
  for (const item of raw) {
    const parsed = Position.safeParse(item);
    if (!parsed.success || tracks.has(parsed.data.detailsReference)) continue;
    const p = parsed.data;
    const prev = previous.get(p.detailsReference);
    const { via, matched, axis, ...here } = place(
      p.line.transportMode,
      { lon: p.longitude, lat: p.latitude },
      prev,
      network,
    );
    tracks.set(p.detailsReference, here);
    const shown = here.heading ?? axis;
    const colors = lineColors(p.line);
    const direction = p.directionDetails?.shortDirection ?? p.direction;
    entities.push({
      id: p.detailsReference,
      source: 'vasttrafik',
      kind: KIND_BY_MODE[p.line.transportMode] ?? 'vehicle',
      lon: here.lon,
      lat: here.lat,
      ...(shown !== undefined && { heading: shown }),
      label: truncate(p.line.name, 40),
      ts,
      ...(via && { via }),
      props: {
        line: p.line.name,
        ...(direction && { direction }),
        mode: p.line.transportMode,
        ...(p.line.operator && { operator: p.line.operator }),
        ...(p.line.isRealtimeJourney !== undefined && { realtime: p.line.isRealtimeJourney }),
        ...(colors && { color: colors.bg, textColor: colors.fg }),
        ...(matched && { matched }),
      },
    });
  }
  return { entities, tracks };
}

interface Box {
  w: number;
  s: number;
  e: number;
  n: number;
}

async function positionsIn(
  ctx: ConnectorContext,
  mode: string,
  box: Box,
  depth: number,
  budget: { left: number },
): Promise<unknown[]> {
  budget.left--;
  const q = (v: number) => v.toFixed(5);
  const raw = await apiGet(
    ctx,
    `${API}/positions?lowerLeftLat=${q(box.s)}&lowerLeftLong=${q(box.w)}` +
      `&upperRightLat=${q(box.n)}&upperRightLong=${q(box.e)}` +
      `&transportModes=${mode}&limit=${PAGE_LIMIT}`,
  );
  const items = Array.isArray(raw) ? (raw as unknown[]) : [];
  if (items.length < PAGE_LIMIT || depth >= MAX_SPLIT_DEPTH || budget.left < 4) return items;
  const midLon = (box.w + box.e) / 2;
  const midLat = (box.s + box.n) / 2;
  const quadrants: Box[] = [
    { w: box.w, s: box.s, e: midLon, n: midLat },
    { w: midLon, s: box.s, e: box.e, n: midLat },
    { w: box.w, s: midLat, e: midLon, n: box.n },
    { w: midLon, s: midLat, e: box.e, n: box.n },
  ];
  const all: unknown[] = [];
  for (const quadrant of quadrants) {
    all.push(...(await positionsIn(ctx, mode, quadrant, depth + 1, budget)));
  }
  return all;
}

let tracks = new Map<string, Track>();
const network = STREET_NETWORK;

export const vasttrafikVehicles: PollConnector = {
  id: 'vasttrafik.vehicles',
  name: 'Västtrafik – vehicle positions',
  licence: `${LICENCE}; street network ODbL 1.0`,
  attribution: 'Västtrafik; street network OpenFreeMap © OpenMapTiles Data from OpenStreetMap',
  homepage: 'https://developer.vasttrafik.se/',
  mode: 'poll',
  intervalMs: 15_000,
  allowedHosts: [HOST, OPENFREEMAP_HOST],
  requiredEnv: REQUIRED_ENV,
  channels: [{ name: VEHICLES, kind: 'entities' }],
  async poll(ctx) {
    const { west, south, east, north } = GOTHENBURG.bbox;
    const budget = { left: MAX_REQUESTS_PER_POLL };
    const raw: unknown[] = [];
    for (const mode of POSITION_MODES) {
      raw.push(
        ...(await positionsIn(ctx, mode, { w: west, s: south, e: east, n: north }, 0, budget)),
      );
    }
    await network.ensure(ctx, networkTilesFor(raw, tracks), NETWORK_FETCHES_PER_POLL);
    const result = parseVehicles(raw, tracks, new Date().toISOString(), network);
    tracks = result.tracks;
    ctx.publish.replace(VEHICLES, result.entities);
  },
};

// --- Departure boards ---

const DepartureRow = z.object({
  detailsReference: z.string().min(1).max(100),
  serviceJourney: z.object({
    direction: z.string().optional(),
    directionDetails: z.object({ shortDirection: z.string().optional() }).optional(),
    line: z.object({
      name: z.string(),
      shortName: z.string().optional(),
      designation: z.string().optional(),
      backgroundColor: z.string().optional(),
      foregroundColor: z.string().optional(),
      transportMode: z.string(),
    }),
  }),
  stopPoint: z.object({ platform: z.string().optional() }).optional(),
  plannedTime: z.string(),
  estimatedTime: z.string().nullish(),
  isCancelled: z.boolean().optional(),
  isPartCancelled: z.boolean().optional(),
});
const DeparturesResponse = z.object({ results: z.array(z.unknown()) });

export function parseDepartures(raw: unknown, hub: { gid: string; name: string }): Departure[] {
  const rows: Departure[] = [];
  for (const item of DeparturesResponse.parse(raw).results) {
    const parsed = DepartureRow.safeParse(item);
    if (!parsed.success) continue;
    const d = parsed.data;
    const planned = isoTime(d.plannedTime);
    if (!planned) continue;
    const expected = isoTime(d.estimatedTime);
    const line = d.serviceJourney.line;
    const mode = line.transportMode as TransportMode;
    const colors = lineColors(line);
    const platform = d.stopPoint?.platform;
    rows.push({
      id: `${hub.gid}-${d.detailsReference}`,
      source: 'vasttrafik',
      board: hub.name,
      direction: 'departure',
      mode: BOARD_MODES.has(mode) ? mode : 'bus',
      line: truncate(line.shortName ?? line.designation ?? line.name, 40),
      place: truncate(
        d.serviceJourney.directionDetails?.shortDirection ?? d.serviceJourney.direction ?? '–',
        200,
      ),
      planned,
      ...(expected && { expected }),
      ...(platform && { platform: truncate(platform, 40) }),
      ...(d.isCancelled
        ? { status: 'Cancelled' }
        : d.isPartCancelled
          ? { status: 'Partly cancelled' }
          : {}),
      cancelled: d.isCancelled ?? false,
      ...(colors && { colors }),
    });
  }
  return rows;
}

export const vasttrafikDepartures: PollConnector = {
  id: 'vasttrafik.departures',
  name: 'Västtrafik – departure boards',
  licence: LICENCE,
  attribution: 'Västtrafik',
  homepage: 'https://developer.vasttrafik.se/',
  mode: 'poll',
  intervalMs: 90_000,
  allowedHosts: [HOST],
  requiredEnv: REQUIRED_ENV,
  channels: [{ name: DEPARTURES, kind: 'departures' }],
  async poll(ctx) {
    const rows: Departure[] = [];
    let firstError: unknown;
    for (const hub of HUBS) {
      try {
        const raw = await apiGet(
          ctx,
          `${API}/stop-areas/${hub.gid}/departures?limit=20&timeSpanInMinutes=60`,
        );
        rows.push(...parseDepartures(raw, hub));
      } catch (err) {
        firstError ??= err;
      }
    }
    if (rows.length === 0 && firstError) throw firstError;
    ctx.publish.replace(DEPARTURES, rows);
  },
};
