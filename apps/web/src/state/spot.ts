import {
  flatDistanceM,
  PhotoTileSchema,
  SpotReportSchema,
  WikiNearbySchema,
  type Entity,
  type LonLat,
  type SpotReport,
} from '@gbg-osint/shared';
import { useEffect, useState } from 'react';
import { tilesAround } from '../engine/tiles';
import { fetchJson } from './api';

const PHOTO_ZOOM = 15;
const PHOTO_RADIUS_M = 250;
const MAX_PHOTOS = 4;
const MAX_ARTICLES = 4;
const WIKI_LANGS = ['sv', 'en'] as const;

export interface WikiArticle {
  title: string;
  url: string;
  distanceM: number;
  lang: (typeof WIKI_LANGS)[number];
}

export interface SpotData {
  report?: SpotReport;
  /** Undefined while loading; empty when none were found or the lookup failed. */
  articles?: WikiArticle[];
  photos?: { entity: Entity; distanceM: number }[];
  failed?: boolean;
}

export const spotUrl = ([lon, lat]: LonLat) =>
  `/api/spot?lon=${lon.toFixed(6)}&lat=${lat.toFixed(6)}`;

/** Everything the "What's here?" card shows for a point; each part arrives on its own. */
export function useSpot(point: LonLat | null): SpotData {
  const key = point ? `${point[0].toFixed(6)},${point[1].toFixed(6)}` : null;
  const [state, setState] = useState<{ key: string; data: SpotData } | null>(null);
  useEffect(() => {
    if (!key) return;
    const [lon, lat] = key.split(',').map(Number) as LonLat;
    const ctrl = new AbortController();
    const merge = (part: SpotData) => {
      if (ctrl.signal.aborted) return;
      setState((prev) => ({ key, data: { ...(prev?.key === key ? prev.data : {}), ...part } }));
    };

    fetchJson(spotUrl([lon, lat]), SpotReportSchema, ctrl.signal).then(
      (report) => merge({ report }),
      () => merge({ failed: true }),
    );

    Promise.all(
      WIKI_LANGS.map((lang) =>
        fetchJson(
          `/api/data/wikipedia.nearby/nearby/${lang}/${lat.toFixed(3)}/${lon.toFixed(3)}.json`,
          WikiNearbySchema,
          ctrl.signal,
        ).then(
          (r) => r.articles.slice(0, MAX_ARTICLES).map((a) => ({ ...a, lang })),
          () => [],
        ),
      ),
    ).then((lists) => merge({ articles: lists.flat() }));

    Promise.all(
      tilesAround(lon, lat, PHOTO_RADIUS_M, PHOTO_ZOOM, 4).map((t) =>
        fetchJson(`/api/data/streetphotos/tiles/${t.x}/${t.y}.json`, PhotoTileSchema, ctrl.signal)
          .then((tile) => tile.items)
          .catch(() => []),
      ),
    ).then((tiles) =>
      merge({
        photos: tiles
          .flat()
          .map((entity) => ({
            entity,
            distanceM: flatDistanceM([lon, lat], [entity.lon, entity.lat]),
          }))
          .filter((p) => p.distanceM <= PHOTO_RADIUS_M)
          .sort((a, b) => a.distanceM - b.distanceM)
          .slice(0, MAX_PHOTOS),
      }),
    );

    return () => ctrl.abort();
  }, [key]);
  return state && state.key === key ? state.data : {};
}
