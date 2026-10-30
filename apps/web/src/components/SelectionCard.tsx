import {
  decodeLine,
  ENTITY_SERIES,
  geometryVertices,
  isArea,
  isEntity,
  isEvent,
  isFeature,
  SpotReportSchema,
  type Area,
  type BriefTarget,
  type ChannelItem,
  type Entity,
  type Feature,
  type GeoEvent,
  type LonLat,
  type SpotReport,
} from '@gbg-osint/shared';
import { useState, type ReactNode } from 'react';
import type { PickRef } from '../engine/markerSpec';
import { flowRatio } from '../engine/travelTimes';
import { pickAirport, visibilityText, windText, type AirportRole } from '../layers/airportWeather';
import type { Contact } from '../layers/contacts';
import { DISTRICT_METRICS } from '../layers/districts';
import { FLIGHT_CATEGORY_COLORS } from '../layers/markers';
import { formatDistance } from '../layers/measure';
import { LAYER_BY_ID } from '../layers/registry';
import { fetchJson } from '../state/api';
import { useFlightRoute } from '../state/flightRoutes';
import { useSeries } from '../state/history';
import { spotUrl } from '../state/spot';
import { Sparkline } from './Sparkline';

interface SelectionCardProps {
  selection: PickRef;
  items: readonly ChannelItem[];
  tracking?: TrackingControls;
  /** Airport weather reports, given while riding along with an aircraft. */
  metars?: readonly Entity[];
  /** Selects another item on the map (used by the nearest-camera lookup). */
  onShow?(target: BriefTarget): void;
  onClose(): void;
}

const PRECISE_PLACE = new Set(['exact', 'area']);

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

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function formatValue(value: unknown): string {
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string' && ISO_TIME.test(value) && Number.isFinite(Date.parse(value))) {
    return timeFormat.format(new Date(value));
  }
  return String(value);
}

/** Props used for styling or rendered separately rather than listed. */
const HIDDEN_PROPS = new Set(['color', 'textColor', 'photoUrl', 'metar', 'taf', 'modes']);

/** Readable names for props that would otherwise show as code. */
const PROP_LABELS: Record<string, string> = {
  train: 'Train',
  destination: 'Destination',
  product: 'Service',
  operator: 'Operator',
  matched: 'Snapped to',
  delayMin: 'Delay (min)',
  lastStation: 'Last station',
  speedKmh: 'Speed (km/h)',
  flightCategory: 'Flight category',
  windDir: 'Wind direction',
  windKt: 'Wind (kt)',
  gustKt: 'Gusts (kt)',
  ceilingFt: 'Ceiling (ft)',
  tempC: 'Temperature (°C)',
  dewpointC: 'Dew point (°C)',
  qnhHpa: 'QNH (hPa)',
  visibilitySm: 'Visibility (SM)',
  visibility: 'Visibility',
  windMs: 'Wind (m/s)',
  gustMs: 'Gusts (m/s)',
  windFromDeg: 'Wind from (°)',
  waterLevelCm: 'Water level (cm)',
  waterTempC: 'Water temperature (°C)',
  airTempC: 'Air temperature (°C)',
  pressureHpa: 'Pressure (hPa)',
  currentKn: 'Surface current (kn)',
  currentTowardsDeg: 'Current towards (°)',
  eta: 'ETA (reported)',
  levelM: 'Water level (m)',
  aqi: 'Air quality index',
  surfaceTempC: 'Road surface (°C)',
  pm25Ugm3: 'PM2.5 (µg/m³)',
  lines: 'Lines',
  pm10Ugm3: 'PM10 (µg/m³)',
  humidityPct: 'Humidity (%)',
  aqiLabel: 'Air quality',
  sensors: 'Sensors',
  waterType: 'Water',
  euBathingWater: 'EU bathing water',
  adviceAgainstBathing: 'Advice against bathing',
  adviceSince: 'Advice since',
  abnormalSituation: 'Abnormal situation',
  lastSample: 'Latest sample',
  sampledAt: 'Sampled',
  algae: 'Algae',
  eColiPer100ml: 'E. coli (per 100 ml)',
  enterococciPer100ml: 'Enterococci (per 100 ml)',
};
const CAMERA_PHOTO = /^https:\/\/api\.trafikinfo\.trafikverket\.se\/[\w./-]+\.jpg$/i;

