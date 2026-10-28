import { GOTHENBURG, type LonLat } from '@gbg-osint/shared';

const stockholmDate = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Calendar date in Gothenburg as `YYYY-MM-DD`. */
export function localDate(date: Date): string {
  return stockholmDate.format(date);
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Plain text from an HTML fragment: tags removed, common entities decoded, whitespace collapsed. */
export function toPlainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (match, code: string) => {
      if (code[0] === '#') {
        const n =
          code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
      }
      return ENTITIES[code.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function normalizeHeading(deg: number): number {
  const h = deg % 360;
  return h < 0 ? h + 360 : h;
}

/** `[lon, lat]` from a WKT point such as `POINT (11.97 57.70)`. */
export function parseWktPoint(wkt: string): [number, number] | undefined {
  const m = /^POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)$/i.exec(wkt.trim());
  if (!m) return undefined;
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  return Math.abs(lon) <= 180 && Math.abs(lat) <= 90 ? [lon, lat] : undefined;
}

export function inGothenburgBbox(lon: number, lat: number): boolean {
  const { west, south, east, north } = GOTHENBURG.bbox;
  return lon >= west && lon <= east && lat >= south && lat <= north;
}

const toRad = Math.PI / 180;

/** Initial great-circle bearing in degrees from one point to another. */
export function bearing(from: { lon: number; lat: number }, to: { lon: number; lat: number }) {
  const dLon = (to.lon - from.lon) * toRad;
  const y = Math.sin(dLon) * Math.cos(to.lat * toRad);
  const x =
    Math.cos(from.lat * toRad) * Math.sin(to.lat * toRad) -
    Math.sin(from.lat * toRad) * Math.cos(to.lat * toRad) * Math.cos(dLon);
  return normalizeHeading(Math.atan2(y, x) / toRad);
}

export function distanceM(a: { lon: number; lat: number }, b: { lon: number; lat: number }) {
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** ISO time from any string `Date` can parse, or undefined. */
export function isoTime(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON = 111_320 * Math.cos(GOTHENBURG.center.lat * toRad);

/** Local planar metres around Gothenburg; accurate enough for city-scale geometry. */
export function toLocalM([lon, lat]: LonLat): [number, number] {
  return [
    (lon - GOTHENBURG.center.lon) * M_PER_DEG_LON,
    (lat - GOTHENBURG.center.lat) * M_PER_DEG_LAT,
  ];
}

export function fromLocalM([x, y]: readonly [number, number]): LonLat {
  return [GOTHENBURG.center.lon + x / M_PER_DEG_LON, GOTHENBURG.center.lat + y / M_PER_DEG_LAT];
}

export function lineLengthM(coords: readonly LonLat[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const [ax, ay] = toLocalM(coords[i - 1]!);
    const [bx, by] = toLocalM(coords[i]!);
    total += Math.hypot(bx - ax, by - ay);
  }
  return total;
}

/** Douglas–Peucker simplification with a tolerance in metres. */
export function simplifyLine(coords: readonly LonLat[], toleranceM: number): LonLat[] {
  if (coords.length <= 2) return [...coords];
  const pts = coords.map(toLocalM);
  const keep = new Uint8Array(coords.length);
  keep[0] = 1;
  keep[coords.length - 1] = 1;
  const stack: [number, number][] = [[0, coords.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    const [ax, ay] = pts[first]!;
    const [bx, by] = pts[last]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstDist = toleranceM;
    for (let i = first + 1; i < last; i++) {
      const [px, py] = pts[i]!;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > worstDist) {
        worst = i;
        worstDist = d;
      }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}
