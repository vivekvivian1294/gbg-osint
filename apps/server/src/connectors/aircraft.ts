import { GOTHENBURG, type Entity, type Metric } from '@gbg-osint/shared';
import { z } from 'zod';
import type { PollConnector } from '../core/connector';
import { normalizeHeading } from './util';

const CHANNEL = 'aviation.aircraft';
const GNSS_CHANNEL = 'aviation.gnss';
const RADIUS_NM = 100;
const MAX_POSITION_AGE_S = 60;
const FEET_TO_M = 0.3048;
const KNOTS_TO_MS = 0.514444;

/** readsb dbFlags: 1 military, 2 interesting, 4 PIA, 8 LADD. */
const FLAG_MILITARY = 1;
const FLAG_PRIVACY = 4 | 8;

const Aircraft = z.object({
  hex: z.string().regex(/^~?[0-9a-f]{6}$/i),
  flight: z.string().optional(),
  r: z.string().optional(),
  t: z.string().optional(),
  lat: z.number(),
  lon: z.number(),
  alt_baro: z.union([z.number(), z.literal('ground')]).optional(),
  alt_geom: z.number().optional(),
  gs: z.number().optional(),
  track: z.number().optional(),
  true_heading: z.number().optional(),
  squawk: z.string().optional(),
  category: z.string().optional(),
  seen_pos: z.number().optional(),
  dbFlags: z.number().optional(),
  nic: z.number().int().optional(),
  mlat: z.array(z.string()).optional(),
  tisb: z.array(z.string()).optional(),
});
const Response = z.object({ now: z.number(), ac: z.array(z.unknown()) });

export function parseAircraft(raw: unknown): Entity[] {
  const { now, ac } = Response.parse(raw);
  const entities: Entity[] = [];
  for (const item of ac) {
    const parsed = Aircraft.safeParse(item);
    if (!parsed.success) continue;
    const a = parsed.data;
    const flags = a.dbFlags ?? 0;
    if (flags & FLAG_PRIVACY) continue;
    if ((a.seen_pos ?? 0) > MAX_POSITION_AGE_S) continue;
    const onGround = a.alt_baro === 'ground';
    const altFeet = a.alt_geom ?? (typeof a.alt_baro === 'number' ? a.alt_baro : undefined);
    const heading = a.track ?? a.true_heading;
    const callsign = a.flight?.trim();
    entities.push({
      id: a.hex.toLowerCase(),
      source: 'adsb.fi',
      kind: 'aircraft',
      lon: a.lon,
      lat: a.lat,
      alt: onGround ? 0 : Math.max(0, (altFeet ?? 0) * FEET_TO_M),
      ...(heading !== undefined && { heading: normalizeHeading(heading) }),
      ...(a.gs !== undefined && { speed: a.gs * KNOTS_TO_MS }),
      label: callsign || a.r || a.hex.toUpperCase(),
      ts: new Date(now - (a.seen_pos ?? 0) * 1000).toISOString(),
      props: {
        ...(callsign && { callsign }),
        ...(a.r && { registration: a.r }),
        ...(a.t && { type: a.t }),
        ...(a.squawk && { squawk: a.squawk }),
        ...(altFeet !== undefined && { altitudeFt: altFeet }),
        onGround,
        military: Boolean(flags & FLAG_MILITARY),
      },
    });
  }
  return entities;
}

/** NIC below 7 means the aircraft can't vouch for its GNSS position to within 0.2 NM. */
const NIC_DEGRADED_BELOW = 7;
const MIN_GNSS_SAMPLE = 5;

/**
 * Share of airborne aircraft reporting degraded GNSS position integrity, like gpsjam.org.
 * Positions from multilateration or TIS-B don't come from the aircraft's own GNSS and are skipped.
 */
export function gnssMetrics(raw: unknown): Metric[] {
  const { now, ac } = Response.parse(raw);
  let sampled = 0;
  let degraded = 0;
  for (const item of ac) {
    const parsed = Aircraft.safeParse(item);
    if (!parsed.success) continue;
    const a = parsed.data;
    if (a.nic === undefined || a.alt_baro === 'ground' || (a.seen_pos ?? 0) > MAX_POSITION_AGE_S) {
      continue;
    }
    if ((a.mlat?.length ?? 0) > 0 || (a.tisb?.length ?? 0) > 0) continue;
    sampled++;
    if (a.nic < NIC_DEGRADED_BELOW) degraded++;
  }
  const base = { source: 'adsb.fi', ts: new Date(now).toISOString() } as const;
  const metrics: Metric[] = [
    { ...base, id: 'gnss-sampled', name: 'Aircraft sampled', unit: 'aircraft', value: sampled },
  ];
  if (sampled >= MIN_GNSS_SAMPLE) {
    metrics.unshift({
      ...base,
      id: 'gnss-degraded',
      name: 'GNSS degraded',
      unit: '%',
      value: Math.round((100 * degraded) / sampled),
    });
  }
  return metrics;
}

/** adsb.fi open data allows 1 request/s for personal, non-commercial use, with attribution. */
export const adsbFi: PollConnector = {
  id: 'adsbfi.aircraft',
  name: 'adsb.fi – aircraft',
  licence: 'adsb.fi open data terms (non-commercial, attribution)',
  attribution: 'adsb.fi',
  homepage: 'https://adsb.fi/',
  mode: 'poll',
  intervalMs: 10_000,
  allowedHosts: ['opendata.adsb.fi'],
  channels: [
    { name: CHANNEL, kind: 'entities' },
    { name: GNSS_CHANNEL, kind: 'metrics' },
  ],
  async poll(ctx) {
    const { lat, lon } = GOTHENBURG.center;
    const raw = await ctx.http.getJson(
      `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${RADIUS_NM}`,
    );
    ctx.publish.replace(CHANNEL, parseAircraft(raw));
    ctx.publish.replace(GNSS_CHANNEL, gnssMetrics(raw));
  },
};
