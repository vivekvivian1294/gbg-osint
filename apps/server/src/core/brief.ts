import {
  isDeparture,
  isEntity,
  isEvent,
  isMetric,
  type Brief,
  type BriefItem,
  type BriefLevel,
  type BriefSection,
  type ChannelItem,
  type Entity,
  type GeoEvent,
  type Metric,
  type Severity,
} from '@gbg-osint/shared';
import { delayIndex, delayMin } from './delays';
import { TRANSIT_LATE_KEY, type History } from './history';
import type { ChannelStore } from './store';

const LEVEL_OF: Record<Severity, BriefLevel> = {
  critical: 'alert',
  major: 'warning',
  minor: 'notice',
  info: 'info',
};
const LEVEL_RANK: Record<BriefLevel, number> = { info: 0, notice: 1, warning: 2, alert: 3 };
const MAX_ITEMS = 4;
/** Trafikverket's message type for planned roadworks. */
const ROADWORKS = 'Vägarbete';
const FRESH_ROAD_MS = 6 * 3600_000;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const hhmm = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  hour: '2-digit',
  minute: '2-digit',
});
const time = (iso: string) => hhmm.format(new Date(iso));
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const fmt = (v: number, digits = 1) =>
  v.toLocaleString('sv-SE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const signed = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v)}`;

function pointOf(e: GeoEvent): { lon: number; lat: number } | undefined {
  if (e.geometry?.type !== 'Point') return undefined;
  const [lon, lat] = e.geometry.coordinates;
  return typeof lon === 'number' && typeof lat === 'number' ? { lon, lat } : undefined;
}

const byLevel = (a: BriefItem, b: BriefItem) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level];

/** Statistical flags: series that are far from their own last 24 hours. */
const FLAGGED: { key: string; label: string; unit?: string; minAbs: number }[] = [
  { key: 'count/events.road', label: 'road incidents (Trafikverket)', minAbs: 4 },
  { key: 'count/events.city-traffic', label: 'city traffic impacts', minAbs: 4 },
  { key: 'count/events.police', label: 'police events in the feed', minAbs: 5 },
  { key: 'count/events.rail', label: 'rail disruptions', minAbs: 2 },
  { key: TRANSIT_LATE_KEY, label: 'late or cancelled departures at the hubs', minAbs: 8 },
  { key: 'env.sea-level/35120-tangudden', label: 'sea level at Tångudden', unit: 'cm', minAbs: 25 },
  { key: 'env.weather/71420-gust', label: 'wind gusts (Göteborg A)', unit: 'm/s', minAbs: 6 },
];
/** At least this much history (5-minute samples) before anything is called unusual. */
const MIN_FLAG_POINTS = 36;
const FLAG_Z = 3.5;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Robust z-score of the latest value against the earlier ones (median and MAD). */
export function anomaly(
  points: readonly (readonly [number, number])[],
  minAbs: number,
): { value: number; typical: number; z: number } | undefined {
  if (points.length < MIN_FLAG_POINTS) return undefined;
  const value = points.at(-1)![1];
  const past = points.slice(0, -1).map((p) => p[1]);
  const typical = median(past);
  const mad = median(past.map((v) => Math.abs(v - typical)));
  const spread = Math.max(1.4826 * mad, minAbs / FLAG_Z);
  const z = (value - typical) / spread;
  return Math.abs(z) >= FLAG_Z && Math.abs(value - typical) >= minAbs
    ? { value, typical, z }
    : undefined;
}

