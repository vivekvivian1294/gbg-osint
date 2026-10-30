import type { GeoEvent, Severity } from '@gbg-osint/shared';
import { inView, type ViewBounds } from './bounds';
import { eventInside, type WatchArea } from './watch';

export type { ViewBounds } from './bounds';

export type FeedWindow = 'all' | '1h' | '6h' | '24h';

export interface FeedFilter {
  category: string | null;
  minSeverity: Severity;
  window: FeedWindow;
  inView: boolean;
  inWatch: boolean;
}

export const NO_FILTER: FeedFilter = {
  category: null,
  minSeverity: 'info',
  window: 'all',
  inView: false,
  inWatch: false,
};

export const SEVERITY_RANK: Record<Severity, number> = { info: 0, minor: 1, major: 2, critical: 3 };

const HOUR = 3_600_000;
export const WINDOW_MS: Record<Exclude<FeedWindow, 'all'>, number> = {
  '1h': HOUR,
  '6h': 6 * HOUR,
  '24h': 24 * HOUR,
};

export const isFiltering = (f: FeedFilter): boolean =>
  f.category !== null || f.minSeverity !== 'info' || f.window !== 'all' || f.inView || f.inWatch;

/** Whether any part of the event's area overlaps the view; events without a place never do. */
export const eventInView = (event: GeoEvent, view: ViewBounds): boolean => inView(event, view);

export interface FeedContext {
  now: number;
  /** Unknown (e.g. looking at the sky): the "in view" filter then lets everything through. */
  view: ViewBounds | null;
  watchAreas: readonly WatchArea[];
}

export function filterEvents(
  events: readonly GeoEvent[],
  f: FeedFilter,
  { now, view, watchAreas }: FeedContext,
): GeoEvent[] {
  const minRank = SEVERITY_RANK[f.minSeverity];
  const since = f.window === 'all' ? -Infinity : now - WINDOW_MS[f.window];
  return events.filter((e) => {
    if (f.category !== null && e.category !== f.category) return false;
    if (SEVERITY_RANK[e.severity] < minRank) return false;
    if (f.window !== 'all') {
      const start = Date.parse(e.start);
      if (start < since || start > now) return false;
    }
    if (f.inView && view && !eventInView(e, view)) return false;
    if (f.inWatch && !watchAreas.some((a) => eventInside(e, a.ring))) return false;
    return true;
  });
}

/** Categories present in the feed with how many events each has, most common first. */
export function categoryCounts(events: readonly GeoEvent[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'sv'));
}
