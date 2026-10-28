import type { Place } from './places';

export interface EntityCandidate {
  layerId: string;
  id: string;
  label: string;
  kind: string;
}

export type SearchResult =
  | { type: 'coords'; label: string; lon: number; lat: number }
  | { type: 'place'; label: string; place: Place }
  | { type: 'entity'; label: string; entity: EntityCandidate };

const MAX_PLACES = 6;
const MAX_ENTITIES = 5;

/** Lower-case, accents removed, whitespace collapsed: "Göteborg " → "goteborg". */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Decimal latitude/longitude ("57.70, 11.97" or "57.70 11.97") or a 2D `geo:` URI
 * ("geo:57.70,11.97"). Returns undefined for anything else or out-of-range values.
 */
export function parseCoordinates(input: string): { lat: number; lon: number } | undefined {
  const text = input.trim();
  const geo = /^geo:([^;?]+)/i.exec(text);
  const body = geo ? geo[1]! : text;
  const parts = body.split(geo ? ',' : /[\s,]+/).filter(Boolean);
  if (parts.length !== 2) return undefined;
  if (!parts.every((p) => /^[+-]?\d+(\.\d+)?$/.test(p))) return undefined;
  const [lat, lon] = parts.map(Number) as [number, number];
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  return { lat, lon };
}

function score(name: string, query: string): number | undefined {
  const n = normalize(name);
  if (n === query) return 0;
  if (n.startsWith(query)) return 1;
  if (n.split(/[\s-]+/).some((w) => w.startsWith(query))) return 2;
  if (n.includes(query)) return 3;
  return undefined;
}

function rank<T>(items: readonly T[], names: (item: T) => readonly string[], query: string): T[] {
  return items
    .map((item) => {
      const scores = names(item).flatMap((n) => score(n, query) ?? []);
      return { item, score: scores.length > 0 ? Math.min(...scores) : undefined };
    })
    .filter((r): r is { item: T; score: number } => r.score !== undefined)
    .sort((a, b) => a.score - b.score)
    .map((r) => r.item);
}

export function search(
  input: string,
  places: readonly Place[],
  entities: readonly EntityCandidate[] = [],
): SearchResult[] {
  const coords = parseCoordinates(input);
  if (coords) {
    return [
      { type: 'coords', label: `${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)}`, ...coords },
    ];
  }
  const query = normalize(input);
  if (query.length < 2) return [];
  const placeResults = rank(places, (p) => [p.name, ...(p.aliases ?? [])], query)
    .slice(0, MAX_PLACES)
    .map((place): SearchResult => ({ type: 'place', label: place.name, place }));
  const entityResults = rank(entities, (e) => [e.label, e.id], query)
    .slice(0, MAX_ENTITIES)
    .map((entity): SearchResult => ({ type: 'entity', label: entity.label, entity }));
  return [...entityResults, ...placeResults];
}
