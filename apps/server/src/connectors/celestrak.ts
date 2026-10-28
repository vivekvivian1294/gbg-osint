import { GOTHENBURG, type Entity } from '@gbg-osint/shared';
import {
  degreesLat,
  degreesLong,
  ecfToLookAngles,
  eciToEcf,
  eciToGeodetic,
  gstime,
  json2satrec,
  propagate,
  type GeodeticLocation,
  type OMMJsonObject,
  type SatRec,
} from 'satellite.js';
import { z } from 'zod';
import type { ConnectorContext, PollConnector } from '../core/connector';
import { normalizeHeading } from './util';

const CHANNEL = 'space.satellites';
const GROUPS = ['stations', 'visual'] as const;
const REFRESH_MS = 6 * 3600_000;
const RETRY_MS = 30 * 60_000;
const MAX_ELEMENT_AGE_MS = 3 * 24 * 3600_000;
const MIN_ELEVATION_DEG = 0;

const OBSERVER: GeodeticLocation = {
  latitude: (GOTHENBURG.center.lat * Math.PI) / 180,
  longitude: (GOTHENBURG.center.lon * Math.PI) / 180,
  height: 0.01,
} as GeodeticLocation;

const Omm = z
  .object({
    OBJECT_NAME: z.string(),
    OBJECT_ID: z.string(),
    NORAD_CAT_ID: z.number().int().positive(),
    EPOCH: z.string(),
    MEAN_MOTION: z.number(),
    ECCENTRICITY: z.number(),
    INCLINATION: z.number(),
    RA_OF_ASC_NODE: z.number(),
    ARG_OF_PERICENTER: z.number(),
    MEAN_ANOMALY: z.number(),
    BSTAR: z.number(),
    MEAN_MOTION_DOT: z.number(),
    MEAN_MOTION_DDOT: z.number(),
  })
  .loose();

export interface Satellite {
  noradId: number;
  name: string;
  objectId: string;
  satrec: SatRec;
}

export function toSatellites(raw: readonly unknown[]): Satellite[] {
  const byId = new Map<number, Satellite>();
  for (const item of raw) {
    const parsed = Omm.safeParse(item);
    if (!parsed.success || byId.has(parsed.data.NORAD_CAT_ID)) continue;
    const omm = parsed.data;
    try {
      const satrec = json2satrec(omm as unknown as OMMJsonObject);
      byId.set(omm.NORAD_CAT_ID, {
        noradId: omm.NORAD_CAT_ID,
        name: omm.OBJECT_NAME.trim(),
        objectId: omm.OBJECT_ID,
        satrec,
      });
    } catch {
      // Malformed element sets are skipped.
    }
  }
  return [...byId.values()];
}

function bearingDeg(from: GeodeticLocation, to: GeodeticLocation): number {
  const dLon = to.longitude - from.longitude;
  const y = Math.sin(dLon) * Math.cos(to.latitude);
  const x =
    Math.cos(from.latitude) * Math.sin(to.latitude) -
    Math.sin(from.latitude) * Math.cos(to.latitude) * Math.cos(dLon);
  return normalizeHeading((Math.atan2(y, x) * 180) / Math.PI);
}

/** Satellites currently above Gothenburg's horizon, propagated with SGP4. */
export function visibleSatellites(sats: readonly Satellite[], date: Date): Entity[] {
  const gmst = gstime(date);
  const later = new Date(date.getTime() + 1000);
  const gmstLater = gstime(later);
  const entities: Entity[] = [];
  for (const s of sats) {
    const pv = propagate(s.satrec, date);
    if (!pv) continue;
    const look = ecfToLookAngles(OBSERVER, eciToEcf(pv.position, gmst));
    const elevation = (look.elevation * 180) / Math.PI;
    if (elevation < MIN_ELEVATION_DEG) continue;
    const geo = eciToGeodetic(pv.position, gmst);
    const next = propagate(s.satrec, later);
    const v = pv.velocity;
    entities.push({
      id: String(s.noradId),
      source: 'celestrak',
      kind: 'satellite',
      lon: degreesLong(geo.longitude),
      lat: degreesLat(geo.latitude),
      alt: geo.height * 1000,
      ...(next && { heading: bearingDeg(geo, eciToGeodetic(next.position, gmstLater)) }),
      speed: Math.hypot(v.x, v.y, v.z) * 1000,
      label: s.name,
      ts: date.toISOString(),
      props: {
        noradId: s.noradId,
        objectId: s.objectId,
        elevationDeg: Math.round(elevation * 10) / 10,
        azimuthDeg: Math.round(((look.azimuth * 180) / Math.PI) * 10) / 10,
        rangeKm: Math.round(look.rangeSat),
      },
    });
  }
  return entities;
}

let satellites: Satellite[] = [];
let nextFetchAt = 0;

async function loadSatellites(ctx: ConnectorContext): Promise<Satellite[]> {
  const now = Date.now();
  if (satellites.length > 0 && now < nextFetchAt) return satellites;

  const cached = await ctx.cache.get<unknown[]>('elements', REFRESH_MS);
  if (cached) {
    satellites = toSatellites(cached.value);
    nextFetchAt = cached.savedAt + REFRESH_MS;
    return satellites;
  }
  try {
    const lists = await Promise.all(
      GROUPS.map((g) =>
        ctx.http.getJson(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=json`),
      ),
    );
    const raw = lists.flatMap((l) => (Array.isArray(l) ? (l as unknown[]) : []));
    satellites = toSatellites(raw);
    await ctx.cache.set('elements', raw);
    nextFetchAt = now + REFRESH_MS;
  } catch (err) {
    // CelesTrak blocks clients that retry too often, so back off and keep older elements.
    nextFetchAt = now + RETRY_MS;
    if (satellites.length === 0) {
      const stale = await ctx.cache.get<unknown[]>('elements', MAX_ELEMENT_AGE_MS);
      if (!stale) throw err;
      satellites = toSatellites(stale.value);
    }
    ctx.log.warn({ err }, 'using previously downloaded orbital elements');
  }
  return satellites;
}

export const celestrak: PollConnector = {
  id: 'celestrak.satellites',
  name: 'CelesTrak – satellites overhead',
  licence: 'Public data (CelesTrak)',
  homepage: 'https://celestrak.org/',
  mode: 'poll',
  intervalMs: 5_000,
  allowedHosts: ['celestrak.org'],
  channels: [{ name: CHANNEL, kind: 'entities' }],
  async poll(ctx) {
    const sats = await loadSatellites(ctx);
    ctx.publish.replace(CHANNEL, visibleSatellites(sats, new Date()));
  },
};
