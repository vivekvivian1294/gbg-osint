import {
  geometryVertices,
  isEntity,
  isEvent,
  pointInRing,
  type ChannelItem,
  type LonLat,
} from '@gbg-osint/shared';

export interface WatchArea {
  id: string;
  name: string;
  ring: LonLat[];
}

export interface WatchAlert {
  id: string;
  areaId: string;
  areaName: string;
  channel: string;
  itemId: string;
  text: string;
  ts: number;
  lon: number;
  lat: number;
}

const AREAS_KEY = 'gbg-osint:watch-areas';
export const MAX_WATCH_AREAS = 20;
export const MAX_WATCH_POINTS = 100;
const MAX_NAME = 40;
/** Ships and live trains can be watched; leisure craft are anonymised and never alerted on. */
export const WATCH_ENTITY_CHANNELS = ['maritime.ships', 'transit.rail'] as const;
/** Event feeds without a precise place (municipality-level police events, news, social posts). */
const UNPLACED_EVENT_CHANNELS = new Set(['events.police', 'events.news', 'events.social']);
const PRECISE = new Set(['exact', 'area']);
/** The same object entering the same area again within this time is not alerted twice. */
const REALERT_MS = 30 * 60_000;

const isLonLat = (p: unknown): p is LonLat =>
  Array.isArray(p) &&
  p.length === 2 &&
  p.every((v) => typeof v === 'number' && Number.isFinite(v)) &&
  Math.abs(p[0] as number) <= 180 &&
  Math.abs(p[1] as number) <= 90;

export function loadWatchAreas(): WatchArea[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(AREAS_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (a): a is WatchArea =>
          typeof a?.id === 'string' &&
          typeof a.name === 'string' &&
          Array.isArray(a.ring) &&
          a.ring.length >= 3 &&
          a.ring.length <= MAX_WATCH_POINTS &&
          a.ring.every(isLonLat),
      )
      .map((a) => ({ id: a.id.slice(0, 40), name: a.name.slice(0, MAX_NAME), ring: a.ring }))
      .slice(0, MAX_WATCH_AREAS);
  } catch {
    return [];
  }
}

export function saveWatchAreas(areas: readonly WatchArea[]): void {
  try {
    localStorage.setItem(AREAS_KEY, JSON.stringify(areas));
  } catch {
    // Storage may be unavailable (private mode); areas then last for this visit only.
  }
}

export function newWatchArea(name: string, ring: readonly LonLat[]): WatchArea {
  return {
    id: `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: name.trim().slice(0, MAX_NAME) || 'Watch area',
    ring: ring.slice(0, MAX_WATCH_POINTS),
  };
}

/** Live channels the watcher needs, out of those the server offers. */
export function watchChannels(available: ReadonlyMap<string, string>): string[] {
  return [...available]
    .filter(
      ([name, kind]) =>
        (kind === 'events' && !UNPLACED_EVENT_CHANNELS.has(name)) ||
        (WATCH_ENTITY_CHANNELS as readonly string[]).includes(name),
    )
    .map(([name]) => name);
}

interface Hit {
  text: string;
  at: LonLat;
}

/** Watchable items of a channel inside the area, by id. */
export function itemsInside(area: WatchArea, items: readonly ChannelItem[]): Map<string, Hit> {
  const hits = new Map<string, Hit>();
  for (const item of items) {
    if (isEvent(item)) {
      if (!item.geometry || !PRECISE.has(item.locationPrecision)) continue;
      const at = geometryVertices(item.geometry).find((p) => pointInRing(p, area.ring));
      if (at) hits.set(item.id, { text: item.title, at });
    } else if (isEntity(item) && (item.kind === 'ship' || item.kind === 'train')) {
      if (item.id.startsWith('anon-')) continue;
      const at: LonLat = [item.lon, item.lat];
      if (!pointInRing(at, area.ring)) continue;
      const name = item.label ?? item.id;
      hits.set(item.id, {
        text: `${item.kind === 'ship' ? 'Ship' : 'Train'} ${name} entered`,
        at,
      });
    }
  }
  return hits;
}

/**
 * Remembers what was inside each area and reports what is new. The first look at an area or a
 * channel only records the current state, so opening the app doesn't alert on everything.
 */
export class Watcher {
  private readonly inside = new Map<string, Set<string>>();
  private readonly alerted = new Map<string, number>();

  update(
    areas: readonly WatchArea[],
    channels: readonly { channel: string; items: readonly ChannelItem[] }[],
    now: number,
  ): WatchAlert[] {
    const alerts: WatchAlert[] = [];
    const live = new Set<string>();
    for (const area of areas) {
      for (const { channel, items } of channels) {
        const key = `${area.id}|${channel}`;
        live.add(key);
        const hits = itemsInside(area, items);
        const before = this.inside.get(key);
        this.inside.set(key, new Set(hits.keys()));
        if (!before) continue;
        for (const [itemId, hit] of hits) {
          if (before.has(itemId)) continue;
          const alertKey = `${key}/${itemId}`;
          if (now - (this.alerted.get(alertKey) ?? -Infinity) < REALERT_MS) continue;
          this.alerted.set(alertKey, now);
          alerts.push({
            id: `${alertKey}@${now}`,
            areaId: area.id,
            areaName: area.name,
            channel,
            itemId,
            text: hit.text,
            ts: now,
            lon: hit.at[0],
            lat: hit.at[1],
          });
        }
      }
    }
    for (const key of this.inside.keys()) if (!live.has(key)) this.inside.delete(key);
    for (const [key, at] of this.alerted) if (now - at >= REALERT_MS) this.alerted.delete(key);
    return alerts;
  }
}
