import { encodeLine, GOTHENBURG, type Entity, type Feature, type LonLat } from '@gbg-osint/shared';
import type { PollConnector } from '../core/connector';
import { distanceM, simplifyLine, truncate } from './util';
import { entryLines, readEntry, zipEntries, type ZipEntry } from './zip';

const HOST = 'opendata.samtrafiken.se';
const ROUTES_CHANNEL = 'transit.routes';
const STOPS_CHANNEL = 'transit.stops';
/** The free Trafiklab tier allows few downloads a month; the feed changes about daily. */
const DOWNLOAD_EVERY_MS = 7 * 24 * 3600_000;
const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const SIMPLIFY_M = 4;
/** Routes are kept within this margin around the city, so regional lines don't run off far. */
const MARGIN_DEG = 0.15;
/** Some shapes jump straight across where the source has no points; split there. */
const MAX_GAP_M = 5_000;
const CACHE_KEY = 'network';
const toPoint = ([lon, lat]: LonLat) => ({ lon, lat });

export type TransitMode = 'tram' | 'bus' | 'ferry' | 'train';
const MODE_LABEL: Record<TransitMode, string> = {
  tram: 'Tram',
  bus: 'Bus',
  ferry: 'Ferry',
  train: 'Train',
};

/** GTFS route types, basic and extended; demand-responsive services (15xx) are left out. */
export function modeOf(routeType: number): TransitMode | undefined {
  if (routeType === 0 || (routeType >= 900 && routeType < 1000)) return 'tram';
  if (
    routeType === 3 ||
    (routeType >= 200 && routeType < 300) ||
    (routeType >= 700 && routeType < 800)
  )
    return 'bus';
  if (
    routeType === 4 ||
    (routeType >= 1000 && routeType < 1100) ||
    (routeType >= 1200 && routeType < 1300)
  )
    return 'ferry';
  if (routeType === 2 || (routeType >= 100 && routeType < 200)) return 'train';
  return undefined;
}

/** One CSV row; GTFS fields are only quoted when they contain commas or quotes. */
export function splitCsv(line: string): string[] {
  if (!line.includes('"')) return line.split(',');
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(field);
      field = '';
    } else field += c;
  }
  out.push(field);
  return out;
}

