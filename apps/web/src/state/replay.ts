import {
  HistoryRangeSchema,
  REPLAY_ENTITY_CHANNELS,
  ReplaySchema,
  type ChannelItem,
  type ChannelKind,
  type HistoryRange,
} from '@gbg-osint/shared';
import { useEffect, useState } from 'react';
import { fetchJson } from './api';

const RANGE_REFRESH_MS = 60_000;
/** While scrubbing, a moment is only fetched once the slider rests this long. */
const SCRUB_DEBOUNCE_MS = 150;

export interface ReplayState {
  /** The replayed moment, epoch ms. */
  t: number;
  playing: boolean;
  /** Replayed seconds per real second. */
  speed: number;
}

export const REPLAY_SPEEDS: readonly { speed: number; label: string }[] = [
  { speed: 60, label: '1 min/s' },
  { speed: 600, label: '10 min/s' },
  { speed: 3600, label: '1 h/s' },
];

/** Channels whose past the server keeps: all events and readings, and selected objects. */
export function isReplayable(channel: string, kind: ChannelKind | undefined): boolean {
  return (
    kind === 'events' ||
    kind === 'metrics' ||
    (kind === 'entities' && REPLAY_ENTITY_CHANNELS.has(channel))
  );
}

/** Context that hardly changes in a week, shown as it is now during replay. */
export const STATIC_CHANNELS: ReadonlySet<string> = new Set([
  'context.districts',
  'context.poi',
  'context.tunnels',
  'transit.routes',
  'transit.stops',
  'env.waterways',
]);

/** Oldest and newest moments the server has, refreshed every minute while replaying. */
export function useHistoryRange(active: boolean): HistoryRange | null {
  const [range, setRange] = useState<HistoryRange | null>(null);
  useEffect(() => {
    if (!active) return;
    const ctrl = new AbortController();
    const load = () =>
      fetchJson('/api/history/range', HistoryRangeSchema, ctrl.signal).then(setRange, () => {
        // Keep the last range; the next refresh tries again.
      });
    void load();
    const timer = setInterval(() => void load(), RANGE_REFRESH_MS);
    return () => {
      clearInterval(timer);
      ctrl.abort();
    };
  }, [active]);
  return active ? range : null;
}

export interface ReplayData {
  t: number;
  items: ReadonlyMap<string, ChannelItem[]>;
}

/** What `channels` held at moment `t`; the previous moment stays shown until the next one loads. */
export function useReplay(t: number | null, channels: readonly string[]): ReplayData | null {
  const url =
    t === null || channels.length === 0
      ? null
      : `/api/history/at?t=${Math.round(t)}&channels=${channels.map(encodeURIComponent).join(',')}`;
  const [data, setData] = useState<ReplayData | null>(null);
  useEffect(() => {
    if (!url) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetchJson(url, ReplaySchema, ctrl.signal).then(
        (r) => setData({ t: r.t, items: new Map(r.channels.map((c) => [c.channel, c.items])) }),
        () => {
          // A failed or superseded moment keeps the last one on screen.
        },
      );
    }, SCRUB_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [url]);
  return t === null ? null : data;
}
