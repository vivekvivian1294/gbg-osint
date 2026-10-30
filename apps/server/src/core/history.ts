import {
  ENTITY_SERIES,
  HISTORY_DAYS,
  isDeparture,
  isEntity,
  isMetric,
  REPLAY_ENTITY_CHANNELS,
  TRACK_CHANNELS,
  type ChannelItem,
  type ChannelKind,
  type Entity,
  type HistoryRange,
  type Metric,
  type Series,
  type Track,
} from '@gbg-osint/shared';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { ConnectorCache } from './cache';
import { lateCount } from './delays';
import type { ChannelStore } from './store';

/** Default span for sparklines, trails and the anomaly flags. */
export const HISTORY_WINDOW_MS = 24 * 3600_000;
export const HISTORY_KEEP_MS = HISTORY_DAYS * 24 * 3600_000;
const SERIES_STEP_MS = 5 * 60_000;
/** A track gets a new point after this much movement, or after the gap below while still. */
const TRACK_MIN_MOVE_M = 50;
const TRACK_MAX_GAP_MS = 10 * 60_000;
/** A changed item is stored again at most this often. */
const VERSION_STEP_MS = 15 * 60_000;
/** While an item stays, how long it has been seen is written at least this often. */
const CHECKPOINT_MS = 10 * 60_000;
/** Samples are a minute apart; an item missing for longer than this left and came back. */
const PRESENCE_GAP_MS = 3 * 60_000;
/** How far back a reading or position still counts at a replayed moment (a still ship reports every 10 min). */
const REPLAY_TOLERANCE_MS = 12 * 60_000;
const PRUNE_EVERY_MS = 3600_000;
const MAX_SERIES = 5000;
const MAX_TRACKS = 20_000;
const MAX_SERIES_POINTS = 1000;
const MAX_TRACK_POINTS = 2000;

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

type TrackPoint = [number, number, number, number];

/** The pre-SQLite history file, imported once. */
export interface HistorySnapshot {
  series: Record<string, { unit: string; points: [number, number][] }>;
  tracks: Record<string, TrackPoint[]>;
}

interface MetricMeta {
  name: string;
  source: string;
  lon?: number;
  lat?: number;
}

interface OpenPresence {
  since: number;
  until: number;
  written: number;
  hash: string;
  versionHash: string;
  versionAt: number;
}

type Row = Record<string, unknown>;

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS series (
    id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, unit TEXT NOT NULL, meta TEXT);
  CREATE TABLE IF NOT EXISTS samples (
    series INTEGER NOT NULL, t INTEGER NOT NULL, v REAL NOT NULL,
    PRIMARY KEY (series, t)) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS samples_t ON samples (t);
  CREATE TABLE IF NOT EXISTS tracks (id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE);
  CREATE TABLE IF NOT EXISTS track_points (
    track INTEGER NOT NULL, t INTEGER NOT NULL,
    lon REAL NOT NULL, lat REAL NOT NULL, alt REAL NOT NULL, heading REAL,
    PRIMARY KEY (track, t)) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS track_points_t ON track_points (t);
  CREATE TABLE IF NOT EXISTS presence (
    channel TEXT NOT NULL, id TEXT NOT NULL, since INTEGER NOT NULL, until INTEGER NOT NULL,
    PRIMARY KEY (channel, id, since)) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS presence_window ON presence (channel, since, until);
  CREATE TABLE IF NOT EXISTS versions (
    channel TEXT NOT NULL, id TEXT NOT NULL, t INTEGER NOT NULL, json TEXT NOT NULL,
    PRIMARY KEY (channel, id, t)) WITHOUT ROWID;
