import {
  BriefSchema,
  SeriesSchema,
  TrackSchema,
  type Brief,
  type Series,
  type Track,
} from '@gbg-osint/shared';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { fetchJson } from './api';

const BRIEF_REFRESH_MS = 60_000;
const SERIES_REFRESH_MS = 5 * 60_000;
const TRACK_REFRESH_MS = 60_000;
const SeriesList = z.object({ series: z.array(SeriesSchema) });

/** Periodically refreshed JSON from the server while `url` is set. */
function usePolled<T>(url: string | null, schema: z.ZodType<T>, intervalMs: number) {
  const [state, setState] = useState<{ url: string; value: T } | null>(null);
  useEffect(() => {
    if (!url) return;
    const ctrl = new AbortController();
    const load = () =>
      fetchJson(url, schema, ctrl.signal).then(
        (value) => setState({ url, value }),
        () => undefined,
      );
    void load();
    const timer = setInterval(() => void load(), intervalMs);
    return () => {
      clearInterval(timer);
      ctrl.abort();
    };
  }, [url, schema, intervalMs]);
  return state && state.url === url ? state.value : undefined;
}

/** The "Now in Gothenburg" brief, refreshed every minute while shown. */
export function useBrief(active: boolean): Brief | undefined {
  return usePolled(active ? '/api/brief' : null, BriefSchema, BRIEF_REFRESH_MS);
}

/** 24-hour series under key prefixes, e.g. `env.weather/` or `env.harbour/viva-101/`. */
export function useSeries(prefixes: readonly string[] | null): readonly Series[] {
  const key = prefixes && prefixes.length > 0 ? prefixes.join('|') : null;
  const [state, setState] = useState<{ key: string; series: Series[] } | null>(null);
  useEffect(() => {
    if (!key) return;
    const ctrl = new AbortController();
    const load = () =>
      Promise.all(
        key.split('|').map((prefix) =>
          fetchJson(
            `/api/history/series?prefix=${encodeURIComponent(prefix)}`,
            SeriesList,
            ctrl.signal,
          ).then(
            (r) => r.series,
            () => [],
          ),
        ),
      ).then((lists) => {
        if (!ctrl.signal.aborted) setState({ key, series: lists.flat() });
      });
    void load();
    const timer = setInterval(() => void load(), SERIES_REFRESH_MS);
    return () => {
      clearInterval(timer);
      ctrl.abort();
    };
  }, [key]);
  return state && state.key === key ? state.series : [];
}

/** Where a ship, aircraft or train has been in the last 24 hours. */
export function useTrack(channel: string | null, id: string | null): Track | undefined {
  const url =
    channel && id
      ? `/api/history/track/${encodeURIComponent(channel)}/${encodeURIComponent(id)}`
      : null;
  return usePolled(url, TrackSchema, TRACK_REFRESH_MS);
}
