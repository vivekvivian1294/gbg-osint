import type { Entity, GeoEvent } from '@gbg-osint/shared';
import { z } from 'zod';
import type { PollConnector } from '../core/connector';
import { roadSeverity } from './trafikverket';
import { inGothenburgBbox, truncate } from './util';

const PSI_HOST = 'data.goteborg.se';
const CATALOG_HOST = 'catalog.goteborg.se';
const HOMEPAGE = 'https://goteborg.se/psidata';
const LICENCE = 'CC0 1.0';

const DOTNET_DATE = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/;

/** ISO time from a WCF date such as `/Date(1773640800000+0100)/` (the number is UTC ms). */
export function dotNetDate(value: string | undefined): string | undefined {
  const m = value ? DOTNET_DATE.exec(value) : null;
  return m ? new Date(Number(m[1])).toISOString() : undefined;
}

// --- Trafikpåverkan: roadworks and traffic impact from the city's systems ---

const CITY_TRAFFIC = 'events.city-traffic';

const CityDeviation = z.object({
  Header: z.string().optional(),
  Message: z.string().optional(),
  MessageCode: z.string().optional(),
  MessageType: z.string().optional(),
  MessageTypeValue: z.string().optional(),
  SeverityCode: z.number().optional(),
  ValidityStatus: z.string().optional(),
  LocationDescriptor: z.string().optional(),
  TrafficRestrictionType: z.string().optional(),
  StartTime: z.string().optional(),
  EndTime: z.string().optional(),
  Lat: z.number(),
  Long: z.number(),
  Schedule: z
    .object({
      RecurringTimePeriodOfDay: z.object({ Start: z.string(), End: z.string() }).optional(),
    })
    .optional(),
});
const CitySituation = z.object({ Id: z.string().min(1).max(120), Deviation: z.unknown() });

export function parseCityTraffic(raw: readonly unknown[], now: number): GeoEvent[] {
  const events = new Map<string, GeoEvent>();
  for (const item of raw) {
    const situation = CitySituation.safeParse(item);
    if (!situation.success || events.has(situation.data.Id)) continue;
    const parsed = CityDeviation.safeParse(situation.data.Deviation);
    if (!parsed.success) continue;
    const d = parsed.data;
    if (d.ValidityStatus && d.ValidityStatus !== 'active') continue;
    if (!inGothenburgBbox(d.Long, d.Lat)) continue;
    const start = dotNetDate(d.StartTime);
    const end = dotNetDate(d.EndTime);
    if (!start || Date.parse(start) > now || (end && Date.parse(end) < now)) continue;
    const daily = d.Schedule?.RecurringTimePeriodOfDay;
    const body = [
      d.Message,
      d.LocationDescriptor,
      d.TrafficRestrictionType,
      daily && `Daily ${daily.Start}–${daily.End}`,
    ]
      .filter((s): s is string => Boolean(s?.trim()))
      .join(' · ');
    events.set(situation.data.Id, {
      id: situation.data.Id,
      source: 'goteborg',
      category: truncate(d.MessageType ?? 'Trafikpåverkan', 64),
      severity: roadSeverity(d.SeverityCode, d.MessageTypeValue),
      title: truncate(
        `${d.MessageCode ?? d.MessageType ?? 'Trafikpåverkan'}: ${d.Header ?? ''}`,
        300,
      ),
      ...(body && { body: truncate(body, 1000) }),
      geometry: { type: 'Point', coordinates: [d.Long, d.Lat] },
      locationPrecision: 'exact',
      start,
      ...(end && { end }),
    });
  }
  return [...events.values()];
}