export function buildBrief(store: ChannelStore, history: History, now: number): Brief {
  const items = (channel: string): ChannelItem[] =>
    store.has(channel) ? store.snapshot(channel) : [];
  const events = (channel: string) => items(channel).filter(isEvent);
  const entities = (channel: string) => items(channel).filter(isEntity);
  const departures = (channel: string) => items(channel).filter(isDeparture);
  const metric = (channel: string, id: string): Metric | undefined =>
    items(channel).find((m): m is Metric => isMetric(m) && m.id === id);
  const eventItem = (channel: string, e: GeoEvent, prefix = ''): BriefItem => ({
    id: `${channel}:${e.id}`,
    level: LEVEL_OF[e.severity],
    text: `${prefix}${e.title}`.slice(0, 300),
    ...(e.body && { detail: e.body.slice(0, 500) }),
    target: { channel, ids: [e.id], ...pointOf(e) },
  });
  const entityTarget = (channel: string, e: Entity) => ({
    channel,
    ids: [e.id],
    lon: e.lon,
    lat: e.lat,
  });
  const sections: BriefSection[] = [];
  const section = (id: string, title: string, list: (BriefItem | undefined)[]) => {
    const kept = list.filter((i): i is BriefItem => Boolean(i));
    if (kept.length > 0) sections.push({ id, title, items: kept.slice(0, 30) });
  };

  // --- Warnings and incidents ---
  const crisis = events('events.crisis')
    .filter((e) => e.severity === 'critical')
    .map((e) => eventItem('events.crisis', e, 'VMA: '));
  const warnings = events('events.weather-warnings')
    .map((e) => eventItem('events.weather-warnings', e))
    .sort(byLevel);
  const road = events('events.road');
  const roadworks = road.filter((e) => e.category === ROADWORKS);
  // Most road messages are long-running planned restrictions; the brief wants what is new.
  const seriousRoad = road
    .filter(
      (e) =>
        e.category !== ROADWORKS &&
        (e.severity === 'major' || e.severity === 'critical') &&
        now - Date.parse(e.start) <= FRESH_ROAD_MS,
    )
    .map((e) => eventItem('events.road', e))
    .sort(byLevel);
  const recentPolice = events('events.police').filter(
    (e) => now - Date.parse(e.start) <= 3 * 3600_000,
  );
  section('incidents', 'Warnings & incidents', [
    ...crisis,
    ...warnings.slice(0, MAX_ITEMS),
    ...seriousRoad.slice(0, 3),
    road.length > 0
      ? {
          id: 'road-count',
          level: 'info',
          text: `${plural(road.length - roadworks.length, 'traffic message')} and ${plural(roadworks.length, 'roadworks', 'roadworks')} on Trafikverket roads`,
          ...(seriousRoad.length > 0 && {
            detail: `${seriousRoad.length} with large impact in the last 6 h`,
          }),
        }
      : undefined,
    recentPolice.length > 0
      ? {
          id: 'police-count',
          level: 'info',
          text: `${recentPolice.length} police event${recentPolice.length === 1 ? '' : 's'} in Göteborg in the last 3 h`,
          detail: 'The police only give the municipality, not the exact place.',
          target: { channel: 'events.police', ids: recentPolice.map((e) => e.id).slice(0, 50) },
        }
      : undefined,
  ]);

  // --- Transit and rail ---
  const boards = [...departures('transit.departures'), ...departures('transit.trains')];
  const delays = delayIndex(boards, now);
  const trains = entities('transit.rail');
  const lateTrains = trains
    .map((t) => ({ t, delay: num(t.props?.delayMin) ?? 0 }))
    .filter((x) => x.delay >= 5)
    .sort((a, b) => b.delay - a.delay);
  const worstLine = delays.lines[0];
  section('transit', 'Transit & rail', [
    ...events('events.rail')
      .map((e) => eventItem('events.rail', e))
      .sort(byLevel)
      .slice(0, 3),
    worstLine
      ? {
          id: 'worst-line',
          level: worstLine.meanDelayMin >= 5 || worstLine.cancelled > 0 ? 'notice' : 'info',
          text: `Most delayed: ${delays.lines
            .slice(0, 3)
            .map(
              (l) =>
                `${l.name} (avg +${fmt(l.meanDelayMin, 0)} min${l.cancelled ? `, ${l.cancelled} cancelled` : ''})`,
            )
            .join(', ')}`,
          detail: 'From the departure boards at the six hubs, half an hour back to an hour ahead.',
        }
      : boards.length > 0
        ? { id: 'worst-line', level: 'info', text: 'Trams and buses at the hubs are on time.' }
        : undefined,
    trains.length > 0
      ? {
          id: 'trains',
          level: lateTrains.some((x) => x.delay >= 15) ? 'notice' : 'info',
          text:
            lateTrains.length > 0
              ? `${lateTrains.length} of ${trains.length} trains in the area are 5+ min late; worst ${lateTrains[0]!.t.label} +${lateTrains[0]!.delay} min`
              : `${trains.length} train${trains.length === 1 ? '' : 's'} in the area, none 5+ min late`,
          ...(lateTrains[0] && { target: entityTarget('transit.rail', lateTrains[0].t) }),
        }
      : undefined,
  ]);

  // --- Harbour and sea ---
  const expected = departures('maritime.expected').filter((d) => {
    const eta = Date.parse(d.planned);
    return eta >= now - 30 * 60_000 && eta <= now + 6 * 3600_000;
  });
  const ships = entities('maritime.ships');
  const commercial = ships.filter((s) =>
    ['cargo', 'tanker', 'passenger'].includes(String(s.props?.category)),
  );
  const harbour = entities('env.harbour');
  const gustiest = harbour
    .map((s) => ({ s, gust: num(s.props?.gustMs) }))
    .filter((x): x is { s: Entity; gust: number } => x.gust !== undefined)
    .sort((a, b) => b.gust - a.gust)[0];
  const sea = metric('env.sea-level', '35120-tangudden');
  const highRiver = entities('env.water-levels').filter((e) => {
    const level = num(e.props?.levelM);
    const high = num(e.props?.highLimitM);
    return level !== undefined && high !== undefined && level > high;
  });
  section('harbour', 'Harbour & sea', [
    expected.length > 0
      ? {
          id: 'expected',
          level: 'info',
          text: `${expected.length} ship${expected.length === 1 ? '' : 's'} expected in the next 6 h: ${expected
            .slice(0, 4)
            .map((d) => `${d.line} ${time(d.planned)}`)
            .join(', ')}`,
          detail: 'ETAs are entered by the crews and can be out of date.',
        }
      : undefined,
    ships.length > 0
      ? {
          id: 'ships',
          level: 'info',
          text: `${ships.length} vessels on AIS in the approach${commercial.length > 0 ? `, ${commercial.length} of them cargo, tanker or passenger ships` : ''}`,
        }
      : undefined,
    gustiest
      ? {
          id: 'harbour-gust',
          level: gustiest.gust >= 17.2 ? 'warning' : gustiest.gust >= 13.9 ? 'notice' : 'info',
          text: `Strongest gusts at the harbour: ${gustiest.s.label} ${fmt(gustiest.gust)} m/s`,
          target: entityTarget('env.harbour', gustiest.s),
        }
      : undefined,
    sea
      ? {
          id: 'sea-level',
          level:
            sea.value >= 100 ? 'warning' : sea.value >= 70 || sea.value <= -50 ? 'notice' : 'info',
          text: `Sea level at Tångudden ${signed(sea.value)} cm`,
        }
      : undefined,
    ...highRiver.map((e): BriefItem => ({
      id: `river-${e.id}`,
      level: 'warning',
      text: `${e.label} is above its high-water mark (${fmt(num(e.props?.levelM)!, 2)} m)`,
      target: entityTarget('env.water-levels', e),
    })),
  ]);

  // --- Airport ---
  const flights = departures('aviation.flights').filter((d) => {
    const at = Date.parse(d.planned);
    return at >= now - 30 * 60_000 && at <= now + 2 * 3600_000;
  });
  const cancelledFlights = flights.filter((d) => d.cancelled);
  const lateFlights = flights.filter((d) => !d.cancelled && delayMin(d) >= 15);
  const esgg = entities('aviation.metar').find((e) => e.id === 'ESGG');
  const category = esgg?.props?.flightCategory;
  section('airport', 'Landvetter (GOT)', [
    flights.length > 0
      ? {
          id: 'flights',
          level: cancelledFlights.length > 0 ? 'notice' : 'info',
          text: `${flights.length} flights in the next 2 h${cancelledFlights.length ? `, ${cancelledFlights.length} cancelled` : ''}${lateFlights.length ? `, ${lateFlights.length} delayed 15+ min` : ''}`,
        }
      : undefined,
    esgg && typeof category === 'string'
      ? {
          id: 'metar',
          level: category === 'LIFR' ? 'warning' : category === 'IFR' ? 'notice' : 'info',
          text: `Flight conditions ${category}${num(esgg.props?.ceilingFt) !== undefined ? `, ceiling ${num(esgg.props?.ceilingFt)} ft` : ''}`,
          ...(typeof esgg.props?.metar === 'string' && { detail: esgg.props.metar }),
          target: entityTarget('aviation.metar', esgg),
        }
      : undefined,
  ]);

  // --- Weather and environment ---
  const temp = metric('env.weather', '71420-temp');
  const gust = metric('env.weather', '71420-gust');
  const rainChange = metric('env.nowcast', 'rain-change');
  const rainMax = metric('env.nowcast', 'rain-max');
  const worstAir = entities('env.air-quality')
    .map((e) => ({ e, aqi: num(e.props?.aqi) ?? 0 }))
    .sort((a, b) => b.aqi - a.aqi)[0];
  const icy = entities('env.road-weather').filter(
    (e) => e.props?.ice === true || e.props?.snow === true,
  );
  section('weather', 'Weather & environment', [
    temp || gust
      ? {
          id: 'weather-now',
          level:
            (gust?.value ?? 0) >= 21 ? 'warning' : (gust?.value ?? 0) >= 15 ? 'notice' : 'info',
          text: [temp && `${fmt(temp.value)} °C`, gust && `gusts ${fmt(gust.value)} m/s`]
            .filter(Boolean)
            .join(', ')
            .replace(/^./, (c) => c.toUpperCase()),
        }
      : undefined,
    rainChange
      ? {
          id: 'rain',
          level: rainChange.name === 'Rain in' && (rainMax?.value ?? 0) >= 4 ? 'notice' : 'info',
          text: `${rainChange.name} ${rainChange.value} min${rainMax && rainMax.value > 0 ? ` (up to ${fmt(rainMax.value)} mm/h)` : ''}`,
        }
      : undefined,
    worstAir && worstAir.aqi >= 3
      ? {
          id: 'air',
          level: worstAir.aqi >= 4 ? 'warning' : 'notice',
          text: `Air quality ${String(worstAir.e.props?.aqiLabel ?? worstAir.aqi).toLowerCase()} at ${worstAir.e.label}`,
          target: entityTarget('env.air-quality', worstAir.e),
        }
      : undefined,
    icy.length > 0
      ? {
          id: 'icy',
          level: 'warning',
          text: `Ice or snow reported at ${icy.length} road weather station${icy.length === 1 ? '' : 's'}`,
          target: { channel: 'env.road-weather', ids: icy.map((e) => e.id) },
        }
      : undefined,
  ]);

  // --- Energy ---
  const price = metric('energy.price-se3', 'se3-now');
  const priceMin = metric('energy.price-se3', 'se3-min');
  const priceMax = metric('energy.price-se3', 'se3-max');
  const renewable = metric('energy.mix-se', 'se-renewable');
  section('energy', 'Energy', [
    price
      ? {
          id: 'price',
          level: price.value >= 2 ? 'notice' : 'info',
          text: `Spot price SE3 ${fmt(price.value, 2)} SEK/kWh${priceMin && priceMax ? ` (today ${fmt(priceMin.value, 2)}–${fmt(priceMax.value, 2)})` : ''}`,
        }
      : undefined,
    renewable
      ? {
          id: 'renewable',
          level: 'info',
          text: `${Math.round(renewable.value)} % of Swedish generation is renewable right now`,
        }
      : undefined,
  ]);

  // --- Statistical flags ---
  section(
    'flags',
    'Unusual compared with the last 24 h',
    FLAGGED.map(({ key, label, unit, minAbs }) => {
      const series = history.seriesOf(key);
      const a = series && anomaly(series.points, minAbs);
      if (!a) return undefined;
      const u = unit ? ` ${unit}` : '';
      const above = a.value > a.typical;
      const word = unit ? (above ? 'high' : 'low') : above ? 'many' : 'few';
      return {
        id: `flag-${key}`,
        level: 'notice' as const,
        text: `Unusually ${word} ${label}: ${fmt(a.value, unit ? 1 : 0)}${u}, typically ${fmt(a.typical, unit ? 1 : 0)}${u}`,
        detail: 'A statistical flag against the last 24 hours, not an alarm.',
      };
    }),
  );

  return {
    ts: new Date(now).toISOString(),
    sections,
    delays,
    historyHours: history.hours(now),
  };
}
