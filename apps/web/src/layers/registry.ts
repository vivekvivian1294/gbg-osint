import type { ChannelKind, SourceState, SourceStatus } from '@gbg-osint/shared';

export type LayerGroup =
  'movement' | 'boards' | 'cameras' | 'infrastructure' | 'events' | 'environment' | 'context';

export const LAYER_GROUPS: readonly { id: LayerGroup; label: string }[] = [
  { id: 'movement', label: 'Movement' },
  { id: 'boards', label: 'Departure boards' },
  { id: 'cameras', label: 'Cameras' },
  { id: 'infrastructure', label: 'Infrastructure' },
  { id: 'events', label: 'Events' },
  { id: 'environment', label: 'Environment' },
  { id: 'context', label: 'Context' },
];

export interface LayerDef {
  id: string;
  label: string;
  group: LayerGroup;
  /** Server connector ids that feed this layer. */
  sourceIds: readonly string[];
  channels: readonly string[];
  /** Roadmap phase in PLAN.md in which the layer is planned to arrive. */
  phase: number;
  /** On by default even though it isn't a phase-1 layer. */
  defaultOn?: boolean;
  /** Caveat shown as a tooltip, e.g. how a derived figure should (not) be read. */
  note?: string;
}

export const LAYERS: readonly LayerDef[] = [
  {
    id: 'aircraft',
    label: 'Aircraft',
    group: 'movement',
    sourceIds: ['adsbfi.aircraft'],
    channels: ['aviation.aircraft'],
    phase: 1,
  },
  {
    id: 'satellites',
    label: 'Satellites',
    group: 'movement',
    sourceIds: ['celestrak.satellites'],
    channels: ['space.satellites'],
    phase: 1,
  },
  {
    id: 'bikes',
    label: 'Styr & Ställ bikes',
    group: 'movement',
    sourceIds: ['nextbike.styrochstall'],
    channels: ['mobility.bikes'],
    phase: 1,
  },
  {
    id: 'transit',
    label: 'Trams, buses & ferries',
    group: 'movement',
    sourceIds: ['vasttrafik.vehicles'],
    channels: ['transit.vehicles'],
    phase: 3,
    defaultOn: true,
  },
  {
    id: 'ships',
    label: 'Ships (AIS)',
    group: 'movement',
    sourceIds: ['aisstream.ships'],
    channels: ['maritime.ships'],
    phase: 3,
    defaultOn: true,
  },
  {
    id: 'traffic',
    label: 'Road traffic (illustrative cars)',
    group: 'movement',
    sourceIds: ['trafikverket.trafficflow'],
    channels: ['roads.traffic-flow'],
    phase: 3,
    defaultOn: true,
  },
  {
    id: 'rail',
    label: 'Trains (live, Trafikverket)',
    group: 'movement',
    sourceIds: ['trafikverket.trainpositions'],
    channels: ['transit.rail'],
    phase: 6,
    defaultOn: true,
  },
  {
    id: 'travel-times',
    label: 'Road travel times (measured)',
    group: 'movement',
    sourceIds: ['trafikverket.traveltimes'],
    channels: ['roads.travel-times'],
    phase: 6,
    defaultOn: true,
    note: 'Measured travel times on Trafikverket stretches, coloured by speed against free flow.',
  },
  {
    id: 'departures',
    label: 'Tram, bus & ferry hubs',
    group: 'boards',
    sourceIds: ['vasttrafik.departures'],
    channels: ['transit.departures'],
    phase: 3,
    defaultOn: true,
  },
  {
    id: 'trains',
    label: 'Trains at Göteborg C',
    group: 'boards',
    sourceIds: ['trafikverket.trains'],
    channels: ['transit.trains'],
    phase: 3,
    defaultOn: true,
  },
  {
    id: 'flights',
    label: 'Landvetter flights',
    group: 'boards',
    sourceIds: ['swedavia.flights'],
    channels: ['aviation.flights'],
    phase: 3,
    defaultOn: true,
  },
  {
    id: 'ferries',
    label: 'Road ferries (Hönö, Björkö, …)',
    group: 'boards',
    sourceIds: ['trafikverket.ferries'],
    channels: ['transit.ferries'],
    phase: 6,
    defaultOn: true,
  },
  {
    id: 'expected-ships',
    label: 'Ships expected at Gothenburg (AIS)',
    group: 'boards',
    sourceIds: ['aisstream.ships'],
    channels: ['maritime.expected'],
    phase: 6,
    defaultOn: true,
    note: 'Destination and ETA as typed in by each ship’s crew; they can be out of date.',
  },
  {
    id: 'road-cameras',
    label: 'Road cameras',
    group: 'cameras',
    sourceIds: ['trafikverket.cameras'],
    channels: ['cameras.road'],
    phase: 3,
  },
  {
    id: 'street-photos',
    label: 'Street-level photos (Panoramax, KartaView)',
    group: 'cameras',
    sourceIds: ['streetphotos'],
    channels: ['photos.street'],
    phase: 4,
  },
  {
    id: 'buildings',
    label: '3D buildings (OpenStreetMap)',
    group: 'infrastructure',
    sourceIds: ['openfreemap.buildings'],
    channels: [],
    phase: 4,
    defaultOn: true,
  },
  {
    id: 'poi',
    label: 'Emergency services & POIs',
    group: 'infrastructure',
    sourceIds: ['osm.poi'],
    channels: ['context.poi'],
    phase: 1,
  },
  {
    id: 'bridge',
    label: 'Hisingsbron status',
    group: 'infrastructure',
    sourceIds: ['goteborg.bridge'],
    channels: ['infra.bridge'],
    phase: 3,
  },
  {
    id: 'police',
    label: 'Police events',
    group: 'events',
    sourceIds: ['polisen.events'],
    channels: ['events.police'],
    phase: 1,
  },
  {
    id: 'crisis',
    label: 'Crisis alerts',
    group: 'events',
    sourceIds: ['krisinformation.news'],
    channels: ['events.crisis'],
    phase: 1,
  },
  {
    id: 'weather-warnings',
    label: 'SMHI weather warnings',
    group: 'events',
    sourceIds: ['smhi.warnings'],
    channels: ['events.weather-warnings'],
    phase: 1,
  },
  {
    id: 'news',
    label: 'Local news',
    group: 'events',
    sourceIds: ['rss.news'],
    channels: ['events.news'],
    phase: 1,
  },
  {
    id: 'social',
    label: 'Social posts (Bluesky, Mastodon)',
    group: 'events',
    sourceIds: ['social.posts'],
    channels: ['events.social'],
    phase: 5,
    note: 'Public posts mentioning Gothenburg. Only text, time and a link are shown; nothing is stored.',
  },
  {
    id: 'road-incidents',
    label: 'Road incidents (Trafikverket)',
    group: 'events',
    sourceIds: ['trafikverket.situations'],
    channels: ['events.road'],
    phase: 3,
  },
  {
    id: 'rail-events',
    label: 'Rail disruptions (Trafikverket)',
    group: 'events',
    sourceIds: ['trafikverket.railevents'],
    channels: ['events.rail'],
    phase: 6,
    defaultOn: true,
  },
  {
    id: 'city-traffic',
    label: 'City roadworks & traffic impact',
    group: 'events',
    sourceIds: ['goteborg.traffic'],
    channels: ['events.city-traffic'],
    phase: 3,
  },
  {
    id: 'transit-disruptions',
    label: 'Transit disruptions',
    group: 'events',
    sourceIds: ['vasttrafik.disruptions'],
    channels: ['events.transit'],
    phase: 3,
  },
  {
    id: 'weather',
    label: 'Weather & forecast',
    group: 'environment',
    sourceIds: ['smhi.observations', 'smhi.forecast'],
    channels: ['env.weather', 'env.forecast'],
    phase: 1,
  },
  {
    id: 'radar',
    label: 'Precipitation radar (last hour)',
    group: 'environment',
    sourceIds: ['smhi.radar'],
    channels: ['env.radar'],
    phase: 4,
  },
  {
    id: 'rain-nowcast',
    label: 'Rain nowcast (next 2 h)',
    group: 'environment',
    sourceIds: ['metno.nowcast'],
    channels: ['env.nowcast'],
    phase: 6,
    defaultOn: true,
    note: 'MET Norway radar nowcast for central Gothenburg, in 5-minute steps.',
  },
  {
    id: 'wind',
    label: 'Wind (animated)',
    group: 'environment',
    sourceIds: ['openmeteo.wind'],
    channels: ['env.wind'],
    phase: 6,
    note: 'Model wind at 10 m from Open-Meteo on a grid about 15 km apart, interpolated between points; the reading at the bottom is for the centre of the view.',
  },
  {
    id: 'satellite',
    label: 'Satellite image (yesterday)',
    group: 'environment',
    sourceIds: ['nasa.gibs'],
    channels: [],
    phase: 6,
    note: 'NASA VIIRS true colour from yesterday, about 375 m per pixel: clouds, snow, ice and algae blooms.',
  },
  {
    id: 'harbour-stations',
    label: 'Harbour stations (ViVa)',
    group: 'environment',
    sourceIds: ['viva.stations'],
    channels: ['env.harbour'],
    phase: 6,
    defaultOn: true,
  },
  {
    id: 'sea-level',
    label: 'Sea level',
    group: 'environment',
    sourceIds: ['smhi.sealevel'],
    channels: ['env.sea-level'],
    phase: 1,
  },
  {
    id: 'air-quality',
    label: 'Air quality',
    group: 'environment',
    sourceIds: ['goteborg.airquality'],
    channels: ['env.air-quality'],
    phase: 3,
  },
  {
    id: 'air-quality-community',
    label: 'Air quality (citizen sensors)',
    group: 'environment',
    sourceIds: ['sensorcommunity.air'],
    channels: ['env.air-quality-community'],
    phase: 6,
    note: 'Low-cost Sensor.Community particle sensors: indicative only, and they read high in fog and humid air. Positions are rounded to about 100 m.',
  },
  {
    id: 'pollen',
    label: 'Pollen forecast',
    group: 'environment',
    sourceIds: ['pollenrapporten.forecast'],
    channels: ['env.pollen'],
    phase: 6,
    defaultOn: true,
    note: 'Pollenrapporten forecast for Göteborg, levels 0–7. Forecasts run from about February to September.',
  },
  {
    id: 'bathing',
    label: 'Bathing water quality',
    group: 'environment',
    sourceIds: ['hav.bathingwaters'],
    channels: ['env.bathing'],
    phase: 6,
    note: 'Havs- och vattenmyndigheten: municipal samples in the bathing season (June–August) and advice against bathing. Out of season the latest sample is from last summer.',
  },
  {
    id: 'water-levels',
    label: 'Göta älv & lake levels',
    group: 'environment',
    sourceIds: ['goteborg.waterlevels'],
    channels: ['env.water-levels'],
    phase: 3,
  },
  {
    id: 'waterways',
    label: 'Rivers & streams (flow animation)',
    group: 'environment',
    sourceIds: ['osm.waterways'],
    channels: ['env.waterways'],
    phase: 3,
    defaultOn: true,
  },
  {
    id: 'road-weather',
    label: 'Road weather stations',
    group: 'environment',
    sourceIds: ['trafikverket.roadweather'],
    channels: ['env.road-weather'],
    phase: 3,
  },
  {
    id: 'airport-weather',
    label: 'Airport weather (METAR/TAF)',
    group: 'environment',
    sourceIds: ['aviationweather.metar'],
    channels: ['aviation.metar'],
    phase: 6,
    defaultOn: true,
  },
  {
    id: 'electricity',
    label: 'Electricity price (SE3)',
    group: 'context',
    sourceIds: ['elpris.se3'],
    channels: ['energy.price-se3'],
    phase: 1,
  },
  {
    id: 'energy-mix',
    label: 'Energy mix (Sweden)',
    group: 'context',
    sourceIds: ['energycharts.se'],
    channels: ['energy.mix-se'],
    phase: 5,
    note: 'Swedish electricity generation by source, latest quarter-hour (Energy-Charts, ENTSO-E data).',
  },
  {
    id: 'gnss',
    label: 'GNSS quality (from aircraft)',
    group: 'context',
    sourceIds: ['adsbfi.aircraft'],
    channels: ['aviation.gnss'],
    phase: 5,
    note: 'Share of aircraft within 100 NM reporting low GNSS position integrity (NIC < 7). Degraded values can have many causes and are not proof of jamming.',
  },
  {
    id: 'districts',
    label: 'District statistics (SCB)',
    group: 'context',
    sourceIds: ['scb.districts'],
    channels: ['context.districts'],
    phase: 5,
  },
];

