import type { LonLat } from '@gbg-osint/shared';

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = Math.PI / 180;

export function distanceM([lon1, lat1]: LonLat, [lon2, lat2]: LonLat): number {
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function pathLengthM(points: readonly LonLat[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distanceM(points[i - 1]!, points[i]!);
  return total;
}

/** Area of the closed polygon through the points (city-scale planar approximation). */
export function polygonAreaM2(points: readonly LonLat[]): number {
  if (points.length < 3) return 0;
  const lat0 = points.reduce((s, p) => s + p[1], 0) / points.length;
  const kx = EARTH_RADIUS_M * toRad * Math.cos(lat0 * toRad);
  const ky = EARTH_RADIUS_M * toRad;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i]!;
    const [bx, by] = points[(i + 1) % points.length]!;
    sum += ax * kx * (by * ky) - bx * kx * (ay * ky);
  }
  return Math.abs(sum) / 2;
}

const sv = (v: number, digits: number) =>
  v.toLocaleString('sv-SE', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${sv(m / 1000, m < 10_000 ? 2 : 1)} km`;
}

export function formatArea(m2: number): string {
  return m2 < 100_000 ? `${sv(Math.round(m2), 0)} m²` : `${sv(m2 / 1e6, 2)} km²`;
}

export function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