export const goteborgTraffic: PollConnector = {
  id: 'goteborg.traffic',
  name: 'Göteborgs Stad – traffic impact',
  licence: LICENCE,
  attribution: 'Göteborgs Stad',
  homepage: HOMEPAGE,
  mode: 'poll',
  // The service often takes over a minute to answer.
  intervalMs: 10 * 60_000,
  allowedHosts: [PSI_HOST],
  requiredEnv: ['GBG_STAD_APP_ID'],
  channels: [{ name: CITY_TRAFFIC, kind: 'events' }],
  async poll(ctx) {
    const appId = encodeURIComponent(ctx.env.GBG_STAD_APP_ID ?? '');
    const raw = await ctx.http.getJson(
      `https://${PSI_HOST}/TrafficInformationService/v1.3/Situations/${appId}?format=json`,
      { timeoutMs: 120_000 },
    );
    ctx.publish.replace(CITY_TRAFFIC, parseCityTraffic(Array.isArray(raw) ? raw : [], Date.now()));
  },
};

// --- Water levels in Göta älv, Mölndalsån and regulated lakes ---

const WATER_LEVELS = 'env.water-levels';

const MeasureSite = z.object({
  Code: z.string().min(1).max(64),
  Description: z.string().min(1),
  Lat: z.number(),
  Long: z.number(),
  /** Regulation limits for dammed lakes (lower and upper), in metres. */
  SG: z.number().optional(),
  DG: z.number().optional(),
  MeasureParameters: z.array(z.object({ Code: z.string(), CurrentValue: z.number().nullish() })),
});

const SITE_PROPS: Record<string, string> = {
  Level: 'levelM',
  LevelDownstream: 'levelDownstreamM',
  Flow: 'flowM3s',
  Tapping: 'dischargeM3s',
  RainFall: 'rainMm',
};

export function parseWaterLevels(raw: readonly unknown[], ts: string): Entity[] {
  const entities: Entity[] = [];
  for (const item of raw) {
    const parsed = MeasureSite.safeParse(item);
    if (!parsed.success) continue;
    const s = parsed.data;
    const props: Record<string, unknown> = {};
    for (const p of s.MeasureParameters) {
      const key = SITE_PROPS[p.Code];
      if (key && typeof p.CurrentValue === 'number') props[key] = p.CurrentValue;
    }
    if (s.SG !== undefined) props.lowLimitM = s.SG;
    if (s.DG !== undefined) props.highLimitM = s.DG;
    entities.push({
      id: s.Code,
      source: 'goteborg',
      kind: 'sensor',
      lon: s.Long,
      lat: s.Lat,
      label: truncate(s.Description, 200),
      ts,
      props,
    });
  }
  return entities;
}

export const goteborgWaterLevels: PollConnector = {
  id: 'goteborg.waterlevels',
  name: 'Göteborgs Stad – water levels',
  licence: LICENCE,
  attribution: 'Göteborgs Stad',
  homepage: HOMEPAGE,
  mode: 'poll',
  intervalMs: 15 * 60_000,
  allowedHosts: [PSI_HOST],
  requiredEnv: ['GBG_STAD_APP_ID'],
  channels: [{ name: WATER_LEVELS, kind: 'entities' }],
  async poll(ctx) {
    const appId = encodeURIComponent(ctx.env.GBG_STAD_APP_ID ?? '');
    const raw = await ctx.http.getJson(
      `https://${PSI_HOST}/RiverService/v1.1/MeasureSites/${appId}?format=json`,
    );
    ctx.publish.replace(
      WATER_LEVELS,
      parseWaterLevels(Array.isArray(raw) ? raw : [], new Date().toISOString()),
    );
  },
};

// --- Air quality (Miljöförvaltningen, near-real-time hourly values, keyless) ---

const AIR_QUALITY = 'env.air-quality';
const AIR_DATASET = 'cb541050-487e-4eea-b7b6-640d58f28092';

const AirRow = z.object({
  date: z.string(),
  time: z.string(),
  station: z.string().min(1).max(100),
  parameter: z.string(),
  raw_value: z.string(),
  latitude_wgs84: z.string(),
  longitude_wgs84: z.string(),
});
const AirResponse = z.object({ results: z.array(z.unknown()) });

