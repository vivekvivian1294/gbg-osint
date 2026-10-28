import type { Departure } from '@gbg-osint/shared';
import { z } from 'zod';
import type { ConnectorContext, PollConnector } from '../core/connector';
import { isoTime, localDate, truncate } from './util';

const HOST = 'api.swedavia.se';
const FLIGHTS = 'aviation.flights';
const BOARD = 'Göteborg Landvetter (GOT)';
/** The free FlightInfo tier allows 10 001 requests per 30 days; each poll costs 2–4. */
const INTERVAL_MS = 15 * 60_000;
const WINDOW_PAST_MS = 30 * 60_000;
const WINDOW_AHEAD_MS = 6 * 3600_000;
const CALLSIGN = /^[A-Z0-9]{3,8}$/;

type Direction = 'arrival' | 'departure';

const Time = z.object({
  scheduledUtc: z.string(),
  estimatedUtc: z.string().optional(),
  actualUtc: z.string().optional(),
});
const Flight = z.object({
  flightId: z.string().min(1).max(16),
  arrivalAirportEnglish: z.string().optional(),
  departureAirportEnglish: z.string().optional(),
  airlineOperator: z.object({ name: z.string().optional() }).optional(),
  arrivalTime: Time.optional(),
  departureTime: Time.optional(),
  locationAndStatus: z
    .object({
      terminal: z.string().optional(),
      gate: z.string().optional(),
      flightLegStatus: z.string().optional(),
      flightLegStatusEnglish: z.string().optional(),
    })
    .optional(),
  flightLegIdentifier: z
    .object({
      callsign: z.string().optional(),
      flightDepartureDateUtc: z.string().optional(),
    })
    .optional(),
  remarksEnglish: z.array(z.object({ text: z.string() })).optional(),
});
const FlightsResponse = z.object({ flights: z.array(z.unknown()) });

export function parseFlights(raw: unknown, direction: Direction, now: number): Departure[] {
  const rows: Departure[] = [];
  for (const item of FlightsResponse.parse(raw).flights) {
    const parsed = Flight.safeParse(item);
    if (!parsed.success) continue;
    const f = parsed.data;
    const status = f.locationAndStatus;
    if (status?.flightLegStatus === 'DEL') continue;
    const time = direction === 'arrival' ? f.arrivalTime : f.departureTime;
    const planned = isoTime(time?.scheduledUtc);
    if (!planned) continue;
    const expected = isoTime(time?.actualUtc) ?? isoTime(time?.estimatedUtc);
    const at = Date.parse(expected ?? planned);
    if (at < now - WINDOW_PAST_MS || at > now + WINDOW_AHEAD_MS) continue;
    const place = direction === 'arrival' ? f.departureAirportEnglish : f.arrivalAirportEnglish;
    const callsign = f.flightLegIdentifier?.callsign?.trim().toUpperCase();
    const day = f.flightLegIdentifier?.flightDepartureDateUtc?.slice(0, 10) ?? planned.slice(0, 10);
    const remark = f.remarksEnglish?.[0]?.text ?? status?.flightLegStatusEnglish;
    const platform = status?.gate ?? status?.terminal;
    rows.push({
      id: `${direction === 'arrival' ? 'a' : 'd'}-${f.flightId}-${day}`,
      source: 'swedavia',
      board: BOARD,
      direction,
      mode: 'flight',
      line: f.flightId,
      ...(f.airlineOperator?.name && { operator: truncate(f.airlineOperator.name, 80) }),
      place: truncate(place ?? '–', 200),
      planned,
      ...(expected && { expected }),
      ...(platform && { platform: truncate(platform, 40) }),
      ...(remark && { status: truncate(remark, 160) }),
      cancelled: status?.flightLegStatus === 'CAN',
      ...(callsign && CALLSIGN.test(callsign) && { callsign }),
    });
  }
  return rows;
}

async function fetchBoard(
  ctx: ConnectorContext,
  direction: Direction,
  date: string,
): Promise<unknown> {
  const cacheKey = `${direction}-${date}`;
  const cached = await ctx.cache.get<unknown>(cacheKey, INTERVAL_MS - 30_000);
  if (cached) return cached.value;
  const raw = await ctx.http.getJson(
    `https://${HOST}/flightinfo/v2/GOT/${direction === 'arrival' ? 'arrivals' : 'departures'}/${date}`,
    {
      headers: { 'Ocp-Apim-Subscription-Key': ctx.env.SWEDAVIA_FLIGHTINFO_KEY ?? '' },
      maxBytes: 5 * 1024 * 1024,
    },
  );
  await ctx.cache.set(cacheKey, raw);
  return raw;
}

export const swedaviaFlights: PollConnector = {
  id: 'swedavia.flights',
  name: 'Swedavia – Landvetter flights',
  licence: 'Swedavia API terms of use',
  attribution: 'Swedavia',
  homepage: 'https://apideveloper.swedavia.se/',
  mode: 'poll',
  intervalMs: INTERVAL_MS,
  allowedHosts: [HOST],
  requiredEnv: ['SWEDAVIA_FLIGHTINFO_KEY'],
  channels: [{ name: FLIGHTS, kind: 'departures' }],
  async poll(ctx) {
    const now = Date.now();
    const dates = [
      ...new Set([localDate(new Date(now)), localDate(new Date(now + WINDOW_AHEAD_MS))]),
    ];
    const rows: Departure[] = [];
    for (const date of dates) {
      for (const direction of ['departure', 'arrival'] as const) {
        rows.push(...parseFlights(await fetchBoard(ctx, direction, date), direction, now));
      }
    }
    ctx.publish.replace(FLIGHTS, rows);
  },
};
