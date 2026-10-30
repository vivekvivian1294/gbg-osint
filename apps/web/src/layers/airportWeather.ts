import type { Entity, FlightRoute } from '@gbg-osint/shared';
import { distanceKm } from './contacts';

export const METAR_CHANNEL = 'aviation.metar';

export type AirportRole = 'arrival' | 'departure' | 'nearest';

export interface AirportPick {
  metar: Entity;
  role: AirportRole;
  distanceKm: number;
}

/** The airport whose weather matters to an aircraft: where it lands, else where it left, else the nearest. */
export function pickAirport(
  aircraft: Entity,
  metars: readonly Entity[],
  route?: FlightRoute | null,
): AirportPick | undefined {
  const pick = (metar: Entity, role: AirportRole): AirportPick => ({
    metar,
    role,
    distanceKm: distanceKm(aircraft, metar),
  });
  const arrival = metars.find((m) => m.id === route?.destination.icao);
  if (arrival) return pick(arrival, 'arrival');
  const departure = metars.find((m) => m.id === route?.origin.icao);
  if (departure) return pick(departure, 'departure');
  return metars.map((m) => pick(m, 'nearest')).sort((a, b) => a.distanceKm - b.distanceKm)[0];
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function windText(props: Record<string, unknown>): string | undefined {
  const kt = num(props.windKt);
  if (kt === undefined) return undefined;
  if (kt === 0) return 'Calm';
  const dir = String(props.windDir ?? '');
  const from = /^\d{1,3}$/.test(dir) ? `${dir.padStart(3, '0')}°` : 'Variable';
  const gust = num(props.gustKt);
  return `${from} ${kt} kt${gust ? `, gusts ${gust} kt` : ''}`;
}

/** METAR visibility, given in statute miles; "6+" is how 9999 (10 km or more) arrives. */
export function visibilityText(sm: unknown): string | undefined {
  if (typeof sm !== 'string') return undefined;
  if (sm.endsWith('+')) return '10 km or more';
  const miles = Number(sm);
  if (sm === '' || !Number.isFinite(miles)) return undefined;
  const m = miles * 1609.344;
  return m >= 5000 ? `${Math.round(m / 1000)} km` : `${Math.round(m / 100) * 100} m`;
}
