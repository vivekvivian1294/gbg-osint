import { FlightRouteSchema, type FlightRoute } from '@gbg-osint/shared';
import { useEffect, useState } from 'react';
import { fetchJson } from './api';

const CALLSIGN = /^[A-Z0-9]{3,8}$/;
const MAX_CACHED = 500;
/** Routes looked up so far; `null` means adsbdb doesn't know the callsign. */
const cache = new Map<string, FlightRoute | null>();

/** Scheduled origin and destination for an aircraft callsign, fetched once per callsign. */
export function useFlightRoute(callsign: string | undefined): FlightRoute | null | undefined {
  const key = callsign?.trim().toUpperCase();
  const valid = key && CALLSIGN.test(key) ? key : undefined;
  const [result, setResult] = useState<{ key: string; route: FlightRoute | null } | null>(null);
  useEffect(() => {
    if (!valid || cache.has(valid)) return;
    const ctrl = new AbortController();
    fetchJson(`/api/data/adsbdb.routes/callsign/${valid}.json`, FlightRouteSchema, ctrl.signal)
      .then(
        (route) => ({ route, known: true }),
        (err: unknown) => ({
          route: null,
          known: err instanceof Error && err.message === 'HTTP 404',
        }),
      )
      .then(({ route, known }) => {
        if (ctrl.signal.aborted) return;
        if (known) {
          cache.set(valid, route);
          if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
        }
        setResult({ key: valid, route });
      });
    return () => ctrl.abort();
  }, [valid]);
  if (!valid) return undefined;
  if (cache.has(valid)) return cache.get(valid);
  return result?.key === valid ? result.route : undefined;
}
