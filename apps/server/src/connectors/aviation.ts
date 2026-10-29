import type { Entity, FlightRoute } from '@gbg-osint/shared';
import { z } from 'zod';
import type { OnDemandConnector, PollConnector } from '../core/connector';
import { UpstreamError } from '../core/http';
import { isoTime, truncate } from './util';

// --- Airport weather (METAR and TAF) ---

const AWC_HOST = 'aviationweather.gov';
const AIRPORT_WEATHER = 'aviation.metar';
const AIRPORTS: Record<string, string> = {
  ESGG: 'Göteborg Landvetter',
  ESGP: 'Göteborg Säve',
};

const Cloud = z.object({ cover: z.string(), base: z.number().nullish() });
const Metar = z.object({
  icaoId: z.string(),
  reportTime: z.string(),
  lat: z.number(),
  lon: z.number(),
  rawOb: z.string().min(4).max(500),
  rawTaf: z.string().max(2000).nullish(),
  fltCat: z.string().max(8).nullish(),
  temp: z.number().nullish(),
  dewp: z.number().nullish(),
  wdir: z.union([z.number(), z.string()]).nullish(),
  wspd: z.number().nullish(),
  wgst: z.number().nullish(),
  visib: z.union([z.number(), z.string()]).nullish(),
  altim: z.number().nullish(),
  clouds: z.array(Cloud).nullish(),
});

/** Lowest broken or overcast layer, in feet. */
function ceilingFt(clouds: readonly z.infer<typeof Cloud>[] | null | undefined) {
  const bases = (clouds ?? [])
    .filter((c) => ['BKN', 'OVC', 'OVX'].includes(c.cover) && typeof c.base === 'number')
    .map((c) => c.base!);
  return bases.length > 0 ? Math.min(...bases) : undefined;
}

export function parseMetars(raw: unknown): Entity[] {
  const entities: Entity[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const parsed = Metar.safeParse(item);
    if (!parsed.success || !AIRPORTS[parsed.data.icaoId]) continue;
    const m = parsed.data;
    const ts = isoTime(m.reportTime);
    if (!ts) continue;
    const ceiling = ceilingFt(m.clouds);
    entities.push({
      id: m.icaoId,
      source: 'aviationweather',
      kind: 'sensor',
      lon: m.lon,
      lat: m.lat,
      label: m.fltCat ? `${m.icaoId} ${m.fltCat}` : m.icaoId,
      ts,
      props: {
        airport: AIRPORTS[m.icaoId],
        ...(m.fltCat && { flightCategory: m.fltCat }),
        ...(m.wdir != null && { windDir: String(m.wdir) }),
        ...(m.wspd != null && { windKt: m.wspd }),
        ...(m.wgst != null && { gustKt: m.wgst }),
        ...(m.visib != null && { visibility: String(m.visib) }),
        ...(ceiling !== undefined && { ceilingFt: ceiling }),
        ...(m.temp != null && { tempC: m.temp }),
        ...(m.dewp != null && { dewpointC: m.dewp }),
        ...(m.altim != null && { qnhHpa: m.altim }),
        metar: truncate(m.rawOb, 500),
        ...(m.rawTaf && { taf: truncate(m.rawTaf, 2000) }),
      },
    });
  }
  return entities;
}

export const airportWeather: PollConnector = {
  id: 'aviationweather.metar',
  name: 'Aviation Weather Center – METAR/TAF',
  licence: 'Public domain (US government data)',
  attribution: 'NOAA Aviation Weather Center',
  homepage: 'https://aviationweather.gov/',
  mode: 'poll',
  intervalMs: 10 * 60_000,
  allowedHosts: [AWC_HOST],
  channels: [{ name: AIRPORT_WEATHER, kind: 'entities' }],
  async poll(ctx) {
    const ids = Object.keys(AIRPORTS).join(',');
    const raw = await ctx.http.getJson(
      `https://${AWC_HOST}/api/data/metar?ids=${ids}&format=json&taf=true`,
    );
    ctx.publish.replace(AIRPORT_WEATHER, parseMetars(raw));
  },
};

// --- Flight routes by callsign (adsbdb) ---

const ADSBDB_HOST = 'api.adsbdb.com';
const CALLSIGN_PATH = /^callsign\/([A-Z0-9]{3,8})\.json$/;
const MIN_INTERVAL_MS = 300;
const MAX_CACHED = 2_000;
const CACHE_TTL_MS = 12 * 3600_000;

const AdsbdbAirport = z.object({
  icao_code: z.string().min(3).max(4),
  iata_code: z.string().max(3).nullish(),
  name: z.string().min(1),
  municipality: z.string().nullish(),
  country_name: z.string().nullish(),
});
const AdsbdbRoute = z.object({
  response: z.object({
    flightroute: z.object({
      callsign: z.string(),
      callsign_iata: z.string().nullish(),
      airline: z.object({ name: z.string() }).nullish(),
      origin: AdsbdbAirport,
      destination: AdsbdbAirport,
    }),
  }),
});

function airport(a: z.infer<typeof AdsbdbAirport>): FlightRoute['origin'] {
  return {
    icao: a.icao_code,
    ...(a.iata_code && { iata: a.iata_code }),
    name: truncate(a.name, 120),
    ...(a.municipality && { city: truncate(a.municipality, 80) }),
    ...(a.country_name && { country: truncate(a.country_name, 80) }),
  };
}

export function parseFlightRoute(raw: unknown, callsign: string): FlightRoute | undefined {
  const parsed = AdsbdbRoute.safeParse(raw);
  if (!parsed.success) return undefined;
  const r = parsed.data.response.flightroute;
  return {
    callsign,
    ...(r.callsign_iata && { flight: truncate(r.callsign_iata, 8) }),
    ...(r.airline && { airline: truncate(r.airline.name, 120) }),
    origin: airport(r.origin),
    destination: airport(r.destination),
  };
}

function createFlightRoutes(): OnDemandConnector {
  const cache = new Map<string, { route: FlightRoute | null; at: number }>();
  let queue: Promise<unknown> = Promise.resolve();
  let lastRequestAt = 0;

  const throttled = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(async () => {
      const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastRequestAt = Date.now();
      return fn();
    });
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    id: 'adsbdb.routes',
    name: 'adsbdb – flight routes',
    licence: 'adsbdb terms (free API)',
    attribution: 'adsbdb.com',
    homepage: 'https://www.adsbdb.com/',
    mode: 'on-demand',
    allowedHosts: [ADSBDB_HOST],
    channels: [],
    async serve(ctx, path) {
      const callsign = CALLSIGN_PATH.exec(path)?.[1];
      if (!callsign) return undefined;
      let hit = cache.get(callsign);
      if (!hit || Date.now() - hit.at > CACHE_TTL_MS) {
        let route: FlightRoute | null;
        try {
          const raw = await throttled(() =>
            ctx.http.getJson(`https://${ADSBDB_HOST}/v0/callsign/${callsign}`, {
              timeoutMs: 15_000,
            }),
          );
          route = parseFlightRoute(raw, callsign) ?? null;
        } catch (err) {
          if (!(err instanceof UpstreamError) || err.status !== 404) throw err;
          route = null;
        }
        hit = { route, at: Date.now() };
        cache.delete(callsign);
        cache.set(callsign, hit);
        if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
      }
      return hit.route
        ? { type: 'application/json', body: JSON.stringify(hit.route), maxAgeSec: 3600 }
        : undefined;
    },
  };
}

export const flightRoutes = createFlightRoutes();
