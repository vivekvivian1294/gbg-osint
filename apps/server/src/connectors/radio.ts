import { RadioStationSchema, type RadioStation } from '@gbg-osint/shared';
import { z } from 'zod';
import type { OnDemandConnector } from '../core/connector';
import { truncate } from './util';

const SR_HOST = 'api.sr.se';
const RADIO_BROWSER_HOST = 'de1.api.radio-browser.info';
const CACHE_MAX_AGE_MS = 24 * 3600_000;
const SR_CHANNELS = new Set(['P1', 'P2', 'P3', 'P4 Göteborg', 'P4 Väst']);
const MAX_STATIONS = 40;

const SrResponse = z.object({
  channels: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      siteurl: z.string().optional(),
      liveaudio: z.object({ url: z.string() }).optional(),
    }),
  ),
});

const httpsOrUndefined = (raw: string | undefined) => {
  const parsed = z.url({ protocol: /^https$/ }).safeParse(raw);
  return parsed.success ? parsed.data : undefined;
};

export function parseSrChannels(raw: unknown): RadioStation[] {
  return SrResponse.parse(raw).channels.flatMap((c) => {
    const stream = httpsOrUndefined(c.liveaudio?.url);
    if (!SR_CHANNELS.has(c.name) || !stream) return [];
    const homepage = httpsOrUndefined(c.siteurl);
    return [
      {
        id: `sr-${c.id}`,
        name: `Sveriges Radio ${c.name}`,
        provider: 'Sveriges Radio' as const,
        stream,
        ...(homepage && { homepage }),
        codec: 'MP3',
      },
    ];
  });
}

const RadioBrowserStation = z.object({
  stationuuid: z.uuid(),
  name: z.string().min(1),
  url_resolved: z.string(),
  homepage: z.string().optional(),
  codec: z.string().optional(),
  bitrate: z.number().int().optional(),
  lastcheckok: z.number().int(),
});

/** Working HTTPS streams only; plain-HTTP streams would be blocked on an HTTPS page. */
export function parseRadioBrowser(raw: unknown): RadioStation[] {
  const stations: RadioStation[] = [];
  for (const item of z.array(z.unknown()).parse(raw)) {
    const parsed = RadioBrowserStation.safeParse(item);
    if (!parsed.success || parsed.data.lastcheckok !== 1) continue;
    const s = parsed.data;
    // Sveriges Radio channels come straight from SR's own API.
    if (/sveriges radio|^(sr )?p[1-4]\b/i.test(s.name.trim())) continue;
    const stream = httpsOrUndefined(s.url_resolved);
    if (!stream) continue;
    const homepage = httpsOrUndefined(s.homepage);
    const station = RadioStationSchema.safeParse({
      id: `rb-${s.stationuuid}`,
      name: truncate(s.name.trim(), 120),
      provider: 'Radio Browser',
      stream,
      ...(homepage && { homepage }),
      ...(s.codec && { codec: s.codec.slice(0, 16) }),
      ...(s.bitrate && s.bitrate > 0 && { bitrateKbps: s.bitrate }),
    });
    if (station.success) stations.push(station.data);
  }
  return stations;
}

export const radioStations: OnDemandConnector = {
  id: 'radio.stations',
  name: 'Radio – Sveriges Radio and Radio Browser',
  licence: 'Stream links only (SR open API; Radio Browser public domain data)',
  attribution: 'Sveriges Radio, radio-browser.info',
  homepage: 'https://www.radio-browser.info/',
  mode: 'on-demand',
  allowedHosts: [SR_HOST, RADIO_BROWSER_HOST],
  channels: [],
  async serve(ctx, path) {
    if (path !== 'stations.json') return undefined;
    let stations = (await ctx.cache.get<RadioStation[]>('stations', CACHE_MAX_AGE_MS))?.value;
    if (!stations) {
      const [sr, nearby, named] = await Promise.allSettled([
        ctx.http.getJson(`https://${SR_HOST}/api/v2/channels?format=json&pagination=false`),
        ctx.http.getJson(
          `https://${RADIO_BROWSER_HOST}/json/stations/search?geo_lat=57.7089&geo_long=11.9746&geo_distance=40000&hidebroken=true&order=clickcount&reverse=true&limit=50`,
        ),
        ctx.http.getJson(
          `https://${RADIO_BROWSER_HOST}/json/stations/search?name=${encodeURIComponent('göteborg')}&hidebroken=true&order=clickcount&reverse=true&limit=50`,
        ),
      ]);
      const found = [
        ...(sr.status === 'fulfilled' ? parseSrChannels(sr.value) : []),
        ...[nearby, named].flatMap((r) =>
          r.status === 'fulfilled' ? parseRadioBrowser(r.value) : [],
        ),
      ];
      const seen = new Set<string>();
      stations = found
        .filter((s) => !seen.has(s.stream) && seen.add(s.stream))
        .slice(0, MAX_STATIONS);
      const failures = [sr, nearby, named].filter((r) => r.status === 'rejected');
      if (failures.length === 3) {
        const stale = await ctx.cache.get<RadioStation[]>('stations', Infinity);
        if (!stale) throw (failures[0] as PromiseRejectedResult).reason;
        stations = stale.value;
      } else if (failures.length === 0) {
        await ctx.cache.set('stations', stations);
      }
    }
    return { type: 'application/json', body: JSON.stringify({ stations }), maxAgeSec: 3600 };
  },
};
