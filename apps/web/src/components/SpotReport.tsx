import { geometryVertices, type BriefTarget, type LonLat } from '@gbg-osint/shared';
import { useState } from 'react';
import { formatDistance } from '../layers/measure';
import { LAYERS } from '../layers/registry';
import type { SpotData } from '../state/spot';
import { AreaDetails, CameraPhoto, PHOTO_PATH } from './SelectionCard';

interface SpotReportProps {
  point: LonLat;
  data: SpotData;
  onShow(target: BriefTarget): void;
  onRouteFrom(): void;
  onPin(): void;
  onClose(): void;
}

const FIRST_EVENTS = 5;

const layerLabel = (channel: string) =>
  LAYERS.find((l) => l.channels.includes(channel))?.label ?? channel;

const degrees = ([lon, lat]: LonLat) =>
  `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(5)}° ${lon >= 0 ? 'E' : 'W'}`;

/** "What's here?": district, nearby events, cameras, street photos and Wikipedia for a point. */
export function SpotReport({ point, data, onShow, onRouteFrom, onPin, onClose }: SpotReportProps) {
  const { report, articles, photos } = data;
  const camera = report?.cameras[0];
  const [allEvents, setAllEvents] = useState(false);
  const events = report ? report.events.slice(0, allEvents ? undefined : FIRST_EVENTS) : [];
  return (
    <aside className="selection spot" aria-labelledby="spot-title">
      <header>
        <h2 id="spot-title">What&apos;s here?</h2>
        <button type="button" onClick={onClose} aria-label="Close what's here">
          ✕
        </button>
      </header>
      <p className="spot-coords">{degrees(point)}</p>
      <div className="selection-actions">
        <button type="button" onClick={onRouteFrom}>
          Route from here
        </button>
        <button type="button" onClick={onPin}>
          Drop a pin
        </button>
      </div>
      {data.failed && <p className="empty">The server did not answer.</p>}
      {!report && !data.failed && <p className="muted">Looking around…</p>}

      {report && (
        <section className="spot-section" aria-label="Within 500 m">
          <h3>Within 500 m</h3>
          {report.events.length === 0 ? (
            <p className="muted">No incidents, disruptions or warnings with a precise place.</p>
          ) : (
            <ul className="spot-list">
              {events.map(({ channel, event, distanceM }) => {
                const [lon, lat] = (event.geometry && geometryVertices(event.geometry)[0]) ?? point;
                return (
                  <li key={`${channel}:${event.id}`}>
                    <button
                      type="button"
                      onClick={() => onShow({ channel, ids: [event.id], lon, lat })}
                    >
                      <span>{event.title}</span>
                      <span className="muted">
                        {layerLabel(channel)} · {formatDistance(distanceM)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {report.events.length > events.length && (
            <button type="button" onClick={() => setAllEvents(true)}>
              Show all {report.events.length}
            </button>
          )}
        </section>
      )}

      {camera && (
        <section className="spot-section" aria-label="Nearest road camera">
          <h3>
            Nearest road camera{' '}
            <span className="muted">
              {camera.entity.label} · {formatDistance(camera.distanceM)}
            </span>
          </h3>
          <CameraPhoto entity={camera.entity} />
          <button
            type="button"
            onClick={() =>
              onShow({
                channel: camera.channel,
                ids: [camera.entity.id],
                lon: camera.entity.lon,
                lat: camera.entity.lat,
              })
            }
          >
            Show camera on map
          </button>
        </section>
      )}

      {photos && photos.length > 0 && (
        <section className="spot-section" aria-label="Street-level photos">
          <h3>Street-level photos</h3>
          <ul className="spot-photos">
            {photos.map(({ entity, distanceM }) => {
              const thumb = entity.props?.thumb;
              const page = entity.props?.pageUrl;
              if (typeof thumb !== 'string' || !PHOTO_PATH.test(thumb)) return null;
              const href = typeof page === 'string' && /^https:\/\//.test(page) ? page : thumb;
              return (
                <li key={entity.id}>
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    <img
                      src={thumb}
                      alt={`${entity.label ?? 'Street-level photo'}, ${formatDistance(distanceM)} away`}
                      width={80}
                      height={60}
                      loading="lazy"
                    />
                  </a>
                </li>
              );
            })}
          </ul>
          <p className="muted small">Panoramax and KartaView community photos, as published.</p>
        </section>
      )}

      {articles && articles.length > 0 && (
        <section className="spot-section" aria-label="Wikipedia">
          <h3>Wikipedia</h3>
          <ul className="spot-list">
            {articles.map((a) => (
              <li key={`${a.lang}:${a.title}`}>
                <a href={a.url} target="_blank" rel="noopener noreferrer" lang={a.lang}>
                  {a.title}
                </a>{' '}
                <span className="muted">
                  {a.lang} · {formatDistance(a.distanceM)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {report?.district && (
        <section className="spot-section" aria-label="District">
          <AreaDetails area={report.district} />
        </section>
      )}
    </aside>
  );
}
