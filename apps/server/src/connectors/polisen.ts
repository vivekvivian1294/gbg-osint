import { GOTHENBURG, type GeoEvent, type Severity } from '@gbg-osint/shared';
import { z } from 'zod';
import type { PollConnector } from '../core/connector';
import { districtIn } from './districts';
import { truncate } from './util';

const CHANNEL = 'events.police';
const MAX_AGE_MS = 72 * 3600_000;

const PoliceEvent = z.object({
  id: z.number(),
  datetime: z.string(),
  name: z.string(),
  summary: z.string(),
  url: z.string(),
  type: z.string(),
});
const Response = z.array(z.unknown());

const MAJOR = new Set([
  'Skottlossning',
  'Skottlossning, misstänkt',
  'Explosion',
  'Mord/dråp',
  'Mord/dråp, försök',
  'Rån väpnat',
  'Bombhot',
]);
const MINOR = new Set([
  'Brand',
  'Trafikolycka, personskada',
  'Trafikolycka, vilt',
  'Misshandel, grov',
  'Rån',
  'Knivlagen',
  'Olaga hot',
  'Försvunnen person',
]);

function severity(type: string): Severity {
  if (MAJOR.has(type)) return 'major';
  if (MINOR.has(type)) return 'minor';
  return 'info';
}

/** `2026-10-23 7:00:14 +02:00` → `2026-10-23T07:00:14+02:00` */
export function parsePoliceTime(value: string): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2}):(\d{2}) ([+-]\d{2}:\d{2})$/.exec(value.trim());
  if (!m) return undefined;
  return `${m[1]}T${m[2]!.padStart(2, '0')}:${m[3]}:${m[4]}${m[5]}`;
}

/**
 * Polisen only reports county-level coordinates; the place is the last part of the event name,
 * e.g. "23 oktober 10.38, Brand, Göteborg". Events whose text names one district are placed at
 * its centre, the rest at the municipality centre; both are marked approximate.
 */
export function parsePoliceEvents(raw: unknown[], now: number): GeoEvent[] {
  const events: GeoEvent[] = [];
  for (const item of raw) {
    const parsed = PoliceEvent.safeParse(item);
    if (!parsed.success) continue;
    const e = parsed.data;
    if (e.name.split(',').at(-1)?.trim() !== 'Göteborg') continue;
    const start = parsePoliceTime(e.datetime);
    if (!start || now - Date.parse(start) > MAX_AGE_MS) continue;
    const district = districtIn(e.summary);
    events.push({
      id: String(e.id),
      source: 'polisen',
      category: e.type,
      severity: severity(e.type),
      title: truncate(e.summary || e.name, 300),
      geometry: {
        type: 'Point',
        coordinates: district?.at ?? [GOTHENBURG.center.lon, GOTHENBURG.center.lat],
      },
      ...(district
        ? { locationPrecision: 'district' as const, place: district.name }
        : { locationPrecision: 'municipality' as const }),
      start,
      ...(e.url.startsWith('/') && { url: `https://polisen.se${e.url}` }),
    });
  }
  return events;
}

export const polisenEvents: PollConnector = {
  id: 'polisen.events',
  name: 'Polisen – händelser',
  licence: 'Open data (terms at source); district centres CC0 (SCB) and ODbL 1.0 (OpenStreetMap)',
  attribution: 'Polisen; district centres SCB and © OpenStreetMap contributors',
  homepage: 'https://polisen.se/om-polisen/om-webbplatsen/oppna-data/api-over-polisens-handelser/',
  mode: 'poll',
  intervalMs: 3 * 60_000,
  allowedHosts: ['polisen.se'],
  channels: [{ name: CHANNEL, kind: 'events' }],
  async poll(ctx) {
    const raw = Response.parse(
      await ctx.http.getJson('https://polisen.se/api/events?locationname=G%C3%B6teborg'),
    );
    ctx.publish.replace(CHANNEL, parsePoliceEvents(raw, Date.now()));
  },
};