const AIR_PROPS: Record<string, string> = {
  NO2: 'no2Ugm3',
  NOx: 'noxUgm3',
  O3: 'o3Ugm3',
  PM10: 'pm10Ugm3',
  'PM2.5': 'pm25Ugm3',
  Temperature: 'tempC',
  Relative_Humidity: 'humidityPct',
  Air_Pressure: 'pressureHpa',
  Wind_Speed: 'windMs',
  Wind_Direction: 'windDirDeg',
  Rain: 'rainMmH',
  Global_Radiation: 'radiationWm2',
};

/**
 * Upper bounds (µg/m³) of the European Air Quality Index bands Good, Fair, Moderate, Poor and
 * Very poor (EEA, 2021 bands); anything above is Extremely poor. Indicative only: the EEA index
 * uses running means for some pollutants, these are single hourly values.
 */
const EAQI_BANDS: Record<string, readonly number[]> = {
  pm25Ugm3: [10, 20, 25, 50, 75],
  pm10Ugm3: [20, 40, 50, 100, 150],
  no2Ugm3: [40, 90, 120, 230, 340],
  o3Ugm3: [50, 100, 130, 240, 380],
};
export const EAQI_LABELS = ['Good', 'Fair', 'Moderate', 'Poor', 'Very poor', 'Extremely poor'];

export function airQualityIndex(props: Record<string, unknown>): number | undefined {
  let worst: number | undefined;
  for (const [key, bands] of Object.entries(EAQI_BANDS)) {
    const value = props[key];
    if (typeof value !== 'number') continue;
    const band = bands.findIndex((upper) => value <= upper);
    const level = (band === -1 ? bands.length : band) + 1;
    worst = Math.max(worst ?? 0, level);
  }
  return worst;
}

export function parseAirQuality(raw: unknown): Entity[] {
  const stations = new Map<
    string,
    { lon: number; lat: number; ts: number; props: Record<string, unknown> }
  >();
  for (const item of AirResponse.parse(raw).results) {
    const parsed = AirRow.safeParse(item);
    if (!parsed.success) continue;
    const r = parsed.data;
    const key = AIR_PROPS[r.parameter];
    const value = r.raw_value.trim() === '' ? NaN : Number(r.raw_value);
    const ts = Date.parse(`${r.date}T${r.time}`);
    let station = stations.get(r.station);
    if (!station) {
      const lon = Number(r.longitude_wgs84);
      const lat = Number(r.latitude_wgs84);
      if (!inGothenburgBbox(lon, lat) || !Number.isFinite(ts)) continue;
      station = { lon, lat, ts, props: {} };
      stations.set(r.station, station);
    }
    if (key && Number.isFinite(value)) station.props[key] = Math.round(value * 10) / 10;
    if (Number.isFinite(ts)) station.ts = Math.max(station.ts, ts);
  }
  return [...stations].map(([name, s]) => {
    const aqi = airQualityIndex(s.props);
    return {
      id: name,
      source: 'goteborg',
      kind: 'sensor' as const,
      lon: s.lon,
      lat: s.lat,
      label: name.replace(/_/g, ' '),
      ts: new Date(s.ts).toISOString(),
      props: {
        ...s.props,
        ...(aqi !== undefined && { aqi, aqiLabel: EAQI_LABELS[aqi - 1] }),
      },
    };
  });
}

export const goteborgAirQuality: PollConnector = {
  id: 'goteborg.airquality',
  name: 'Göteborgs Stad – air quality',
  licence: LICENCE,
  attribution: 'Göteborgs Stad, Miljöförvaltningen',
  homepage: HOMEPAGE,
  mode: 'poll',
  intervalMs: 15 * 60_000,
  allowedHosts: [CATALOG_HOST],
  channels: [{ name: AIR_QUALITY, kind: 'entities' }],
  async poll(ctx) {
    const raw = await ctx.http.getJson(
      `https://${CATALOG_HOST}/rowstore/dataset/${AIR_DATASET}?_limit=500`,
    );
    ctx.publish.replace(AIR_QUALITY, parseAirQuality(raw));
  },
};
