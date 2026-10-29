import { GOTHENBURG, type Entity, type Metric } from '@gbg-osint/shared';
import { z } from 'zod';
import type { ConnectorContext, PollConnector } from '../core/connector';
import { stockholmTimeToIso, truncate } from './util';

// --- Sjöfartsverket ViVa: wind, water level, currents and visibility around the harbour ---

const VIVA_HOST = 'services.viva.sjofartsverket.se';
const VIVA_API = `https://${VIVA_HOST}/output/vivaoutputservice.svc/vivastation/`;
const HARBOUR = 'env.harbour';
/** The harbour, the inlet out to Vinga and the river up to Agnesberg. */
const AREA = { west: 11.45, east: 12.15, south: 57.55, north: 57.95 };
const STATIONS_TTL_MS = 24 * 3600_000;
const FETCH_CONCURRENCY = 4;

const StationList = z.object({
  GetStationsResult: z.object({
    Stations: z.array(
      z.object({
        ID: z.number().int().positive(),
        Name: z.string(),
        Lat: z.number(),
        Lon: z.number(),
      }),
    ),
  }),
});
const Sample = z.object({
  Name: z.string(),
  Value: z.string(),
  Heading: z.number().nullish(),
  Unit: z.string().nullish(),
  Type: z.string(),
  Updated: z.string(),
  Quality: z.string().nullish(),
});
const StationData = z.object({
  GetSingleStationResult: z.object({ Samples: z.array(z.unknown()).nullish() }),
});

export interface VivaStation {
  id: number;
  name: string;
  lon: number;
  lat: number;
}

export function parseVivaStations(raw: unknown): VivaStation[] {
  return StationList.parse(raw)
    .GetStationsResult.Stations.filter(
      (s) => s.Lon >= AREA.west && s.Lon <= AREA.east && s.Lat >= AREA.south && s.Lat <= AREA.north,
    )
    .map((s) => ({ id: s.ID, name: s.Name, lon: s.Lon, lat: s.Lat }));
}

/** The number at the end of a ViVa value such as `SV 10.6`, `34` or `>20000`. */
function valueOf(text: string): number | undefined {
  const m = /(-?\d+(?:[.,]\d+)?)\s*$/.exec(text.trim());
  return m ? Number(m[1]!.replace(',', '.')) : undefined;
}

/** `Torshamnen (GBG Hamn)` → `Torshamnen`; the operator stays in the props. */
function splitName(name: string): { label: string; operator?: string } {
  const m = /^(.*?)\s*\(([^)]+)\)$/.exec(name.trim());
  return m ? { label: m[1]!, operator: m[2]! } : { label: name.trim() };
}

export function parseVivaStation(raw: unknown, station: VivaStation): Entity | undefined {
  const samples = (StationData.parse(raw).GetSingleStationResult.Samples ?? [])
    .map((s) => Sample.safeParse(s))
    .flatMap((r) => (r.success && (r.data.Quality ?? 'Ok') === 'Ok' ? [r.data] : []));
  const props: Record<string, unknown> = {};
  let latest = '';
  const take = (key: string, value: unknown) => {
    if (value !== undefined && props[key] === undefined) props[key] = value;
  };
  // Surface readings first, so they win over the same reading at depth.
  const ordered = [...samples].sort(
    (a, b) => Number(/Botten|\d+m/.test(a.Name)) - Number(/Botten|\d+m/.test(b.Name)),
  );
  for (const s of ordered) {
    const value = valueOf(s.Value);
    const iso = stockholmTimeToIso(s.Updated);
    if (iso && iso > latest) latest = iso;
    switch (s.Type) {
      case 'wind':
        if (/^Medel/i.test(s.Name)) {
          take('windMs', value);
          if (s.Heading != null) take('windFromDeg', s.Heading);
        } else if (/^By/i.test(s.Name)) take('gustMs', value);
        break;
      case 'level':
        take('waterLevelCm', value);
        break;
      case 'watertemp':
        if (!/Botten/.test(s.Name)) take('waterTempC', value);
        break;
      case 'airtemp':
        take('airTempC', value);
        break;
      case 'pressure':
        take('pressureHpa', value);
        break;
      case 'sight':
        take('visibility', truncate(`${s.Value.trim()} ${s.Unit ?? ''}`.trim(), 20));
        break;
      case 'stream':
        if (!/Botten/.test(s.Name)) {
          take('currentKn', value);
          if (s.Heading != null) take('currentTowardsDeg', s.Heading);
        }
        break;
    }
  }
  if (!latest || Object.keys(props).length === 0) return undefined;
  const { label, operator } = splitName(station.name);
  return {
    id: `viva-${station.id}`,
    source: 'viva',
    kind: 'sensor',
    lon: station.lon,
    lat: station.lat,
    label: truncate(label, 80),
    ts: latest,
    props: { ...props, ...(operator && { operator: truncate(operator, 40) }) },
  };
}

let stations: { at: number; list: VivaStation[] } | undefined;

