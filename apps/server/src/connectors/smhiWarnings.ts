import type { GeoEvent, Severity } from '@gbg-osint/shared';
import { z } from 'zod';
import type { PollConnector } from '../core/connector';
import { truncate } from './util';

const CHANNEL = 'events.weather-warnings';

/** SMHI area ids: 14 = Västra Götalands län, 56 = Kattegatt (sea area off Gothenburg). */
const RELEVANT_AREAS = new Set([14, 56]);

const Text = z.object({ sv: z.string().optional(), en: z.string().optional() });
const WarningArea = z.object({
  id: z.number(),
  approximateStart: z.string(),
  approximateEnd: z.string().nullish(),
  areaName: Text,
  warningLevel: Text.extend({ code: z.string() }),
  eventDescription: Text,
  affectedAreas: z.array(z.object({ id: z.number() })),
  descriptions: z.array(z.object({ text: Text })).optional(),
});
const Warning = z.object({
  id: z.number(),
  event: Text,
  warningAreas: z.array(z.unknown()),
});
const Response = z.array(z.unknown());

const LEVELS: Record<string, Severity> = {
  MESSAGE: 'info',
  YELLOW: 'minor',
  ORANGE: 'major',
  RED: 'critical',
};

export function parseWarnings(raw: unknown[], now: number): GeoEvent[] {
  const events: GeoEvent[] = [];
  for (const item of raw) {
    const w = Warning.safeParse(item);
    if (!w.success) continue;
    for (const areaRaw of w.data.warningAreas) {
      const parsed = WarningArea.safeParse(areaRaw);
      if (!parsed.success) continue;
      const a = parsed.data;
      if (!a.affectedAreas.some((x) => RELEVANT_AREAS.has(x.id))) continue;
      if (a.approximateEnd && Date.parse(a.approximateEnd) < now) continue;
      const level = a.warningLevel.sv ?? a.warningLevel.code;
      const what = a.eventDescription.sv ?? w.data.event.sv ?? 'Varning';
      const body = (a.descriptions ?? [])
        .map((d) => d.text.sv)
        .filter(Boolean)
        .join(' ');
      events.push({
        id: `${w.data.id}-${a.id}`,
        source: 'smhi',
        category: w.data.event.sv ?? 'SMHI',
        severity: LEVELS[a.warningLevel.code] ?? 'info',
        title: truncate(`${level}: ${what} – ${a.areaName.sv ?? ''}`.trim(), 300),
        ...(body && { body: truncate(body, 1000) }),
        locationPrecision: 'region',
        start: new Date(a.approximateStart).toISOString(),
        ...(a.approximateEnd && { end: new Date(a.approximateEnd).toISOString() }),
      });
    }
  }
  return events;
}

export const smhiWarnings: PollConnector = {
  id: 'smhi.warnings',
  name: 'SMHI – vädervarningar',
  licence: 'CC BY 4.0',
  attribution: 'SMHI',
  homepage: 'https://opendata.smhi.se/',
  mode: 'poll',
  intervalMs: 5 * 60_000,
  allowedHosts: ['opendata-download-warnings.smhi.se'],
  channels: [{ name: CHANNEL, kind: 'events' }],
  async poll(ctx) {
    const raw = Response.parse(
      await ctx.http.getJson(
        'https://opendata-download-warnings.smhi.se/ibww/api/version/1/warning.json',
      ),
    );
    ctx.publish.replace(CHANNEL, parseWarnings(raw, Date.now()));
  },
};