`;

const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;
const num = (v: unknown) => Number(v);
/** Keys from `prefix` up to (not including) the next prefix, for index range scans. */
const prefixEnd = (prefix: string) => `${prefix}\uffff`;

function metresBetween(a: TrackPoint, lon: number, lat: number): number {
  const dx = (lon - a[1]) * 111_320 * Math.cos((lat * Math.PI) / 180);
  const dy = (lat - a[2]) * 110_540;
  return Math.hypot(dx, dy);
}

function bearingDeg(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dx = (lon2 - lon1) * Math.cos((lat1 * Math.PI) / 180);
  const deg = (Math.atan2(dx, lat2 - lat1) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** What is stored per sighting of a moving object; its position comes from the track. */
function storedForm(channel: string, item: ChannelItem): ChannelItem {
  if (!TRACK_CHANNELS.has(channel) || !isEntity(item)) return item;
  const copy: Entity = { ...item, lon: 0, lat: 0, ts: EPOCH };
  delete copy.alt;
  delete copy.heading;
  delete copy.speed;
  delete copy.via;
  return copy;
}

const EPOCH = new Date(0).toISOString();

function statements(db: DatabaseSync) {
  const p = (s: string) => db.prepare(s);
  return {
    addSeries: p('INSERT INTO series (key, unit, meta) VALUES (?, ?, ?)'),
    setSeries: p('UPDATE series SET unit = ?, meta = ? WHERE id = ?'),
    seriesUnit: p('SELECT unit FROM series WHERE id = ?'),
    addSample: p('INSERT OR REPLACE INTO samples (series, t, v) VALUES (?, ?, ?)'),
    addTrack: p('INSERT INTO tracks (key) VALUES (?)'),
    addPoint: p(
      'INSERT OR REPLACE INTO track_points (track, t, lon, lat, alt, heading) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    pointBefore: p(
      `SELECT t, lon, lat, alt, heading FROM track_points
       WHERE track = ? AND t <= ? AND t >= ? ORDER BY t DESC LIMIT 1`,
    ),
    pointAfter: p(
      'SELECT t, lon, lat, alt FROM track_points WHERE track = ? AND t > ? ORDER BY t LIMIT 1',
    ),
    openPresence: p(
      'INSERT OR REPLACE INTO presence (channel, id, since, until) VALUES (?, ?, ?, ?)',
    ),
    extendPresence: p('UPDATE presence SET until = ? WHERE channel = ? AND id = ? AND since = ?'),
    addVersion: p('INSERT OR REPLACE INTO versions (channel, id, t, json) VALUES (?, ?, ?, ?)'),
  };
}

/**
 * Seven days of readings, movements and events in a SQLite file: 5-minute series, tracks of
 * ships, aircraft and trains, and when each replayable item was present and what it said.
 */
export class History {
  private readonly db: DatabaseSync;
  private readonly seriesIds = new Map<string, { id: number; lastT: number }>();
  private readonly trackIds = new Map<string, { id: number; last?: TrackPoint }>();
  private readonly open = new Map<string, OpenPresence>();
  private latest = 0;
  private prunedAt = 0;
  private readonly sql: ReturnType<typeof statements>;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    this.sql = statements(this.db);
    this.loadIndexes();
  }

  sample(store: ChannelStore, now: number): void {
    this.latest = Math.max(this.latest, now);
    this.transaction(() => {
      for (const { name, kind } of store.list()) {
        const items = store.snapshot(name);
        if (kind === 'metrics') {
          for (const m of items) {
            if (!isMetric(m)) continue;
            this.record(`${name}/${m.id}`, m.unit, m.value, now, metricMeta(m));
          }
        } else if (kind === 'entities') {
          const props = ENTITY_SERIES[name];
          const tracked = TRACK_CHANNELS.has(name);
          const replayed = REPLAY_ENTITY_CHANNELS.has(name);
          if (!props && !tracked && !replayed) continue;
          const kept: ChannelItem[] = [];
          for (const e of items) {
            if (!isEntity(e) || e.id.startsWith('anon-')) continue;
            kept.push(e);
            for (const [prop, unit] of Object.entries(props ?? {})) {
              const v = e.props?.[prop];
              if (typeof v === 'number' && Number.isFinite(v)) {
                this.record(`${name}/${e.id}/${prop}`, unit, v, now);
              }
            }
            if (tracked) this.move(`${name}/${e.id}`, e, now);
          }
          if (replayed) this.observe(name, kept, now);
        } else if (kind === 'events') {
          if (COUNT_CHANNELS.has(name)) this.record(`count/${name}`, 'events', items.length, now);
          this.observe(name, items, now);
        }
      }
      const boards = TRANSIT_BOARDS.filter((c) => store.has(c))
        .flatMap((c) => store.snapshot(c))
        .filter(isDeparture);
      if (boards.length > 0) {
        this.record(TRANSIT_LATE_KEY, 'departures', lateCount(boards, now), now);
      }
    });
    if (now - this.prunedAt >= PRUNE_EVERY_MS) this.prune(now);
  }

  /** Hours covered by the oldest kept sample. */
  hours(now: number): number {
    const row = this.db.prepare('SELECT MIN(t) AS t FROM samples').get() as Row | undefined;
    const oldest = row?.t == null ? now : num(row.t);
    return round(Math.max(0, now - oldest) / 3600_000, 1);
  }

  /** Oldest and newest moments with data. */
  range(): HistoryRange {
    const row = this.db
      .prepare(
        `SELECT MIN(f) AS f, MAX(t) AS t FROM (
           SELECT MIN(t) AS f, MAX(t) AS t FROM samples
           UNION ALL SELECT MIN(t), MAX(t) FROM track_points
           UNION ALL SELECT MIN(since), MAX(until) FROM presence)`,
      )
      .get() as Row | undefined;
    const to = row?.t == null ? null : Math.max(num(row.t), this.latest);
    return { from: row?.f == null ? null : num(row.f), to };
  }

  /** One series between `from` and `to` (the last 24 hours by default), or undefined if empty. */
  seriesOf(key: string, from = this.latest - HISTORY_WINDOW_MS, to = Infinity): Series | undefined {
    const s = this.seriesIds.get(key);
    if (!s) return undefined;
    const unit = this.sql.seriesUnit.get(s.id) as Row;
    const points = this.pointsOf(s.id, from, to);
    return points.length > 0 ? { key, unit: String(unit.unit), points } : undefined;
  }

  /** All series under a prefix such as `env.weather/` or `env.harbour/viva-101/`. */
  seriesUnder(prefix: string, from = this.latest - HISTORY_WINDOW_MS, to = Infinity): Series[] {
    const rows = this.db
      .prepare('SELECT id, key, unit FROM series WHERE key >= ? AND key < ? ORDER BY key')
      .all(prefix, prefixEnd(prefix)) as Row[];
    return rows.flatMap((r) => {
      const points = this.pointsOf(num(r.id), from, to);
      return points.length > 0 ? [{ key: String(r.key), unit: String(r.unit), points }] : [];
    });
  }

  trackOf(key: string, from = this.latest - HISTORY_WINDOW_MS, to = Infinity): Track | undefined {
    const track = this.trackIds.get(key);
    if (!track) return undefined;
    const rows = this.db
      .prepare(
        'SELECT t, lon, lat, alt FROM track_points WHERE track = ? AND t >= ? AND t <= ? ORDER BY t',
      )
      .all(track.id, from, finite(to)) as Row[];
    if (rows.length === 0) return undefined;
    const every = Math.ceil(rows.length / MAX_TRACK_POINTS);
    const points = rows
      .filter((_, i) => i % every === 0 || i === rows.length - 1)
      .map((r): TrackPoint => [num(r.t), num(r.lon), num(r.lat), num(r.alt)]);
    return { key, points };
  }

  /** What the given channels held at moment `t`: events and objects present then, readings then. */
  at(
    t: number,
    channels: readonly { name: string; kind: ChannelKind }[],
  ): Map<string, ChannelItem[]> {
    const out = new Map<string, ChannelItem[]>();
    for (const { name, kind } of channels) {
      if (kind === 'metrics') out.set(name, this.metricsAt(name, t));
      else if (kind === 'events') out.set(name, this.presentAt(name, t));
      else if (kind === 'entities' && REPLAY_ENTITY_CHANNELS.has(name)) {
        const items = this.presentAt(name, t);
        out.set(name, TRACK_CHANNELS.has(name) ? this.positionsAt(name, items, t) : items);
      }
    }
    return out;
  }

  /** Imports the pre-SQLite 24-hour history (series and tracks). */
  restore(snapshot: HistorySnapshot, now: number): void {
    this.latest = Math.max(this.latest, now);
    this.transaction(() => {
      for (const [key, s] of Object.entries(snapshot.series ?? {})) {
        if (typeof s?.unit !== 'string' || !Array.isArray(s.points)) continue;
        for (const [t, v] of s.points) this.record(key, s.unit, v, t);
      }
      for (const [key, points] of Object.entries(snapshot.tracks ?? {})) {
        if (!Array.isArray(points)) continue;
        for (const [t, lon, lat, alt] of points) {
          this.move(key, { lon, lat, alt }, t);
        }
      }
    });
    this.prune(now);
  }

  /** Writes how long open items have been seen and closes the file. */
  close(): void {
    this.transaction(() => {
      for (const [key, o] of this.open) this.writeUntil(key, o);
    });
    this.db.close();
  }

  private transaction(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private loadIndexes(): void {
    this.seriesIds.clear();
    this.trackIds.clear();
    const series = this.db
      .prepare(
        'SELECT s.id, s.key, (SELECT MAX(t) FROM samples WHERE series = s.id) AS last FROM series s',
      )
      .all() as Row[];
    for (const r of series) {
      this.seriesIds.set(String(r.key), { id: num(r.id), lastT: r.last == null ? 0 : num(r.last) });
    }
    const tracks = this.db
      .prepare(
        `SELECT k.id, k.key, p.t, p.lon, p.lat, p.alt FROM tracks k
         LEFT JOIN track_points p ON p.track = k.id
           AND p.t = (SELECT MAX(t) FROM track_points WHERE track = k.id)`,
      )
      .all() as Row[];
    for (const r of tracks) {
      const last: TrackPoint | undefined =
        r.t == null ? undefined : [num(r.t), num(r.lon), num(r.lat), num(r.alt)];
      this.trackIds.set(String(r.key), { id: num(r.id), ...(last && { last }) });
    }
  }

  private record(key: string, unit: string, value: number, now: number, meta?: MetricMeta): void {
    let s = this.seriesIds.get(key);
    if (!s) {
      if (this.seriesIds.size >= MAX_SERIES) return;
      const { lastInsertRowid } = this.sql.addSeries.run(key, unit, json(meta));
      s = { id: Number(lastInsertRowid), lastT: 0 };
      this.seriesIds.set(key, s);
    }
    if (s.lastT && now - s.lastT < SERIES_STEP_MS) return;
    if (meta) this.sql.setSeries.run(unit, json(meta), s.id);
    this.sql.addSample.run(s.id, now, round(value, 3));
    s.lastT = now;
  }

  private move(
    key: string,
    e: { lon: number; lat: number; alt?: number; heading?: number },
    now: number,
  ): void {
    let track = this.trackIds.get(key);
    if (!track) {
      if (this.trackIds.size >= MAX_TRACKS) return;
      const { lastInsertRowid } = this.sql.addTrack.run(key);
      track = { id: Number(lastInsertRowid) };
      this.trackIds.set(key, track);
    }
    const last = track.last;
    if (
      last &&
      metresBetween(last, e.lon, e.lat) < TRACK_MIN_MOVE_M &&
      now - last[0] < TRACK_MAX_GAP_MS
    ) {
      return;
    }
    const point: TrackPoint = [now, round(e.lon, 5), round(e.lat, 5), Math.round(e.alt ?? 0)];
    this.sql.addPoint.run(track.id, ...point, e.heading ?? null);
    track.last = point;
  }

  /** Notes which items of a channel are present now, and stores what changed about them. */
  private observe(channel: string, items: readonly ChannelItem[], now: number): void {
    const seen = new Set<string>();
    for (const item of items) {
      const key = `${channel}\u0000${item.id}`;
      seen.add(key);
      const stored = JSON.stringify(storedForm(channel, item));
      let o = this.open.get(key);
      if (o && now - o.until > PRESENCE_GAP_MS) {
        this.writeUntil(key, o);
        this.open.delete(key);
        o = undefined;
      }
      if (!o) {
        o = { since: now, until: now, written: now, hash: stored, versionHash: '', versionAt: 0 };
        this.open.set(key, o);
        this.sql.openPresence.run(channel, item.id, now, now);
      }
      o.until = now;
      o.hash = stored;
      if (o.versionHash !== stored && now - o.versionAt >= VERSION_STEP_MS) {
        this.sql.addVersion.run(channel, item.id, now, stored);
        o.versionHash = stored;
        o.versionAt = now;
      }
      if (now - o.written >= CHECKPOINT_MS) this.writeUntil(key, o);
    }
    const prefix = `${channel}\u0000`;
    for (const [key, o] of this.open) {
      if (!key.startsWith(prefix) || seen.has(key)) continue;
      this.writeUntil(key, o);
      this.open.delete(key);
    }
  }

  private writeUntil(key: string, o: OpenPresence): void {
    const [channel, id] = key.split('\u0000') as [string, string];
    if (o.versionHash !== o.hash) {
      this.sql.addVersion.run(channel, id, o.until, o.hash);
      o.versionHash = o.hash;
      o.versionAt = o.until;
    }
    this.sql.extendPresence.run(o.until, channel, id, o.since);
    o.written = o.until;
  }

  /** Last-known `until` for an item segment, counting what is still open in memory. */
  private untilOf(channel: string, id: string, since: number, stored: number): number {
    const o = this.open.get(`${channel}\u0000${id}`);
    return o && o.since === since ? o.until : stored;
  }

  private presentAt(channel: string, t: number): ChannelItem[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.since, p.until,
           COALESCE(
             (SELECT json FROM versions v WHERE v.channel = p.channel AND v.id = p.id AND v.t <= ?
              ORDER BY v.t DESC LIMIT 1),
             (SELECT json FROM versions v WHERE v.channel = p.channel AND v.id = p.id
              ORDER BY v.t LIMIT 1)) AS json
         FROM presence p
         WHERE p.channel = ? AND p.since <= ? AND p.until >= ?`,
      )
      .all(t, channel, t, t - CHECKPOINT_MS - REPLAY_TOLERANCE_MS) as Row[];
    const items = new Map<string, ChannelItem>();
    for (const r of rows) {
      const id = String(r.id);
      const until = this.untilOf(channel, id, num(r.since), num(r.until));
      if (until < t - PRESENCE_GAP_MS || r.json == null) continue;
      items.set(id, JSON.parse(String(r.json)) as ChannelItem);
    }
    return [...items.values()];
  }

  private positionsAt(channel: string, items: ChannelItem[], t: number): ChannelItem[] {
    const out: Entity[] = [];
    for (const item of items) {
      if (!isEntity(item)) continue;
      const track = this.trackIds.get(`${channel}/${item.id}`);
      if (!track) continue;
      const a = this.sql.pointBefore.get(track.id, t, t - REPLAY_TOLERANCE_MS) as Row | undefined;
      if (!a) continue;
      const b = this.sql.pointAfter.get(track.id, t) as Row | undefined;
      let [lon, lat, alt] = [num(a.lon), num(a.lat), num(a.alt)];
      let heading = a.heading == null ? undefined : num(a.heading);
      if (b && num(b.t) - num(a.t) <= TRACK_MAX_GAP_MS + 60_000) {
        const f = (t - num(a.t)) / (num(b.t) - num(a.t));
        heading ??= bearingDeg(lon, lat, num(b.lon), num(b.lat));
        lon += (num(b.lon) - lon) * f;
        lat += (num(b.lat) - lat) * f;
        alt += (num(b.alt) - alt) * f;
      }
      out.push({
        ...item,
        lon: round(lon, 6),
        lat: round(lat, 6),
        ...(alt !== 0 && { alt: Math.round(alt) }),
        ...(heading !== undefined && { heading: round(heading, 1) }),
        ts: new Date(t).toISOString(),
      });
    }
    return out;
  }

  private metricsAt(channel: string, t: number): Metric[] {
    const prefix = `${channel}/`;
    const rows = this.db
      .prepare(
        `SELECT s.key, s.unit, s.meta, x.t, x.v FROM series s
         JOIN samples x ON x.series = s.id
           AND x.t = (SELECT MAX(t) FROM samples WHERE series = s.id AND t <= ? AND t >= ?)
         WHERE s.key >= ? AND s.key < ?`,
      )
      .all(t, t - REPLAY_TOLERANCE_MS, prefix, prefixEnd(prefix)) as Row[];
    return rows.flatMap((r) => {
      const meta = r.meta == null ? undefined : (JSON.parse(String(r.meta)) as MetricMeta);
      const id = String(r.key).slice(prefix.length);
      if (!meta || id.includes('/')) return [];
      return [
        {
          id,
          source: meta.source,
          name: meta.name,
          unit: String(r.unit),
          value: num(r.v),
          ts: new Date(num(r.t)).toISOString(),
          ...(meta.lon !== undefined && { lon: meta.lon }),
          ...(meta.lat !== undefined && { lat: meta.lat }),
        },
      ];
    });
  }

  private pointsOf(seriesId: number, from: number, to: number): [number, number][] {
    const span = Math.min(finite(to), this.latest) - from;
    const step = Math.ceil(span / MAX_SERIES_POINTS / SERIES_STEP_MS) * SERIES_STEP_MS;
    const args: SQLInputValue[] = [seriesId, from, finite(to)];
    const rows =
      step <= SERIES_STEP_MS
        ? (this.db
            .prepare('SELECT t, v FROM samples WHERE series = ? AND t >= ? AND t <= ? ORDER BY t')
            .all(...args) as Row[])
        : (
            this.db
              .prepare(
                `SELECT (t / ${step}) * ${step} AS b, AVG(v) AS v FROM samples
               WHERE series = ? AND t >= ? AND t <= ? GROUP BY b ORDER BY b`,
              )
              .all(...args) as Row[]
          ).map((r) => ({ t: r.b, v: r.v }));
    return rows.map((r) => [num(r.t), round(num(r.v), 3)]);
  }

  private prune(now: number): void {
    this.prunedAt = now;
    const cutoff = now - HISTORY_KEEP_MS;
    this.transaction(() => {
      this.db.prepare('DELETE FROM samples WHERE t < ?').run(cutoff);
      this.db.prepare('DELETE FROM track_points WHERE t < ?').run(cutoff);
      this.db.prepare('DELETE FROM presence WHERE until < ?').run(cutoff);
      // Keep the version that was current at the cutoff.
      this.db
        .prepare(
          `DELETE FROM versions AS v WHERE v.t < ? AND EXISTS (
             SELECT 1 FROM versions w WHERE w.channel = v.channel AND w.id = v.id
               AND w.t > v.t AND w.t <= ?)`,
        )
        .run(cutoff, cutoff);
      this.db
        .prepare(
          `DELETE FROM versions AS v WHERE NOT EXISTS (
             SELECT 1 FROM presence p WHERE p.channel = v.channel AND p.id = v.id)`,
        )
        .run();
      this.db.prepare('DELETE FROM series WHERE id NOT IN (SELECT series FROM samples)').run();
      this.db.prepare('DELETE FROM tracks WHERE id NOT IN (SELECT track FROM track_points)').run();
    });
    this.loadIndexes();
  }
}