async function vivaStations(ctx: ConnectorContext): Promise<VivaStation[]> {
  if (stations && Date.now() - stations.at < STATIONS_TTL_MS) return stations.list;
  const cached = await ctx.cache.get<unknown>('stations', STATIONS_TTL_MS);
  const raw = cached?.value ?? (await ctx.http.getJson(VIVA_API, { timeoutMs: 20_000 }));
  const list = parseVivaStations(raw);
  if (!cached) await ctx.cache.set('stations', raw);
  stations = { at: cached?.savedAt ?? Date.now(), list };
  return list;
}

export const vivaHarbour: PollConnector = {
  id: 'viva.stations',
  name: 'Sjöfartsverket ViVa – harbour stations',
  licence: 'Sjöfartsverket open data',
  attribution: 'Sjöfartsverket (ViVa), Göteborgs Hamn, Göteborgs Stad, SMHI',
  homepage: 'https://viva.sjofartsverket.se/',
  mode: 'poll',
  intervalMs: 3 * 60_000,
  allowedHosts: [VIVA_HOST],
  channels: [{ name: HARBOUR, kind: 'entities' }],
  async poll(ctx) {
    const queue = [...(await vivaStations(ctx))];
    const entities: Entity[] = [];
    let failures = 0;
    const worker = async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        try {
          const raw = await ctx.http.getJson(`${VIVA_API}${s.id}`, { timeoutMs: 20_000 });
          const entity = parseVivaStation(raw, s);
          if (entity) entities.push(entity);
        } catch (err) {
          failures++;
          ctx.log.warn({ err, station: s.id }, 'ViVa station failed');
        }
      }
    };
    await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));
    if (entities.length === 0 && failures > 0) throw new Error('All ViVa stations failed');
    ctx.publish.replace(
      HARBOUR,
      entities.sort((a, b) => a.id.localeCompare(b.id)),
    );
  },
};

// --- MET Norway nowcast: rain in the next two hours, from radar ---

const MET_HOST = 'api.met.no';
const NOWCAST = 'env.nowcast';
/** Below this rate (mm/h) it is effectively dry. */
const RAIN_MM_H = 0.1;

const Nowcast = z.object({
  properties: z.object({
    meta: z.object({ radar_coverage: z.string().optional() }).optional(),
    timeseries: z.array(
      z.object({
        time: z.string(),
        data: z.object({
          instant: z.object({ details: z.object({ precipitation_rate: z.number().optional() }) }),
        }),
      }),
    ),
  }),
});

/** Rain now, when it starts or stops, and the heaviest rate expected, for central Gothenburg. */
export function nowcastMetrics(raw: unknown, now: number): Metric[] {
  const { meta, timeseries } = Nowcast.parse(raw).properties;
  if (meta?.radar_coverage && meta.radar_coverage !== 'ok') return [];
  const steps = timeseries
    .map((t) => ({ at: Date.parse(t.time), rate: t.data.instant.details.precipitation_rate }))
    .filter((s): s is { at: number; rate: number } => Number.isFinite(s.at) && s.rate !== undefined)
    .filter((s) => s.at >= now - 5 * 60_000)
    .sort((a, b) => a.at - b.at);
  const first = steps[0];
  const last = steps.at(-1);
  if (!first || !last) return [];
  const base = { source: 'metno' } as const;
  const ts = new Date(first.at).toISOString();
  const minutesUntil = (at: number) => Math.max(0, Math.round((at - now) / 60_000 / 5) * 5);
  const raining = first.rate >= RAIN_MM_H;
  const change = steps.find((s) => s.rate >= RAIN_MM_H !== raining);
  const metrics: Metric[] = [
    { ...base, id: 'rain-now', name: 'Rain now', unit: 'mm/h', value: first.rate, ts },
  ];
  if (change) {
    metrics.push({
      ...base,
      id: 'rain-change',
      name: raining ? 'Dry in' : 'Rain in',
      unit: 'min',
      value: minutesUntil(change.at),
      ts,
    });
  } else {
    metrics.push({
      ...base,
      id: 'rain-change',
      name: raining ? 'Rain for at least' : 'Dry for at least',
      unit: 'min',
      value: minutesUntil(last.at),
      ts,
    });
  }
  metrics.push({
    ...base,
    id: 'rain-max',
    name: 'Max next 2 h',
    unit: 'mm/h',
    value: Math.max(...steps.map((s) => s.rate)),
    ts,
  });
  return metrics;
}

export const metNowcast: PollConnector = {
  id: 'metno.nowcast',
  name: 'MET Norway – precipitation nowcast',
  licence: 'CC BY 4.0 (MET Norway)',
  attribution: 'MET Norway',
  homepage: 'https://api.met.no/weatherapi/nowcast/2.0/documentation',
  mode: 'poll',
  intervalMs: 5 * 60_000,
  allowedHosts: [MET_HOST],
  channels: [{ name: NOWCAST, kind: 'metrics' }],
  async poll(ctx) {
    const { lat, lon } = GOTHENBURG.center;
    const raw = await ctx.http.getJson(
      `https://${MET_HOST}/weatherapi/nowcast/2.0/complete?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`,
    );
    ctx.publish.replace(NOWCAST, nowcastMetrics(raw, Date.now()));
  },
};
