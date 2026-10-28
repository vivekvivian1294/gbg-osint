import {
  isArea,
  isEntity,
  isEvent,
  isFeature,
  type Area,
  type ChannelItem,
  type Entity,
  type Feature,
  type GeoEvent,
} from '@gbg-osint/shared';
import type { ReactNode } from 'react';
import type { PickRef } from '../engine/markerSpec';
import type { Contact } from '../layers/contacts';
import { DISTRICT_METRICS } from '../layers/districts';
import { LAYER_BY_ID } from '../layers/registry';

interface SelectionCardProps {
  selection: PickRef;
  items: readonly ChannelItem[];
  tracking?: TrackingControls;
  onClose(): void;
}

const timeFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  dateStyle: 'short',
  timeStyle: 'medium',
});

const PRECISION_NOTE: Record<string, string> = {
  municipality: 'Approximate: the source only gives the municipality.',
  region: 'Approximate: the source only gives the county or sea area.',
  area: 'Covers an area.',
};

function formatValue(value: unknown): string {
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

/** Props used for styling or rendered separately rather than listed. */
const HIDDEN_PROPS = new Set(['color', 'textColor', 'photoUrl']);
const CAMERA_PHOTO = /^https:\/\/api\.trafikinfo\.trafikverket\.se\/[\w./-]+\.jpg$/i;

function CameraPhoto({ entity }: { entity: Entity }) {
  const url = entity.props?.photoUrl;
  if (typeof url !== 'string' || !CAMERA_PHOTO.test(url)) return null;
  const taken = Date.parse(entity.ts);
  return (
    <figure className="camera-photo">
      <a href={`${url}?type=fullsize`} target="_blank" rel="noopener noreferrer">
        <img
          src={`${url}?t=${taken}`}
          alt={`Latest image from ${entity.label ?? 'road camera'}`}
          width={385}
          height={217}
          referrerPolicy="no-referrer"
        />
      </a>
      <figcaption>Trafikverket · {timeFormat.format(new Date(taken))}</figcaption>
    </figure>
  );
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="dl-row">
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const PHOTO_PATH =
  /^\/api\/data\/streetphotos\/img\/\d{4,5}\/\d{4,5}\/(?:pnx|kv)-[a-f0-9-]+\/(?:thumb|image)\.jpg$/;
const PROVIDERS: Record<string, string> = { panoramax: 'Panoramax', kartaview: 'KartaView' };
const LICENCES: Record<string, string> = {
  'CC-BY-SA-4.0': 'https://creativecommons.org/licenses/by-sa/4.0/',
};

function PhotoDetails({ entity }: { entity: Entity }) {
  const p = entity.props ?? {};
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const image = str(p.image);
  const page = str(p.pageUrl);
  const safePage = page && /^https:\/\//.test(page) ? page : undefined;
  const provider = PROVIDERS[String(p.provider)] ?? entity.source;
  const licence = str(p.licence) ?? 'unknown';
  const author = str(p.author);
  const taken = str(p.takenAt);
  return (
    <>
      <h3>{entity.label ?? 'Street-level photo'}</h3>
      {image && PHOTO_PATH.test(image) && (
        <figure className="camera-photo">
          <a href={safePage ?? image} target="_blank" rel="noopener noreferrer">
            <img src={image} alt={`Street-level photo from ${provider}`} width={385} height={289} />
          </a>
          <figcaption>
            {author ? `© ${author}` : provider} · {licence}
          </figcaption>
        </figure>
      )}
      <dl>
        {taken && <Row term="Taken">{timeFormat.format(new Date(taken))}</Row>}
        {entity.heading !== undefined && <Row term="Looking">{Math.round(entity.heading)}°</Row>}
        {author && <Row term="Author">{author}</Row>}
        <Row term="Licence">
          {LICENCES[licence] ? (
            <a href={LICENCES[licence]} target="_blank" rel="noopener noreferrer">
              {licence}
            </a>
          ) : (
            licence
          )}
        </Row>
        <Row term="Source">
          {safePage ? (
            <a href={safePage} target="_blank" rel="noopener noreferrer">
              {provider}
            </a>
          ) : (
            provider
          )}
        </Row>
      </dl>
      <p className="approx-note">
        Community photo, shown as published. Images are only displayed, never analysed.
      </p>
    </>
  );
}

function EntityDetails({ entity }: { entity: Entity }) {
  return (
    <>
      <h3>{entity.label ?? entity.id}</h3>
      {entity.kind === 'camera' && <CameraPhoto entity={entity} />}
      <dl>
        <Row term="Updated">{timeFormat.format(new Date(entity.ts))}</Row>
        {entity.alt !== undefined && entity.alt > 0 && (
          <Row term="Altitude">{Math.round(entity.alt).toLocaleString('sv-SE')} m</Row>
        )}
        {entity.speed !== undefined && (
          <Row term="Speed">{Math.round(entity.speed * 3.6).toLocaleString('sv-SE')} km/h</Row>
        )}
        {entity.heading !== undefined && <Row term="Heading">{Math.round(entity.heading)}°</Row>}
        {Object.entries(entity.props ?? {})
          .filter(([k]) => !HIDDEN_PROPS.has(k))
          .map(([k, v]) => (
            <Row key={k} term={k}>
              {typeof v === 'string' && /^https:\/\//.test(v) ? (
                <a href={v} target="_blank" rel="noopener noreferrer">
                  link
                </a>
              ) : (
                formatValue(v)
              )}
            </Row>
          ))}
        <Row term="Source">{entity.source}</Row>
      </dl>
      {entity.kind === 'camera' && entity.heading !== undefined && (
        <p className="approx-note">
          The viewing area on the map is an estimate from the camera&apos;s published direction.
        </p>
      )}
    </>
  );
}

function EventDetails({ event }: { event: GeoEvent }) {
  return (
    <>
      <h3>
        {event.url ? (
          <a href={event.url} target="_blank" rel="noopener noreferrer">
            {event.title}
          </a>
        ) : (
          event.title
        )}
      </h3>
      <p className="muted">
        {event.category} · {timeFormat.format(new Date(event.start))}
      </p>
      {event.body && <p>{event.body}</p>}
      {PRECISION_NOTE[event.locationPrecision] && (
        <p className="approx-note">{PRECISION_NOTE[event.locationPrecision]}</p>
      )}
    </>
  );
}

function AreaDetails({ area }: { area: Area }) {
  const p = area.props ?? {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return (
    <>
      <h3>{area.label}</h3>
      <dl>
        {DISTRICT_METRICS.map((m) => {
          const value = num(p[m.prop]);
          const year = num(p[m.yearProp]);
          return value === undefined ? null : (
            <Row key={m.id} term={m.label}>
              {m.format(value)}
              {year !== undefined && <span className="muted"> ({year})</span>}
            </Row>
          );
        })}
        {num(p.landKm2) !== undefined && (
          <Row term="Land area">{num(p.landKm2)!.toLocaleString('sv-SE')} km²</Row>
        )}
        <Row term="Area code">{typeof p.code === 'string' ? p.code : area.id}</Row>
        <Row term="Source">Statistics Sweden (SCB), CC0</Row>
      </dl>
      <p className="approx-note">
        RegSO are SCB&apos;s regional statistical areas. Figures describe all residents of the area
        and say nothing about any individual.
      </p>
    </>
  );
}

function TrafficDetails({ feature }: { feature: Feature }) {
  const p = feature.props ?? {};
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  const flow = num(p.flowVehH);
  const speed = num(p.speedKmh);
  const lanes = num(p.lanes);
  return (
    <>
      <h3>{feature.label ?? 'Measured road stretch'}</h3>
      <dl>
        {flow !== undefined && (
          <Row term="Flow">{Math.round(flow).toLocaleString('sv-SE')} vehicles/h</Row>
        )}
        {speed !== undefined && <Row term="Average speed">{Math.round(speed)} km/h</Row>}
        {lanes !== undefined && <Row term="Lanes measured">{lanes}</Row>}
        <Row term="Measured">{timeFormat.format(new Date(feature.ts))}</Row>
        <Row term="Source">Trafikverket</Row>
      </dl>
      <p className="approx-note">
        Cars are illustrative: their number and speed follow the latest measurement, but they are
        not real vehicles.
      </p>
    </>
  );
}

export interface TrackingControls {
  trackable: boolean;
  tracking: boolean;
  contacts: readonly Contact[];
  onToggle(): void;
  onPickContact(contact: Contact): void;
  /** Ride-along is offered for vehicles, ships and aircraft. */
  ride?: { active: boolean; onToggle(): void };
}

function ContactList({ tracking, current }: { tracking: TrackingControls; current: PickRef }) {
  const others = tracking.contacts.filter(
    (c) => !(c.layerId === current.layerId && current.ids.includes(c.id)),
  );
  if (others.length === 0) return <p className="muted">No other contacts nearby.</p>;
  return (
    <>
      <h3 className="contacts-title">Contacts (← →)</h3>
      <ol className="contacts">
        {others.map((c) => (
          <li key={`${c.layerId}:${c.id}`}>
            <button type="button" onClick={() => tracking.onPickContact(c)}>
              <span>{c.entity.label ?? c.id}</span>
              <span className="muted">
                {c.distanceKm < 10 ? c.distanceKm.toFixed(1) : Math.round(c.distanceKm)} km
              </span>
            </button>
          </li>
        ))}
      </ol>
    </>
  );
}

export function SelectionCard({ selection, items, tracking, onClose }: SelectionCardProps) {
  const layer = LAYER_BY_ID.get(selection.layerId);
  const single = items.length === 1 && isEntity(items[0]!);
  return (
    <aside className="selection" aria-labelledby="selection-title">
      <header>
        <h2 id="selection-title">
          {layer?.label ?? 'Selection'}
          {tracking?.tracking && <span className="badge badge-track">TRACKING</span>}
        </h2>
        <button type="button" onClick={onClose} aria-label="Close details">
          ✕
        </button>
      </header>
      {items.length === 0 && <p className="empty">No longer in the live data.</p>}
      {items.map((item) => (
        <article key={item.id} className="selection-item">
          {isEntity(item) &&
            (item.kind === 'photo' ? (
              <PhotoDetails entity={item} />
            ) : (
              <EntityDetails entity={item} />
            ))}
          {isEvent(item) && <EventDetails event={item} />}
          {isFeature(item) && item.kind === 'traffic' && <TrafficDetails feature={item} />}
          {isArea(item) && <AreaDetails area={item} />}
        </article>
      ))}
      {single && tracking?.trackable && (
        <div className="selection-actions">
          <button type="button" aria-pressed={tracking.tracking} onClick={tracking.onToggle}>
            {tracking.tracking ? 'Stop tracking (T)' : 'Track (T)'}
          </button>
          {tracking.ride && (
            <button
              type="button"
              aria-pressed={tracking.ride.active}
              onClick={tracking.ride.onToggle}
            >
              {tracking.ride.active ? 'Leave cab (C)' : 'Ride along (C)'}
            </button>
          )}
        </div>
      )}
      {tracking?.tracking && <ContactList tracking={tracking} current={selection} />}
    </aside>
  );
}
