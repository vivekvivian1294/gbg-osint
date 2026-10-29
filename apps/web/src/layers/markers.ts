import {
  isEntity,
  isEvent,
  type ChannelItem,
  type ChannelKind,
  type Entity,
  type GeoEvent,
  type Severity,
} from '@gbg-osint/shared';
import type { IconId } from '../engine/icons';
import type { MarkerSpec, ModelSpec } from '../engine/markerSpec';
import { shipModel, shipScale, type ModelKind } from '../engine/vehicleModels';
import type { LayerDef } from './registry';

interface EntityStyle {
  icon: IconId;
  color(e: Entity): string;
  label?(e: Entity): string | undefined;
  labelMaxDistance?: number;
  interpolateMs?: number;
  playbackDelayMs?: number;
  laneOffsetM?(e: Entity): number | undefined;
  model?(e: Entity): ModelSpec | undefined;
  staleAfterMs?: number;
  scale?: number;
  detect?(e: Entity): { code: string; tag?: string };
  trackRange?: number;
}

const altitudeTag = (e: Entity) =>
  e.alt !== undefined ? `${Math.round(e.alt).toLocaleString('sv-SE')} m` : undefined;

const POI_COLORS: Record<string, string> = {
  hospital: '#f87171',
  police: '#60a5fa',
  fire_station: '#fb923c',
  ambulance_station: '#fbbf24',
};

const HEX = /^#[0-9a-f]{6}$/i;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const TRANSIT_FALLBACK: Record<string, string> = {
  tram: '#38bdf8',
  bus: '#60a5fa',
  ferry: '#22d3ee',
  train: '#a78bfa',
};
const TRANSIT_CODE: Record<string, string> = {
  tram: 'TRAM',
  bus: 'BUS',
  ferry: 'FERRY',
  train: 'TRAIN',
};
const TRANSIT_MODELS: Record<string, ModelKind> = {
  tram: 'tram',
  bus: 'bus',
  ferry: 'ferry',
  train: 'train',
};
/** Västtrafik positions arrive every ~15 s; play them back this far behind for smooth motion. */
const TRANSIT_PLAYBACK_MS = 20_000;
const SHIP_PLAYBACK_MS = 20_000;
const TRANSIT_MODEL_RANGE_M = 3_000;
/** Street geometry is the centreline; buses keep right, about half a lane from it. */
const BUS_LANE_OFFSET_M = 1.6;
const RAIL_LAYER = 'rail';
const RAIL_CHANNEL = 'transit.rail';

/** On time, a few minutes late, or badly late. */
function delayColor(e: Entity): string {
  const delay = num(e.props?.delayMin) ?? 0;
  return delay >= 15 ? '#f87171' : delay >= 5 ? '#fbbf24' : TRANSIT_FALLBACK.train!;
}

/** Aviation flight categories, from VFR (good) to LIFR (very low ceiling or visibility). */
export const FLIGHT_CATEGORY_COLORS: Record<string, string> = {
  VFR: '#4ade80',
  MVFR: '#60a5fa',
  IFR: '#f87171',
  LIFR: '#e879f9',
};
const SHIP_MODEL_RANGE_M = 15_000;
const CAMERA_MODEL_RANGE_M = 1_500;

/** Line colour, unless it's near-white (then the line's text colour). */
function transitColor(e: Entity): string {
  const bg = e.props?.color;
  const fg = e.props?.textColor;
  if (typeof bg === 'string' && HEX.test(bg) && bg.toLowerCase() !== '#ffffff') return bg;
  if (typeof fg === 'string' && HEX.test(fg)) return fg;
  return TRANSIT_FALLBACK[e.kind] ?? '#60a5fa';
}

const SHIP_COLORS: Record<string, string> = {
  cargo: '#4ade80',
  tanker: '#f87171',
  passenger: '#38bdf8',
  'high-speed': '#38bdf8',
  tug: '#fbbf24',
  pilot: '#fbbf24',
  'search & rescue': '#fb923c',
  fishing: '#c084fc',
  sailing: '#cbd5e1',
  pleasure: '#cbd5e1',
};

/** Colours for the European Air Quality Index levels 1 (good) to 6 (extremely poor). */
export const AQI_COLORS = ['#4ade80', '#a3e635', '#facc15', '#fb923c', '#f87171', '#c084fc'];