export function CameraPhoto({ entity }: { entity: Entity }) {
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

export function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="dl-row">
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export const PHOTO_PATH =
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

function FlightRouteRow({ callsign }: { callsign: unknown }) {
  const route = useFlightRoute(typeof callsign === 'string' ? callsign : undefined);
  if (!route) return null;
  const code = (a: typeof route.origin) => a.iata ?? a.icao;
  const place = (a: typeof route.origin) => a.city ?? a.name;
  return (
    <>
      <Row term="Route">
        {route.flight ?? route.callsign} {code(route.origin)}→{code(route.destination)}
        <span className="muted">
          {' '}
          ({place(route.origin)} → {place(route.destination)})
        </span>
      </Row>
      {route.airline && <Row term="Airline">{route.airline}</Row>}
    </>
  );
}

function RawReport({ label, text }: { label: string; text: unknown }) {
  if (typeof text !== 'string') return null;
  return (
    <>
      <p className="muted">{label}</p>
      <pre className="raw-report">{text}</pre>
    </>
  );
}

const AIRPORT_ROLES: Record<AirportRole, string> = {
  arrival: 'Arrival',
  departure: 'Departure',
  nearest: 'Nearest airport',
};

function RideWeather({ aircraft, metars }: { aircraft: Entity; metars: readonly Entity[] }) {
  const callsign = aircraft.props?.callsign;
  const route = useFlightRoute(typeof callsign === 'string' ? callsign : undefined);
  const pick = pickAirport(aircraft, metars, route);
  if (!pick) return null;
  const p = pick.metar.props ?? {};
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  const category = typeof p.flightCategory === 'string' ? p.flightCategory : undefined;
  const categoryColor = category && FLIGHT_CATEGORY_COLORS[category];
  const wind = windText(p);
  const visibility = visibilityText(p.visibilitySm);
  const ceiling = num(p.ceilingFt);
  const qnh = num(p.qnhHpa);
  const temp = num(p.tempC);
  return (
    <section className="ride-weather" aria-label="Airport weather">
      <h3>
        {AIRPORT_ROLES[pick.role]} {pick.metar.id}{' '}
        <span className="muted">
          {typeof p.airport === 'string' && `${p.airport}, `}
          {formatDistance(pick.distanceKm * 1000)}
        </span>
        {category && (
          <span
            className="flight-category"
            {...(categoryColor && { style: { color: categoryColor, borderColor: categoryColor } })}
          >
            {category}
          </span>
        )}
      </h3>
      <dl>
        {wind && <Row term="Wind">{wind}</Row>}
        {visibility && <Row term="Visibility">{visibility}</Row>}
        {ceiling !== undefined && <Row term="Ceiling">{ceiling.toLocaleString('sv-SE')} ft</Row>}
        {qnh !== undefined && <Row term="QNH">{qnh} hPa</Row>}
        {temp !== undefined && <Row term="Temperature">{temp} °C</Row>}
        <Row term="Observed">{timeFormat.format(new Date(pick.metar.ts))}</Row>
      </dl>
      <RawReport label="METAR" text={p.metar} />
    </section>
  );
}

/** 24-hour sparklines for a sensor's readings, from the server's history. */
function EntityTrends({ channel, entityId }: { channel: string; entityId: string }) {
  const series = useSeries(ENTITY_SERIES[channel] ? [`${channel}/${entityId}/`] : null);
  const [now] = useState(Date.now);
  const shown = series.filter((s) => s.points.length >= 2);
  if (shown.length === 0) return null;
  return (
    <dl className="selection-trends" aria-label="Last 24 hours">
      {shown.map((s) => {
        const prop = s.key.slice(s.key.lastIndexOf('/') + 1);
        const label = PROP_LABELS[prop] ?? prop;
        return (
          <Row key={s.key} term={label}>
            <Sparkline series={s} now={now} label={label} />
          </Row>
        );
      })}
    </dl>
  );
}

function EntityDetails({ entity, channel }: { entity: Entity; channel: string }) {
  const p = entity.props ?? {};
  return (
    <>
      <h3>{entity.label ?? entity.id}</h3>
      {entity.kind === 'camera' && <CameraPhoto entity={entity} />}
      <dl>
        <Row term="Updated">{timeFormat.format(new Date(entity.ts))}</Row>
        {p.callsign !== undefined && <FlightRouteRow callsign={p.callsign} />}
        {entity.alt !== undefined && entity.alt > 0 && (
          <Row term="Altitude">{Math.round(entity.alt).toLocaleString('sv-SE')} m</Row>
        )}
        {entity.speed !== undefined && (
          <Row term="Speed">{Math.round(entity.speed * 3.6).toLocaleString('sv-SE')} km/h</Row>
        )}
        {entity.heading !== undefined && <Row term="Heading">{Math.round(entity.heading)}°</Row>}
        {Object.entries(p)
          .filter(([k]) => !HIDDEN_PROPS.has(k))
          .map(([k, v]) => (
            <Row key={k} term={PROP_LABELS[k] ?? k}>
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
      <EntityTrends channel={channel} entityId={entity.id} />
      <RawReport label="METAR" text={p.metar} />
      <RawReport label="TAF" text={p.taf} />
      {entity.kind === 'camera' && entity.heading !== undefined && (
        <p className="approx-note">
          The viewing area on the map is an estimate from the camera&apos;s published direction.
        </p>
      )}
    </>
  );
}

function EventDetails({ event }: { event: GeoEvent }) {
  const note =
    event.locationPrecision === 'district' && event.place
      ? `Approximate: placed in ${event.place}, the district named in the text.`
      : PRECISION_NOTE[event.locationPrecision];
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
      {note && <p className="approx-note">{note}</p>}
    </>
  );
}

export function AreaDetails({ area }: { area: Pick<Area, 'id' | 'label' | 'props'> }) {
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

const minutes = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

function TransitRouteDetails({ feature }: { feature: Feature }) {
  const p = feature.props ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  return (
    <>
      <h3>{feature.label ?? 'Route'}</h3>
      <dl>
        {str(p.towards) && <Row term="Towards">{str(p.towards)}</Row>}
        {str(p.operator) && <Row term="Operator">{str(p.operator)}</Row>}
        <Row term="Timetable">{timeFormat.format(new Date(feature.ts))}</Row>
        <Row term="Source">Västtrafik GTFS via Trafiklab (CC0)</Row>
      </dl>
      <p className="approx-note">
        The most common path for this line and direction; some trips take other routes.
      </p>
    </>
  );
}

function TravelTimeDetails({ feature }: { feature: Feature }) {
  const p = feature.props ?? {};
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  const travel = num(p.travelTimeS);
  const free = num(p.freeFlowS);
  const ratio = flowRatio(p);
  return (
    <>
      <h3>{feature.label ?? 'Measured stretch'}</h3>
      <dl>
        {travel !== undefined && <Row term="Travel time">{minutes(travel)} min</Row>}
        {free !== undefined && <Row term="At free flow">{minutes(free)} min</Row>}
        {ratio !== undefined && ratio < 0.98 && (
          <Row term="Slower by">{Math.round((1 / ratio - 1) * 100)} %</Row>
        )}
        {num(p.speedKmh) !== undefined && (
          <Row term="Average speed">{Math.round(num(p.speedKmh)!)} km/h</Row>
        )}
        {num(p.lengthM) !== undefined && (
          <Row term="Length">{(num(p.lengthM)! / 1000).toFixed(1)} km</Row>
        )}
        {typeof p.status === 'string' && <Row term="Status">{p.status}</Row>}
        <Row term="Measured">{timeFormat.format(new Date(feature.ts))}</Row>
        <Row term="Source">Trafikverket</Row>
      </dl>
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

/** Where to look for a camera from: the object, the event's place or the middle of a stretch. */
export function positionOf(item: ChannelItem): LonLat | undefined {
  if (isEntity(item)) {
    return item.kind === 'camera' || item.kind === 'photo' ? undefined : [item.lon, item.lat];
  }
  if (isEvent(item)) {
    return item.geometry && PRECISE_PLACE.has(item.locationPrecision)
      ? geometryVertices(item.geometry)[0]
      : undefined;
  }
  if (isFeature(item)) {
    const line = decodeLine(item.line);
    return line[Math.floor(line.length / 2)];
  }
  return undefined;
}

type Nearest = SpotReport['cameras'][number] | null | 'idle' | 'loading';

/** On request, the closest Trafikverket road camera and its latest image. */
function NearestCamera({ at, onShow }: { at: LonLat; onShow(target: BriefTarget): void }) {
  const [nearest, setNearest] = useState<Nearest>('idle');
  const load = () => {
    setNearest('loading');
    fetchJson(spotUrl(at), SpotReportSchema).then(
      (r) => setNearest(r.cameras[0] ?? null),
      () => setNearest(null),
    );
  };
  if (nearest === 'idle') {
    return (
      <div className="selection-actions">
        <button type="button" onClick={load}>
          Nearest road camera
        </button>
      </div>
    );
  }
  if (nearest === 'loading') return <p className="muted">Looking for a road camera…</p>;
  if (!nearest) return <p className="muted">No road camera within 5 km.</p>;
  const cam = nearest.entity;
  return (
    <section className="nearest-camera" aria-label="Nearest road camera">
      <h3>
        {cam.label ?? 'Road camera'}{' '}
        <span className="muted">{formatDistance(nearest.distanceM)} away</span>
      </h3>
      <CameraPhoto entity={cam} />
      <button
        type="button"
        onClick={() =>
          onShow({ channel: nearest.channel, ids: [cam.id], lon: cam.lon, lat: cam.lat })
        }
      >
        Show camera on map
      </button>
    </section>
  );
}

export function SelectionCard({
  selection,
  items,
  tracking,
  metars,
  onShow,
  onClose,
}: SelectionCardProps) {
  const layer = LAYER_BY_ID.get(selection.layerId);
  const single = items.length === 1 && isEntity(items[0]!);
  const at = items.length === 1 ? positionOf(items[0]!) : undefined;
  const riding = Boolean(metars && tracking?.tracking && tracking.ride?.active);
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
          {riding && metars && isEntity(item) && <RideWeather aircraft={item} metars={metars} />}
          {isEntity(item) &&
            (item.kind === 'photo' ? (
              <PhotoDetails entity={item} />
            ) : (
              <EntityDetails entity={item} channel={selection.channel} />
            ))}
          {isEvent(item) && <EventDetails event={item} />}
          {isFeature(item) && item.kind === 'traffic' && <TrafficDetails feature={item} />}
          {isFeature(item) && item.kind === 'travel-time' && <TravelTimeDetails feature={item} />}
          {isFeature(item) && item.kind === 'transit-route' && (
            <TransitRouteDetails feature={item} />
          )}
          {isArea(item) && <AreaDetails area={item} />}
          {at && onShow && <NearestCamera at={at} onShow={onShow} />}
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
