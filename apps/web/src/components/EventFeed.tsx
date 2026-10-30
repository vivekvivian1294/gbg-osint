import type { GeoEvent, LocationPrecision, Severity } from '@gbg-osint/shared';
import { useEffect, useState } from 'react';
import {
  categoryCounts,
  filterEvents,
  isFiltering,
  NO_FILTER,
  type FeedFilter,
  type FeedWindow,
  type ViewBounds,
} from '../state/feedFilter';
import type { WatchArea } from '../state/watch';

interface EventFeedProps {
  /** Newest first. */
  events: readonly GeoEvent[];
  hasEventLayers: boolean;
  filter: FeedFilter;
  onFilterChange: (filter: FeedFilter) => void;
  view: ViewBounds | null;
  watchAreas: readonly WatchArea[];
}

const MAX_ITEMS = 200;
const CLOCK_TICK_MS = 60_000;

const timeFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const PRECISION_LABEL: Partial<Record<LocationPrecision, string>> = {
  municipality: 'approx. location',
  region: 'regional',
  area: 'area',
};

const SEVERITY_OPTIONS: [Severity, string][] = [
  ['info', 'Any severity'],
  ['minor', 'Minor or worse'],
  ['major', 'Major or worse'],
  ['critical', 'Critical only'],
];

const WINDOW_OPTIONS: [FeedWindow, string][] = [
  ['all', 'Any time'],
  ['1h', 'Last hour'],
  ['6h', 'Last 6 hours'],
  ['24h', 'Last 24 hours'],
];

export function EventFeed({
  events,
  hasEventLayers,
  filter,
  onFilterChange,
  view,
  watchAreas,
}: EventFeedProps) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  if (events.length === 0) {
    return (
      <p className="empty">
        {hasEventLayers
          ? 'Waiting for events…'
          : 'No event layers are active. Turn on an event layer once its source is available.'}
      </p>
    );
  }

  const set = (change: Partial<FeedFilter>) => onFilterChange({ ...filter, ...change });
  const applied = watchAreas.length > 0 ? filter : { ...filter, inWatch: false };
  const matched = filterEvents(events, applied, { now, view, watchAreas });
  const categories = categoryCounts(events);
  if (filter.category !== null && !categories.some(([c]) => c === filter.category)) {
    categories.push([filter.category, 0]);
  }

  return (
    <>
      <div className="feed-filters" role="group" aria-label="Filter the feed">
        <label className="select">
          <span className="visually-hidden">Category</span>
          <select
            value={filter.category ?? ''}
            onChange={(e) => set({ category: e.target.value || null })}
          >
            <option value="">All categories ({events.length})</option>
            {categories.map(([category, count]) => (
              <option key={category} value={category}>
                {category} ({count})
              </option>
            ))}
          </select>
        </label>
        <div className="feed-filter-row">
          <label className="select">
            <span className="visually-hidden">Severity</span>
            <select
              value={filter.minSeverity}
              onChange={(e) => set({ minSeverity: e.target.value as Severity })}
            >
              {SEVERITY_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="select">
            <span className="visually-hidden">Started</span>
            <select
              value={filter.window}
              onChange={(e) => set({ window: e.target.value as FeedWindow })}
            >
              {WINDOW_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="feed-filter-row">
          <label className="check" title="Only events with a place in the current view">
            <input
              type="checkbox"
              checked={filter.inView}
              onChange={(e) => set({ inView: e.target.checked })}
            />
            In view
          </label>
          <label
            className="check"
            title={
              watchAreas.length > 0
                ? 'Only precisely placed events inside a watch area'
                : 'Draw a watch area with the Watch tool first'
            }
          >
            <input
              type="checkbox"
              checked={applied.inWatch}
              disabled={watchAreas.length === 0}
              onChange={(e) => set({ inWatch: e.target.checked })}
            />
            In watch areas
          </label>
        </div>
        {isFiltering(applied) && (
          <p className="feed-count" aria-live="polite">
            <span>
              {matched.length} of {events.length} events
            </span>
            <button type="button" onClick={() => onFilterChange(NO_FILTER)}>
              Clear filters
            </button>
          </p>
        )}
      </div>
      {matched.length === 0 ? (
        <p className="empty">No events match these filters.</p>
      ) : (
        <ol className="feed" aria-label="Live feed">
          {matched.slice(0, MAX_ITEMS).map((e) => (
            <li key={`${e.source}:${e.id}`} className={`feed-item severity-${e.severity}`}>
              <div className="feed-meta">
                <time dateTime={e.start}>{timeFormat.format(new Date(e.start))}</time>
                <span>{e.category}</span>
                {PRECISION_LABEL[e.locationPrecision] && (
                  <span className="approx" title={`Location precision: ${e.locationPrecision}`}>
                    {PRECISION_LABEL[e.locationPrecision]}
                  </span>
                )}
              </div>
              {e.url ? (
                <a href={e.url} target="_blank" rel="noopener noreferrer">
                  {e.title}
                </a>
              ) : (
                <span>{e.title}</span>
              )}
            </li>
          ))}
        </ol>
      )}
      {matched.length > MAX_ITEMS && (
        <p className="muted">
          Showing the newest {MAX_ITEMS} of {matched.length}. Filter to see the rest.
        </p>
      )}
    </>
  );
}
