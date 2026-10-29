import {
  ENTITY_SERIES,
  isDeparture,
  isEntity,
  isMetric,
  TRACK_CHANNELS,
  type Series,
  type Track,
} from '@gbg-osint/shared';
import type { ConnectorCache } from './cache';
import { lateCount } from './delays';
import type { ChannelStore } from './store';

export const HISTORY_WINDOW_MS = 24 * 3600_000;
const SERIES_STEP_MS = 5 * 60_000;
/** A track gets a new point after this much movement, or after the gap below while still. */
const TRACK_MIN_MOVE_M = 50;
const TRACK_MAX_GAP_MS = 10 * 60_000;
const MAX_SERIES = 3000;
const MAX_TRACKS = 4000;
const MAX_TRACK_POINTS = 1500;

/** Event channels whose size is kept, for "unusual number of incidents" flags. */
const COUNT_CHANNELS = new Set([
  'events.police',
  'events.road',
  'events.city-traffic',
  'events.rail',
  'events.crisis',
  'events.weather-warnings',
]);
const TRANSIT_BOARDS = ['transit.departures', 'transit.trains'];
export const TRANSIT_LATE_KEY = 'derived/transit-late';

interface SeriesState {
  unit: string;
  points: [number, number][];
}
type TrackPoint = [number, number, number, number];

export interface HistorySnapshot {
  series: Record<string, SeriesState>;
  tracks: Record<string, TrackPoint[]>;
}

const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;

function metresBetween(a: TrackPoint, lon: number, lat: number): number {
  const dx = (lon - a[1]) * 111_320 * Math.cos((lat * Math.PI) / 180);
  const dy = (lat - a[2]) * 110_540;
  return Math.hypot(dx, dy);
}

/** Last 24 hours of selected values and movements, sampled from the live store. */
export class History {
  private readonly series = new Map<string, SeriesState>();
  private readonly tracks = new Map<string, TrackPoint[]>();
  private startedAt: number | undefined;

  sample(store: ChannelStore, now: number): void {
    this.startedAt ??= now;
    for (const { name, kind } of store.list()) {
      const items = store.snapshot(name);
      if (kind === 'metrics') {
        for (const m of items)
          if (isMetric(m)) this.record(`${name}/${m.id}`, m.unit, m.value, now);
      } else if (kind === 'entities') {
        const props = ENTITY_SERIES[name];
        const tracked = TRACK_CHANNELS.has(name);
        if (!props && !tracked) continue;
        for (const e of items) {
          if (!isEntity(e)) continue;
          for (const [prop, unit] of Object.entries(props ?? {})) {
            const v = e.props?.[prop];
            if (typeof v === 'number' && Number.isFinite(v)) {
              this.record(`${name}/${e.id}/${prop}`, unit, v, now);
            }
          }
          if (tracked && !e.id.startsWith('anon-')) {
            this.move(`${name}/${e.id}`, e.lon, e.lat, e.alt ?? 0, now);
          }
        }
      } else if (kind === 'events' && COUNT_CHANNELS.has(name)) {
        this.record(`count/${name}`, 'events', items.length, now);
      }
    }
    const boards = TRANSIT_BOARDS.filter((c) => store.has(c))
      .flatMap((c) => store.snapshot(c))
      .filter(isDeparture);
    if (boards.length > 0) {
      this.record(TRANSIT_LATE_KEY, 'departures', lateCount(boards, now), now);
    }
    this.prune(now);
  }

  /** Hours covered by the oldest kept sample. */
  hours(now: number): number {
    let oldest = now;
    for (const s of this.series.values()) oldest = Math.min(oldest, s.points[0]?.[0] ?? now);
    return round((now - oldest) / 3600_000, 1);
  }

  seriesOf(key: string): Series | undefined {
    const s = this.series.get(key);
    return s && { key, unit: s.unit, points: s.points.map((p) => [p[0], p[1]]) };
  }