/** Rows of a small CSV file as objects keyed by header. */
export function csvRows(text: string): Record<string, string>[] {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.length > 0);
  const header = splitCsv(lines[0] ?? '');
  return lines.slice(1).map((line) => {
    const cells = splitCsv(line);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
}

/** Streams a large CSV entry, calling `onRow` with the wanted columns only. */
async function streamCsv(
  zip: Buffer,
  entry: ZipEntry,
  columns: readonly string[],
  onRow: (cells: string[]) => void,
): Promise<void> {
  let index: number[] | undefined;
  for await (const raw of entryLines(zip, entry)) {
    const line = index ? raw : raw.replace(/^\uFEFF/, '');
    if (!line) continue;
    const cells = splitCsv(line);
    if (!index) {
      index = columns.map((c) => cells.indexOf(c));
      if (index.some((i) => i < 0)) throw new Error(`${entry.name} lacks ${columns.join(', ')}`);
      continue;
    }
    onRow(index.map((i) => cells[i] ?? ''));
  }
}

export interface TransitNetwork {
  routes: Feature[];
  stops: Entity[];
}

const near = (lon: number, lat: number, margin: number) => {
  const { west, south, east, north } = GOTHENBURG.bbox;
  return (
    lon >= west - margin && lon <= east + margin && lat >= south - margin && lat <= north + margin
  );
};

/** The longest stretch of a shape inside the area around the city, without data gaps. */
export function clip(points: readonly LonLat[]): LonLat[] {
  let best: LonLat[] = [];
  let run: LonLat[] = [];
  for (const p of points) {
    const prev = run.at(-1);
    const gap = prev !== undefined && distanceM(toPoint(prev), toPoint(p)) > MAX_GAP_M;
    if (!near(p[0], p[1], MARGIN_DEG) || gap) {
      if (run.length > best.length) best = run;
      run = [];
    }
    if (near(p[0], p[1], MARGIN_DEG)) run.push(p);
  }
  return run.length > best.length ? run : best;
}

/** Route lines and stations for the Gothenburg area from a GTFS zip. */
export async function parseGtfs(zip: Buffer, ts: string): Promise<TransitNetwork> {
  const entries = zipEntries(zip);
  const entry = (name: string) => {
    const e = entries.get(name);
    if (!e) throw new Error(`GTFS feed lacks ${name}`);
    return e;
  };

  const agencies = new Map(
    csvRows(readEntry(zip, entry('agency.txt'))).map((a) => [
      a.agency_id ?? '',
      a.agency_name ?? '',
    ]),
  );
  const routes = new Map<string, { line: string; mode: TransitMode; operator: string }>();
  for (const r of csvRows(readEntry(zip, entry('routes.txt')))) {
    const mode = modeOf(Number(r.route_type));
    const line = (r.route_short_name || r.route_long_name || '').trim();
    if (!mode || !line || !r.route_id) continue;
    routes.set(r.route_id, { line, mode, operator: agencies.get(r.agency_id ?? '') ?? '' });
  }

  // The most common shape per route and direction stands for that direction.
  const tripRoute = new Map<string, string>();
  const shapeCounts = new Map<string, Map<string, { count: number; trip: string }>>();
  await streamCsv(
    zip,
    entry('trips.txt'),
    ['route_id', 'trip_id', 'direction_id', 'shape_id'],
    ([route, trip, dir, shape]) => {
      if (!routes.has(route!)) return;
      tripRoute.set(trip!, route!);
      if (!shape) return;
      const key = `${route}|${dir}`;
      let counts = shapeCounts.get(key);
      if (!counts) shapeCounts.set(key, (counts = new Map()));
      const c = counts.get(shape) ?? { count: 0, trip: trip! };
      c.count++;
      counts.set(shape, c);
    },
  );
  const chosen = new Map<string, { route: string; dir: string; trip: string }>();
  for (const [key, counts] of shapeCounts) {
    const [route, dir] = key.split('|') as [string, string];
    const [shape, best] = [...counts].sort((a, b) => b[1].count - a[1].count)[0]!;
    if (!chosen.has(shape)) chosen.set(shape, { route, dir, trip: best.trip });
  }

  const stops = new Map<
    string,
    { name: string; lon: number; lat: number; parent: string; type: string }
  >();
  for (const s of csvRows(readEntry(zip, entry('stops.txt')))) {
    if (!s.stop_id) continue;
    stops.set(s.stop_id, {
      name: (s.stop_name ?? '').trim(),
      lon: Number(s.stop_lon),
      lat: Number(s.stop_lat),
      parent: s.parent_station ?? '',
      type: s.location_type ?? '0',
    });
  }
  const stationOf = (stopId: string) => {
    const s = stops.get(stopId);
    return s?.parent && stops.has(s.parent) ? s.parent : stopId;
  };

  // Lines per station, and where each chosen direction ends (its last stop).
  const linesAt = new Map<string, Set<string>>();
  const representative = new Map([...chosen.values()].map((c) => [c.trip, { seq: -1, stop: '' }]));
  await streamCsv(
    zip,
    entry('stop_times.txt'),
    ['trip_id', 'stop_id', 'stop_sequence'],
    ([trip, stop, seq]) => {
      const route = tripRoute.get(trip!);
      if (!route) return;
      const rep = representative.get(trip!);
      if (rep && Number(seq) > rep.seq) {
        rep.seq = Number(seq);
        rep.stop = stop!;
      }
      const station = stationOf(stop!);
      const s = stops.get(station);
      if (!s || !near(s.lon, s.lat, 0)) return;
      let set = linesAt.get(station);
      if (!set) linesAt.set(station, (set = new Set()));
      set.add(route);
    },
  );

  const points = new Map<string, [number, number, number][]>();
  await streamCsv(
    zip,
    entry('shapes.txt'),
    ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'],
    ([shape, lat, lon, seq]) => {
      if (!chosen.has(shape!)) return;
      let list = points.get(shape!);
      if (!list) points.set(shape!, (list = []));
      list.push([Number(seq), Number(lon), Number(lat)]);
    },
  );

  const routeFeatures: Feature[] = [];
  for (const [shape, c] of chosen) {
    const raw = points.get(shape);
    const r = routes.get(c.route);
    if (!raw || !r) continue;
    const ordered = raw.sort((a, b) => a[0] - b[0]).map(([, lon, lat]): LonLat => [lon, lat]);
    const line = simplifyLine(clip(ordered), SIMPLIFY_M);
    if (line.length < 2 || !line.some(([lon, lat]) => near(lon, lat, 0))) continue;
    const terminus = stops.get(stationOf(representative.get(c.trip)?.stop ?? ''))?.name;
    routeFeatures.push({
      id: `${c.route}-${c.dir || '0'}`,
      source: 'trafiklab',
      kind: 'transit-route',
      line: encodeLine(line),
      label: truncate(`${MODE_LABEL[r.mode]} ${r.line}${terminus ? ` → ${terminus}` : ''}`, 200),
      ts,
      props: {
        line: r.line,
        mode: r.mode,
        ...(terminus && { towards: terminus }),
        ...(r.operator && { operator: r.operator }),
      },
    });
  }

  const stopEntities: Entity[] = [];
  for (const [id, lines] of linesAt) {
    const s = stops.get(id)!;
    const byMode = new Map<TransitMode, Set<string>>();
    for (const routeId of lines) {
      const r = routes.get(routeId)!;
      if (!byMode.has(r.mode)) byMode.set(r.mode, new Set());
      byMode.get(r.mode)!.add(r.line);
    }
    const order: TransitMode[] = ['train', 'tram', 'ferry', 'bus'];
    const modes = order.filter((m) => byMode.has(m));
    const sortLines = (a: string, b: string) => a.localeCompare(b, 'sv', { numeric: true });
    stopEntities.push({
      id,
      source: 'trafiklab',
      kind: 'poi',
      lon: s.lon,
      lat: s.lat,
      label: truncate(s.name || id, 200),
      ts,
      props: {
        lines: truncate(
          modes
            .map((m) => `${MODE_LABEL[m]} ${[...byMode.get(m)!].sort(sortLines).join(', ')}`)
            .join(' · '),
          500,
        ),
        modes: modes.join(','),
      },
    });
  }
  return { routes: routeFeatures, stops: stopEntities };
}

export const trafiklabGtfs: PollConnector = {
  id: 'trafiklab.gtfs',
  name: 'Trafiklab – GTFS Regional (Västtrafik routes and stops)',
  licence: 'CC0 1.0',
  attribution: 'Samtrafiken / Trafiklab',
  homepage: 'https://www.trafiklab.se/api/gtfs-datasets/gtfs-regional/',
  mode: 'poll',
  intervalMs: 6 * 3600_000,
  allowedHosts: [HOST],
  requiredEnv: ['TRAFIKLAB_GTFS_REGIONAL_KEY'],
  channels: [
    { name: ROUTES_CHANNEL, kind: 'features' },
    { name: STOPS_CHANNEL, kind: 'entities' },
  ],
  async poll(ctx) {
    let network = (await ctx.cache.get<TransitNetwork>(CACHE_KEY, DOWNLOAD_EVERY_MS))?.value;
    if (!network) {
      try {
        const zip = await ctx.http.getBytes(
          `https://${HOST}/gtfs/vt/vt.zip?key=${encodeURIComponent(ctx.env.TRAFIKLAB_GTFS_REGIONAL_KEY ?? '')}`,
          { maxBytes: MAX_ZIP_BYTES, timeoutMs: 180_000 },
        );
        network = await parseGtfs(zip, new Date().toISOString());
        await ctx.cache.set(CACHE_KEY, network);
      } catch (err) {
        // Keep showing last week's network rather than nothing.
        network = (await ctx.cache.get<TransitNetwork>(CACHE_KEY, Infinity))?.value;
        if (!network) throw err;
        ctx.log.warn({ err }, 'GTFS download failed; using the cached network');
      }
    }
    ctx.publish.replace(ROUTES_CHANNEL, network.routes);
    ctx.publish.replace(STOPS_CHANNEL, network.stops);
  },
};
