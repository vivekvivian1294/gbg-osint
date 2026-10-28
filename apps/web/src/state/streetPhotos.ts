import { PhotoTileSchema, type Entity } from '@gbg-osint/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CameraState } from '../engine/cameraState';
import { tilesAround } from '../engine/tiles';
import { fetchJson } from './api';

const ZOOM = 15;
const MAX_CAMERA_HEIGHT_M = 4_000;
const MAX_TILES = 16;
const MAX_PHOTOS = 400;
const RETRY_AFTER_MS = 60_000;

/** Tile keys (`x/y` at z15) to load around a camera; none when zoomed out. */
export function photoTilesFor(camera: CameraState): string[] {
  if (camera.height > MAX_CAMERA_HEIGHT_M) return [];
  const radius = Math.min(1_500, Math.max(600, camera.height * 1.5));
  return tilesAround(camera.lon, camera.lat, radius, ZOOM, MAX_TILES).map((t) => `${t.x}/${t.y}`);
}

/** Street-level photos near the camera, fetched per tile from the server while enabled. */
export function useStreetPhotos(enabled: boolean, camera: CameraState): readonly Entity[] {
  const [tiles, setTiles] = useState<ReadonlyMap<string, readonly Entity[]>>(() => new Map());
  const pending = useRef(new Set<string>());
  const failedAt = useRef(new Map<string, number>());
  const wanted = useMemo(() => (enabled ? photoTilesFor(camera) : []), [enabled, camera]);

  useEffect(() => {
    const now = Date.now();
    for (const key of wanted) {
      if (tiles.has(key) || pending.current.has(key)) continue;
      if (now - (failedAt.current.get(key) ?? -Infinity) < RETRY_AFTER_MS) continue;
      pending.current.add(key);
      fetchJson(`/api/data/streetphotos/tiles/${key}.json`, PhotoTileSchema)
        .then((tile) => setTiles((prev) => new Map(prev).set(key, tile.items)))
        .catch(() => failedAt.current.set(key, Date.now()))
        .finally(() => pending.current.delete(key));
    }
  }, [wanted, tiles]);

  return useMemo(
    () => wanted.flatMap((key) => tiles.get(key) ?? []).slice(0, MAX_PHOTOS),
    [wanted, tiles],
  );
}
