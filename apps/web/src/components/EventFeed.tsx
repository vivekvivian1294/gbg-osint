import type { GeoEvent, LocationPrecision } from '@gbg-osint/shared';

interface EventFeedProps {
  events: readonly GeoEvent[];
  hasEventLayers: boolean;
}

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

export function EventFeed({ events, hasEventLayers }: EventFeedProps) {
  if (events.length === 0) {
    return (
      <p className="empty">
        {hasEventLayers
          ? 'Waiting for events…'
          : 'No event layers are active. Turn on an event layer once its source is available.'}
      </p>
    );
  }
  return (
    <ol className="feed" aria-label="Live feed">
      {events.map((e) => (
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
  );
}