function metricMeta(m: Metric): MetricMeta {
  return {
    name: m.name,
    source: m.source,
    ...(m.lon !== undefined && { lon: m.lon }),
    ...(m.lat !== undefined && { lat: m.lat }),
  };
}

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
/** SQLite has no Infinity for integers; this is far beyond any epoch-ms value. */
const finite = (v: number) => (Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER);

const SAMPLE_MS = 60_000;
/** Most sources have answered by then, so a restart doesn't record empty channels. */
const FIRST_SAMPLE_MS = 2 * 60_000;
const LEGACY_KEY = 'state';

/**
 * Samples the store every minute into `path` (a SQLite file, or memory). The 24-hour JSON history
 * of earlier versions is imported once from `legacy`.
 */
export async function startHistory(
  store: ChannelStore,
  path: string,
  legacy: ConnectorCache,
  log: { warn(obj: unknown, msg: string): void },
): Promise<{ history: History; stop(): Promise<void> }> {
  const history = new History(path);
  if (history.range().from === null) {
    const saved = await legacy.get<HistorySnapshot>(LEGACY_KEY, HISTORY_WINDOW_MS);
    if (saved) history.restore(saved.value, Date.now());
  }
  const sample = () => {
    try {
      history.sample(store, Date.now());
    } catch (err) {
      log.warn({ err }, 'Could not record history');
    }
  };
  let sampler: NodeJS.Timeout | undefined;
  const first = setTimeout(() => {
    sample();
    sampler = setInterval(sample, SAMPLE_MS).unref();
  }, FIRST_SAMPLE_MS).unref();
  return {
    history,
    async stop() {
      clearTimeout(first);
      clearInterval(sampler);
      history.close();
    },
  };
}