function waterColor(e: Entity): string {
  const level = num(e.props?.levelM);
  const high = num(e.props?.highLimitM);
  const low = num(e.props?.lowLimitM);
  if (level !== undefined && high !== undefined && level > high) return '#f87171';
  if (level !== undefined && low !== undefined && level < low) return '#fbbf24';
  return '#22d3ee';
}

function roadWeatherColor(e: Entity): string {
  if (e.props?.ice === true || e.props?.snow === true) return '#f87171';
  const surface = num(e.props?.surfaceTempC);
  if (surface !== undefined && surface <= 1) return '#fbbf24';
  return '#a5b4fc';
}

export const ENTITY_STYLES: Record<string, EntityStyle> = {
  aircraft: {
    icon: 'aircraft',
    color: (e) => (e.props?.military ? '#fbbf24' : '#5eead4'),
    label: (e) => e.label,
    labelMaxDistance: 250_000,
    interpolateMs: 10_000,
    staleAfterMs: 60_000,
    detect: (e) => ({
      code: `AC ${e.id.toUpperCase()}`,
      ...(e.props?.onGround ? { tag: 'ground' } : e.alt ? { tag: altitudeTag(e) } : {}),
    }),
    trackRange: 4_000,
  },
  satellites: {
    icon: 'satellite',
    color: () => '#c4b5fd',
    label: (e) => e.label,
    labelMaxDistance: 20_000_000,
    interpolateMs: 5_000,
    staleAfterMs: 30_000,
    detect: (e) => ({
      code: `SAT ${e.id}`,
      tag: `${Math.round((e.alt ?? 0) / 1000).toLocaleString('sv-SE')} km`,
    }),
    trackRange: 1_500_000,
  },
  bikes: {
    icon: 'bike',
    color: (e) =>
      e.props?.renting === false ? '#7d8f97' : Number(e.props?.bikes) > 0 ? '#4ade80' : '#f87171',
    label: (e) => (typeof e.props?.bikes === 'number' ? String(e.props.bikes) : undefined),
    labelMaxDistance: 4_000,
    staleAfterMs: 15 * 60_000,
    scale: 0.7,
    trackRange: 800,
  },
  poi: {
    icon: 'poi',
    color: (e) => POI_COLORS[String(e.props?.category)] ?? '#d7e3e8',
    label: (e) => e.label,
    labelMaxDistance: 12_000,
    scale: 0.8,
    trackRange: 1_200,
  },
  transit: {
    icon: 'vehicle',
    color: transitColor,
    label: (e) => e.label,
    labelMaxDistance: 5_000,
    playbackDelayMs: TRANSIT_PLAYBACK_MS,
    laneOffsetM: (e) =>
      e.kind === 'bus' && e.props?.matched === 'street' ? BUS_LANE_OFFSET_M : undefined,
    model: (e) => ({
      kind: TRANSIT_MODELS[e.kind] ?? 'bus',
      accent: transitColor(e),
      range: TRANSIT_MODEL_RANGE_M,
    }),
    staleAfterMs: 90_000,
    scale: 0.6,
    detect: (e) => {
      const direction = e.props?.direction;
      return {
        code: `${TRANSIT_CODE[e.kind] ?? 'VEH'} ${e.label ?? ''}`.trim(),
        ...(typeof direction === 'string' && { tag: direction }),
      };
    },
    trackRange: 700,
  },
  rail: {
    icon: 'vehicle',
    color: delayColor,
    label: (e) => e.label,
    labelMaxDistance: 8_000,
    playbackDelayMs: TRANSIT_PLAYBACK_MS,
    model: (e) => ({ kind: 'train', accent: delayColor(e), range: TRANSIT_MODEL_RANGE_M }),
    staleAfterMs: 3 * 60_000,
    scale: 0.65,
    detect: (e) => {
      const delay = num(e.props?.delayMin);
      const destination = e.props?.destination;
      return {
        code: `TRAIN ${String(e.props?.train ?? e.label ?? '')}`.trim(),
        ...(delay !== undefined && delay > 0
          ? { tag: `+${delay} min` }
          : typeof destination === 'string' && { tag: destination }),
      };
    },
    trackRange: 900,
  },
  'airport-weather': {
    icon: 'sensor',
    color: (e) => FLIGHT_CATEGORY_COLORS[String(e.props?.flightCategory)] ?? '#cbd5e1',
    label: (e) => e.label,
    labelMaxDistance: 80_000,
    staleAfterMs: 90 * 60_000,
    scale: 0.85,
    trackRange: 3_000,
  },
  ships: {
    icon: 'ship',
    color: (e) => SHIP_COLORS[String(e.props?.category)] ?? '#94a3b8',
    label: (e) => e.label,
    labelMaxDistance: 25_000,
    playbackDelayMs: SHIP_PLAYBACK_MS,
    model: (e) => {
      const category = String(e.props?.category);
      const length = num(e.props?.lengthM);
      const kind = shipModel(category, length);
      return {
        kind,
        accent: SHIP_COLORS[category] ?? '#94a3b8',
        scale: shipScale(kind, length, num(e.props?.beamM)),
        range: SHIP_MODEL_RANGE_M,
      };
    },
    staleAfterMs: 10 * 60_000,
    scale: 0.85,
    detect: (e) => {
      const knots = num(e.props?.speedKn);
      return {
        code: `AIS ${e.props?.mmsi ?? 'ANON'}`,
        ...(knots !== undefined && { tag: `${knots.toFixed(1)} kn` }),
      };
    },
    trackRange: 2_500,
  },
  'road-cameras': {
    icon: 'camera',
    color: () => '#e2e8f0',
    label: (e) => e.label,
    labelMaxDistance: 6_000,
    model: (e) =>
      e.heading === undefined
        ? undefined
        : { kind: 'camera', accent: '#5eead4', range: CAMERA_MODEL_RANGE_M },
    scale: 0.7,
    trackRange: 1_000,
  },
  'street-photos': {
    icon: 'photo',
    color: () => '#f0abfc',
    scale: 0.6,
  },
  'air-quality': {
    icon: 'sensor',
    color: (e) => AQI_COLORS[(num(e.props?.aqi) ?? 1) - 1] ?? '#94a3b8',
    label: (e) =>
      typeof e.props?.aqiLabel === 'string' ? `${e.label} · ${e.props.aqiLabel}` : e.label,
    labelMaxDistance: 20_000,
    scale: 0.85,
    trackRange: 1_500,
  },
  'water-levels': {
    icon: 'sensor',
    color: waterColor,
    label: (e) => {
      const level = num(e.props?.levelM);
      return level !== undefined ? `${e.label} ${level.toFixed(2)} m` : e.label;
    },
    labelMaxDistance: 12_000,
    scale: 0.75,
    trackRange: 1_500,
  },
  'road-weather': {
    icon: 'sensor',
    color: roadWeatherColor,
    label: (e) => {
      const surface = num(e.props?.surfaceTempC);
      return surface !== undefined ? `${e.label} ${surface.toFixed(1)}°` : e.label;
    },
    labelMaxDistance: 20_000,
    scale: 0.75,
    trackRange: 1_500,
  },
  'harbour-stations': {
    icon: 'sensor',
    color: harbourColor,
    label: (e) => {
      const wind = num(e.props?.windMs);
      const gust = num(e.props?.gustMs);
      const level = num(e.props?.waterLevelCm);
      if (wind !== undefined) {
        return `${e.label} ${wind.toFixed(0)}${gust !== undefined ? `(${gust.toFixed(0)})` : ''} m/s`;
      }
      return level !== undefined ? `${e.label} ${level > 0 ? '+' : ''}${level} cm` : e.label;
    },
    labelMaxDistance: 25_000,
    staleAfterMs: 30 * 60_000,
    scale: 0.75,
    trackRange: 2_000,
  },
};