export const LAYER_BY_ID: ReadonlyMap<string, LayerDef> = new Map(LAYERS.map((l) => [l.id, l]));

/** Channels filled by on-demand fetches in the browser rather than the live socket. */
export const LOCAL_CHANNELS: ReadonlyMap<string, ChannelKind> = new Map([
  ['photos.street', 'entities'],
]);

/** Layers shown when the URL doesn't specify any. */
export const DEFAULT_LAYERS: readonly string[] = LAYERS.filter(
  (l) => l.phase === 1 || l.defaultOn,
).map((l) => l.id);

export type Availability =
  | { kind: 'planned'; phase: number }
  | { kind: 'needs-config'; missing: string[] }
  | { kind: 'available'; state: SourceState };

const STATE_RANK: Record<SourceState, number> = {
  ok: 0,
  idle: 1,
  degraded: 2,
  down: 3,
  disabled: 4,
};

export function layerAvailability(
  layer: LayerDef,
  sources: ReadonlyMap<string, SourceStatus>,
): Availability {
  const statuses = layer.sourceIds.map((id) => sources.get(id));
  if (statuses.length === 0 || statuses.some((s) => !s)) {
    return { kind: 'planned', phase: layer.phase };
  }
  const present = statuses as SourceStatus[];
  if (present.some((s) => s.state === 'disabled')) {
    return { kind: 'needs-config', missing: present.flatMap((s) => s.missingEnv) };
  }
  const worst = present.reduce<SourceState>(
    (acc, s) => (STATE_RANK[s.state] > STATE_RANK[acc] ? s.state : acc),
    'ok',
  );
  return { kind: 'available', state: worst };
}