  /** All series under a prefix such as `env.weather/` or `env.harbour/viva-101/`. */
  seriesUnder(prefix: string): Series[] {
    return [...this.series.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort()
      .map((k) => this.seriesOf(k)!);
  }

  trackOf(key: string): Track | undefined {
    const points = this.tracks.get(key);
    return points && { key, points: points.map((p) => [p[0], p[1], p[2], p[3] ?? 0]) };
  }

  snapshot(): HistorySnapshot {
    return {
      series: Object.fromEntries(this.series),
      tracks: Object.fromEntries(this.tracks),
    };
  }

  restore(snapshot: HistorySnapshot, now: number): void {
    for (const [key, s] of Object.entries(snapshot.series ?? {})) {
      if (typeof s?.unit === 'string' && Array.isArray(s.points)) this.series.set(key, s);
    }
    for (const [key, points] of Object.entries(snapshot.tracks ?? {})) {
      if (Array.isArray(points)) this.tracks.set(key, points);
    }
    this.prune(now);
  }

  private record(key: string, unit: string, value: number, now: number): void {
    let s = this.series.get(key);
    if (!s) {
      if (this.series.size >= MAX_SERIES) return;
      s = { unit, points: [] };
      this.series.set(key, s);
    }
    const last = s.points.at(-1);
    if (last && now - last[0] < SERIES_STEP_MS) return;
    s.unit = unit;
    s.points.push([now, round(value, 3)]);
  }

  private move(key: string, lon: number, lat: number, alt: number, now: number): void {
    let points = this.tracks.get(key);
    if (!points) {
      if (this.tracks.size >= MAX_TRACKS) return;
      points = [];
      this.tracks.set(key, points);
    }
    const last = points.at(-1);
    if (
      last &&
      metresBetween(last, lon, lat) < TRACK_MIN_MOVE_M &&
      now - last[0] < TRACK_MAX_GAP_MS
    ) {
      return;
    }
    points.push([now, round(lon, 5), round(lat, 5), Math.round(alt)]);
    if (points.length > MAX_TRACK_POINTS) points.shift();
  }

  private prune(now: number): void {
    const cutoff = now - HISTORY_WINDOW_MS;
    for (const [key, s] of this.series) {
      const keep = s.points.findIndex((p) => p[0] >= cutoff);
      if (keep === -1) this.series.delete(key);
      else if (keep > 0) s.points.splice(0, keep);
    }
    for (const [key, points] of this.tracks) {
      const keep = points.findIndex((p) => p[0] >= cutoff);
      if (keep === -1) this.tracks.delete(key);
      else if (keep > 0) points.splice(0, keep);
    }
  }
}

const SAMPLE_MS = 60_000;
/** Most sources have answered by then, so a restart doesn't record empty channels. */
const FIRST_SAMPLE_MS = 2 * 60_000;
const SAVE_MS = 10 * 60_000;
const CACHE_KEY = 'state';

/** Samples the store every minute and keeps the history on disk across restarts. */
export async function startHistory(
  store: ChannelStore,
  cache: ConnectorCache,
  log: { warn(obj: unknown, msg: string): void },
): Promise<{ history: History; stop(): Promise<void> }> {
  const history = new History();
  const saved = await cache.get<HistorySnapshot>(CACHE_KEY, HISTORY_WINDOW_MS);
  if (saved) history.restore(saved.value, Date.now());
  const save = () =>
    cache.set(CACHE_KEY, history.snapshot()).catch((err: unknown) => {
      log.warn({ err }, 'Could not save history');
    });
  let sampler: NodeJS.Timeout | undefined;
  const first = setTimeout(() => {
    history.sample(store, Date.now());
    sampler = setInterval(() => history.sample(store, Date.now()), SAMPLE_MS).unref();
  }, FIRST_SAMPLE_MS).unref();
  const saver = setInterval(() => void save(), SAVE_MS).unref();
  return {
    history,
    async stop() {
      clearTimeout(first);
      clearInterval(sampler);
      clearInterval(saver);
      await save();
    },
  };
}