/** Gusts from fresh breeze to storm (Beaufort 5–10); water-only stations in cyan. */
function harbourColor(e: Entity): string {
  const gust = num(e.props?.gustMs) ?? num(e.props?.windMs);
  if (gust === undefined) return '#22d3ee';
  return gust >= 24.5 ? '#c084fc' : gust >= 17.2 ? '#f87171' : gust >= 10.8 ? '#fbbf24' : '#5eead4';
}

export const SEVERITY_COLORS: Record<Severity, string> = {
  info: '#7dd3fc',
  minor: '#5eead4',
  major: '#fbbf24',
  critical: '#f87171',
};

const SEVERITY_RANK: Record<Severity, number> = { info: 0, minor: 1, major: 2, critical: 3 };

/** Dense local event layers only label markers when zoomed in. */
const EVENT_LABEL_DISTANCE: Record<string, number> = {
  'road-incidents': 8_000,
  'city-traffic': 4_000,
};
const EVENT_TITLE_MAX = 40;

function pointOf(e: GeoEvent): [number, number] | undefined {
  if (e.geometry?.type !== 'Point') return undefined;
  const [lon, lat] = e.geometry.coordinates;
  return typeof lon === 'number' && typeof lat === 'number' ? [lon, lat] : undefined;
}

function entityMarker(layer: LayerDef, channel: string, e: Entity, style: EntityStyle): MarkerSpec {
  const label = style.label?.(e);
  const detect = style.detect?.(e);
  const model = style.model?.(e);
  const laneOffsetM = style.laneOffsetM?.(e);
  return {
    key: `${layer.id}|${channel}|${e.id}`,
    lon: e.lon,
    lat: e.lat,
    alt: e.alt ?? 0,
    ...(e.heading !== undefined && { heading: e.heading }),
    icon: style.icon,
    color: style.color(e),
    ...(style.scale !== undefined && { scale: style.scale }),
    ...(label && { label }),
    ...(style.labelMaxDistance !== undefined && { labelMaxDistance: style.labelMaxDistance }),
    ...(style.interpolateMs !== undefined && { interpolateMs: style.interpolateMs }),
    ...(style.playbackDelayMs !== undefined && { playbackDelayMs: style.playbackDelayMs }),
    ...(style.playbackDelayMs !== undefined && e.via && { via: e.via }),
    ...(laneOffsetM !== undefined && { laneOffsetM }),
    ...(model && { model }),
    ...(style.staleAfterMs !== undefined && {
      ts: Date.parse(e.ts),
      staleAfterMs: style.staleAfterMs,
    }),
    ...(detect && { detect }),
    ...(style.trackRange !== undefined && { trackRange: style.trackRange }),
    pick: { layerId: layer.id, channel, ids: [e.id] },
  };
}

