import { decodeLine, RouteSchema, type LonLat, type Route } from '@gbg-osint/shared';
import { useEffect, useMemo, useState } from 'react';
import type { Drawing } from '../engine/tools';
import { formatArea, formatDistance, pathLengthM, polygonAreaM2 } from '../layers/measure';
import { fetchJson } from './api';

export type ToolMode = 'measure' | 'pin' | 'route';
export type RouteProfile = Route['profile'];

const PINS_KEY = 'gbg-osint:pins';
const MAX_PINS = 50;
const MAX_MEASURE_POINTS = 200;

function loadPins(): LonLat[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PINS_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (p): p is LonLat =>
          Array.isArray(p) &&
          p.length === 2 &&
          p.every((v) => typeof v === 'number' && Number.isFinite(v)),
      )
      .slice(0, MAX_PINS);
  } catch {
    return [];
  }
}

function savePins(pins: readonly LonLat[]): void {
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(pins));
  } catch {
    // Storage may be unavailable (private mode); pins then last for this visit only.
  }
}

/** Path served by the routing connector; coordinates are rounded to ~1 m. */
export function routePath(profile: RouteProfile, [a, b]: readonly [LonLat, LonLat]): string {
  const c = (v: number) => v.toFixed(5);
  return `/api/data/osrm.routes/route/${profile}/${c(a[0])}/${c(a[1])}/${c(b[0])}/${c(b[1])}.json`;
}

export interface ToolsApi {
  mode: ToolMode | null;
  setMode(mode: ToolMode | null): void;
  click(point: LonLat): void;
  measure: readonly LonLat[];
  pins: readonly LonLat[];
  routeEnds: readonly LonLat[];
  profile: RouteProfile;
  setProfile(profile: RouteProfile): void;
  route: { result: Route | null; error: string | null; loading: boolean };
  clear(what: ToolMode): void;
  drawing: Drawing;
}

export function useTools(): ToolsApi {
  const [mode, setMode] = useState<ToolMode | null>(null);
  const [measure, setMeasure] = useState<LonLat[]>([]);
  const [pins, setPins] = useState<LonLat[]>(loadPins);
  const [routeEnds, setRouteEnds] = useState<LonLat[]>([]);
  const [profile, setProfile] = useState<RouteProfile>('bike');
  const [route, setRoute] = useState<ToolsApi['route']>({
    result: null,
    error: null,
    loading: false,
  });

  const [a, b] = routeEnds;
  const request = a && b ? routePath(profile, [a, b]) : null;
  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    fetchJson(request, RouteSchema, controller.signal).then(
      (result) => setRoute({ result, error: null, loading: false }),
      () => {
        if (!controller.signal.aborted) {
          setRoute({ result: null, error: 'No route found between these points', loading: false });
        }
      },
    );
    return () => controller.abort();
  }, [request]);

  const click = (p: LonLat) => {
    if (mode === 'measure') setMeasure((m) => [...m, p].slice(-MAX_MEASURE_POINTS));
    else if (mode === 'pin') {
      setPins((prev) => {
        const next = [...prev, p].slice(-MAX_PINS);
        savePins(next);
        return next;
      });
    } else if (mode === 'route') {
      const next = routeEnds.length >= 2 ? [p] : [...routeEnds, p];
      setRouteEnds(next);
      setRoute({ result: null, error: null, loading: next.length === 2 });
    }
  };

  const clear = (what: ToolMode) => {
    if (what === 'measure') setMeasure([]);
    else if (what === 'pin') {
      setPins([]);
      savePins([]);
    } else {
      setRouteEnds([]);
      setRoute({ result: null, error: null, loading: false });
    }
  };

  const drawing = useMemo((): Drawing => {
    const length = pathLengthM(measure);
    const area = polygonAreaM2(measure);
    const measureLabel =
      measure.length < 2
        ? ''
        : `${formatDistance(length)}${measure.length >= 3 ? ` · ${formatArea(area)}` : ''}`;
    return {
      measure,
      measureLabel,
      pins,
      routeEnds,
      routeLine: request && route.result ? decodeLine(route.result.line) : [],
    };
  }, [measure, pins, routeEnds, request, route.result]);

  return {
    mode,
    setMode,
    click,
    measure,
    pins,
    routeEnds,
    profile,
    setProfile: (p) => {
      setProfile(p);
      if (routeEnds.length === 2) setRoute({ result: null, error: null, loading: true });
    },
    route,
    clear,
    drawing,
  };
}
