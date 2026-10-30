import {
  decodeLine,
  isArea,
  isEntity,
  isEvent,
  isFeature,
  isMetric,
  type ChannelItem,
  type LonLat,
} from '@gbg-osint/shared';
import { itemBox } from './bounds';

/** An item with the layer it was shown in. */
export interface ExportRecord {
  layer: string;
  channel: string;
  item: ChannelItem;
}

export interface ExportMeta {
  generated: string;
  /** Who the data comes from, e.g. "Trafikverket (CC0)". */
  attribution: readonly string[];
}

/** Departures and radar frames have no place of their own and are left out. */
export const isExportable = (item: ChannelItem): boolean =>
  isEntity(item) || isEvent(item) || isFeature(item) || isArea(item) || isMetric(item);

/** A short human name for an item, e.g. a ship's name or an incident's title. */
export function itemTitle(item: ChannelItem): string {
  if (isEvent(item)) return item.title;
  if (isMetric(item)) return item.name;
  if ('label' in item && typeof item.label === 'string' && item.label) return item.label;
  return item.id;
}

const closed = (ring: LonLat[]): LonLat[] =>
  ring.length > 0 && (ring[0]![0] !== ring.at(-1)![0] || ring[0]![1] !== ring.at(-1)![1])
    ? [...ring, ring[0]!]
    : ring;

function geometry(item: ChannelItem): unknown {
  if (isEntity(item)) {
    return {
      type: 'Point',
      coordinates: item.alt === undefined ? [item.lon, item.lat] : [item.lon, item.lat, item.alt],
    };
  }
  if (isEvent(item)) return item.geometry ?? null;
  if (isFeature(item)) return { type: 'LineString', coordinates: decodeLine(item.line) };
  if (isArea(item)) {
    const polygons = item.polygons.map((rings) => rings.map((r) => closed(decodeLine(r))));
    return polygons.length === 1
      ? { type: 'Polygon', coordinates: polygons[0] }
      : { type: 'MultiPolygon', coordinates: polygons };
  }
  if (isMetric(item) && item.lon !== undefined && item.lat !== undefined) {
    return { type: 'Point', coordinates: [item.lon, item.lat] };
  }
  return null;
}

/** Keys that hold the place, which goes into the geometry instead. */
const PLACE_KEYS = new Set(['lon', 'lat', 'via', 'geometry', 'line', 'polygons']);

function properties(r: ExportRecord): Record<string, unknown> {
  return {
    layer: r.layer,
    channel: r.channel,
    ...Object.fromEntries(Object.entries(r.item).filter(([k]) => !PLACE_KEYS.has(k))),
  };
}

export function toGeoJson(records: readonly ExportRecord[], meta: ExportMeta): string {
  const collection = {
    type: 'FeatureCollection',
    generated: meta.generated,
    attribution: meta.attribution,
    features: records
      .filter((r) => isExportable(r.item))
      .map((r) => ({
        type: 'Feature',
        id: `${r.channel}/${r.item.id}`,
        geometry: geometry(r.item),
        properties: properties(r),
      })),
  };
  return `${JSON.stringify(collection, null, 1)}\n`;
}

const CSV_COLUMNS = [
  'layer',
  'type',
  'id',
  'source',
  'kind',
  'label',
  'lon',
  'lat',
  'alt',
  'heading',
  'speed',
  'severity',
  'value',
  'unit',
  'time',
  'end',
  'precision',
  'url',
  'details',
] as const;
type CsvRow = Partial<Record<(typeof CSV_COLUMNS)[number], string | number | undefined>>;

const round = (v: number, digits: number) => Number(v.toFixed(digits));

/** One representative point: the position, or the middle of the item's extent. */
function anchor(item: ChannelItem): LonLat | undefined {
  if (isEntity(item)) return [item.lon, item.lat];
  const box = itemBox(item);
  return box ? [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2] : undefined;
}

function csvRow(r: ExportRecord): CsvRow {
  const { item } = r;
  const at = anchor(item);
  const row: CsvRow = {
    layer: r.layer,
    id: item.id,
    source: item.source,
    ...(at && { lon: round(at[0], 6), lat: round(at[1], 6) }),
  };
  const details = (value: unknown) =>
    value && typeof value === 'object' && Object.keys(value).length > 0
      ? JSON.stringify(value)
      : undefined;
  if (isEntity(item)) {
    return {
      ...row,
      type: 'object',
      kind: item.kind,
      label: item.label,
      alt: item.alt,
      heading: item.heading,
      speed: item.speed,
      time: item.ts,
      details: details(item.props),
    };
  }
  if (isEvent(item)) {
    return {
      ...row,
      type: 'event',
      kind: item.category,
      label: item.title,
      severity: item.severity,
      time: item.start,
      end: item.end,
      precision: item.locationPrecision,
      url: item.url,
      details: item.body,
    };
  }
  if (isFeature(item)) {
    return {
      ...row,
      type: 'line',
      kind: item.kind,
      label: item.label,
      time: item.ts,
      details: details(item.props),
    };
  }
  if (isArea(item)) {
    return { ...row, type: 'area', label: item.label, time: item.ts, details: details(item.props) };
  }
  if (isMetric(item)) {
    return {
      ...row,
      type: 'reading',
      label: item.name,
      value: item.value,
      unit: item.unit,
      time: item.ts,
    };
  }
  return row;
}

/**
 * A text cell made safe for spreadsheets: quoted when needed, and never read as a formula
 * (a leading = + - @ tab or CR gets an apostrophe, as OWASP recommends for CSV injection).
 */
function cell(value: string | number | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** CSV with a UTF-8 byte-order mark so spreadsheets show å, ä and ö correctly. */
export function toCsv(records: readonly ExportRecord[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of records) {
    if (!isExportable(r.item)) continue;
    const row = csvRow(r);
    lines.push(CSV_COLUMNS.map((c) => cell(row[c])).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** A compact local timestamp for file names, e.g. 2026-10-30_1205. */
export function fileStamp(date: Date): string {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}_${get('hour')}${get('minute')}`;
}