/** Events sharing a location (e.g. all police events at the municipality centre) become one marker. */
function eventMarkers(layer: LayerDef, channel: string, events: GeoEvent[]): MarkerSpec[] {
  const groups = new Map<string, { lon: number; lat: number; events: GeoEvent[] }>();
  for (const e of events) {
    const point = pointOf(e);
    if (!point) continue;
    const key = `${point[0].toFixed(5)},${point[1].toFixed(5)}`;
    const group = groups.get(key) ?? { lon: point[0], lat: point[1], events: [] };
    group.events.push(e);
    groups.set(key, group);
  }
  return [...groups].map(([key, g]) => {
    const worst = g.events.reduce((a, b) =>
      SEVERITY_RANK[b.severity] > SEVERITY_RANK[a.severity] ? b : a,
    );
    const approx = g.events.some((e) => e.locationPrecision !== 'exact');
    const single = g.events.length === 1 && !approx ? g.events[0] : undefined;
    const label = single
      ? single.title.length > EVENT_TITLE_MAX
        ? `${single.title.slice(0, EVENT_TITLE_MAX - 1)}…`
        : single.title
      : `${layer.label} ×${g.events.length}${approx ? ' (approx.)' : ''}`;
    return {
      key: `${layer.id}|${channel}|${key}`,
      lon: g.lon,
      lat: g.lat,
      alt: 0,
      icon: 'event' as const,
      color: SEVERITY_COLORS[worst.severity],
      scale: g.events.length > 1 ? 1.25 : 1,
      label,
      labelMaxDistance: EVENT_LABEL_DISTANCE[layer.id] ?? 300_000,
      pick: { layerId: layer.id, channel, ids: g.events.map((e) => e.id) },
    };
  });
}

export function buildMarkers(
  layers: readonly LayerDef[],
  channelKinds: ReadonlyMap<string, ChannelKind>,
  itemsOf: (channel: string) => ChannelItem[],
): MarkerSpec[] {
  const markers: MarkerSpec[] = [];
  // Live Trafikverket positions cover every train, so Västtrafik's few aren't drawn twice.
  const liveRail = layers.some((l) => l.id === RAIL_LAYER) && itemsOf(RAIL_CHANNEL).some(isEntity);
  for (const layer of layers) {
    for (const channel of layer.channels) {
      const kind = channelKinds.get(channel);
      const items = itemsOf(channel);
      if (kind === 'entities') {
        const style = ENTITY_STYLES[layer.id];
        if (!style) continue;
        for (const item of items) {
          if (!isEntity(item)) continue;
          if (liveRail && layer.id === 'transit' && item.kind === 'train') continue;
          markers.push(entityMarker(layer, channel, item, style));
        }
      } else if (kind === 'events') {
        markers.push(...eventMarkers(layer, channel, items.filter(isEvent)));
      }
    }
  }
  return markers;
}
