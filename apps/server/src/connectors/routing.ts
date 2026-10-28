import { decodeLine, GOTHENBURG, type Route } from '@gbg-osint/shared';
import { z } from 'zod';
import type { OnDemandConnector } from '../core/connector';
import { UpstreamError } from '../core/http';

const HOST = 'routing.openstreetmap.de';
const PROFILES: Record<Route['profile'], string> = {
  foot: 'routed-foot',
  bike: 'routed-bike',
  car: 'routed-car',
};
/** The FOSSGIS servers ask for at most one request per second. */
const MIN_INTERVAL_MS = 1_000;
const MAX_CACHED = 300;
const MARGIN_DEG = 0.3;
/** FOSSGIS bike durations imply implausible speeds (segments near 100 km/h), so cycling time is estimated. */
const BIKE_SPEED_MS = 16 / 3.6;
const NUM = '(-?\\d{1,3}\\.\\d{1,6})';
const ROUTE_PATH = new RegExp(`^route/(foot|bike|car)/${NUM}/${NUM}/${NUM}/${NUM}\\.json$`);

const Osrm = z.object({
  code: z.string(),
  routes: z
    .array(z.object({ distance: z.number(), duration: z.number(), geometry: z.string() }))
    .optional(),
});

export interface RouteRequest {
  profile: Route['profile'];
  from: [number, number];
  to: [number, number];
}

/** Parses `route/<profile>/<lon>/<lat>/<lon>/<lat>.json`; both ends must be near Gothenburg. */
export function parseRoutePath(path: string): RouteRequest | undefined {
  const m = ROUTE_PATH.exec(path);
  if (!m) return undefined;
  const [lon1, lat1, lon2, lat2] = m.slice(2).map(Number) as [number, number, number, number];
  const { west, south, east, north } = GOTHENBURG.bbox;
  const near = (lon: number, lat: number) =>
    lon >= west - MARGIN_DEG &&
    lon <= east + MARGIN_DEG &&
    lat >= south - MARGIN_DEG &&
    lat <= north + MARGIN_DEG;
  if (!near(lon1, lat1) || !near(lon2, lat2)) return undefined;
  return { profile: m[1] as Route['profile'], from: [lon1, lat1], to: [lon2, lat2] };
}

export function parseOsrm(raw: unknown, profile: Route['profile']): Route | undefined {
  const res = Osrm.parse(raw);
  const route = res.routes?.[0];
  if (res.code !== 'Ok' || !route) return undefined;
  if (decodeLine(route.geometry).length < 2) throw new UpstreamError('Invalid route geometry');
  const durationS = profile === 'bike' ? route.distance / BIKE_SPEED_MS : route.duration;
  return { profile, distanceM: route.distance, durationS, line: route.geometry };
}

function createRouting(): OnDemandConnector {
  const cache = new Map<string, Route | null>();
  let queue: Promise<unknown> = Promise.resolve();
  let lastRequestAt = 0;

  /** Runs upstream calls one at a time, at least a second apart. */
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
    id: 'osrm.routes',
    name: 'Routing – OSRM (FOSSGIS)',
    licence: 'ODbL 1.0 (OpenStreetMap data); FOSSGIS usage policy',
    attribution: 'OSRM, FOSSGIS e.V., © OpenStreetMap contributors',
    homepage: 'https://routing.openstreetmap.de/about.html',
    mode: 'on-demand',
    allowedHosts: [HOST],
    channels: [],
    async serve(ctx, path) {
      const req = parseRoutePath(path);
      if (!req) return undefined;
      let route = cache.get(path);
      if (route === undefined) {
        const coords = `${req.from.join(',')};${req.to.join(',')}`;
        const raw = await throttled(() =>
          ctx.http.getJson(
            `https://${HOST}/${PROFILES[req.profile]}/route/v1/driving/${coords}?overview=full&geometries=polyline&steps=false`,
            { timeoutMs: 20_000 },
          ),
        );
        route = parseOsrm(raw, req.profile) ?? null;
        cache.set(path, route);
        if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
      }
      return route
        ? { type: 'application/json', body: JSON.stringify(route), maxAgeSec: 24 * 3600 }
        : undefined;
    },
  };
}

export const osrmRoutes = createRouting();
