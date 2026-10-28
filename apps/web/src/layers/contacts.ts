import { isEntity, type ChannelItem, type Entity } from '@gbg-osint/shared';
import type { LayerDef } from './registry';
import { ENTITY_STYLES } from './markers';

export interface TrackRef {
  layerId: string;
  id: string;
}

export interface Contact extends TrackRef {
  channel: string;
  entity: Entity;
  distanceKm: number;
}

const EARTH_RADIUS_KM = 6371;
const MAX_CONTACTS = 25;

export function distanceKm(
  a: { lon: number; lat: number },
  b: { lon: number; lat: number },
): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Search radius around a target; every satellite above the horizon counts as nearby. */
export function contactRadiusKm(target: Entity): number {
  return target.kind === 'satellite' ? Infinity : 25;
}

/** Trackable entities from the active layers. */
export function trackableEntities(
  layers: readonly LayerDef[],
  itemsOf: (channel: string) => ChannelItem[],
): Contact[] {
  const result: Contact[] = [];
  for (const layer of layers) {
    if (ENTITY_STYLES[layer.id]?.trackRange === undefined) continue;
    for (const channel of layer.channels) {
      for (const item of itemsOf(channel)) {
        if (isEntity(item)) {
          result.push({ layerId: layer.id, id: item.id, channel, entity: item, distanceKm: 0 });
        }
      }
    }
  }
  return result;
}

/** The target first, then same-layer entities within the contact radius, nearest first. */
export function buildRoster(target: Contact, candidates: readonly Contact[]): Contact[] {
  const radius = contactRadiusKm(target.entity);
  const nearby = candidates
    .filter((c) => c.layerId === target.layerId && c.id !== target.id)
    .map((c) => ({ ...c, distanceKm: distanceKm(target.entity, c.entity) }))
    .filter((c) => c.distanceKm <= radius)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, MAX_CONTACTS);
  return [{ ...target, distanceKm: 0 }, ...nearby];
}
