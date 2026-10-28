import type { Entity } from '@gbg-osint/shared';
import { describe, expect, it } from 'vitest';
import { buildRoster, distanceKm, type Contact } from './contacts';

const entity = (
  id: string,
  lon: number,
  lat: number,
  kind: Entity['kind'] = 'aircraft',
): Entity => ({
  id,
  source: 'test',
  kind,
  lon,
  lat,
  ts: '2026-10-23T10:00:00Z',
});

const contact = (layerId: string, e: Entity): Contact => ({
  layerId,
  id: e.id,
  channel: 'c',
  entity: e,
  distanceKm: 0,
});

describe('distanceKm', () => {
  it('matches the known Centralen–Landvetter distance', () => {
    expect(distanceKm({ lon: 11.9733, lat: 57.7089 }, { lon: 12.2794, lat: 57.6628 })).toBeCloseTo(
      19.0,
      0,
    );
  });
});

describe('buildRoster', () => {
  it('puts the target first, then same-layer contacts within 25 km nearest first', () => {
    const target = contact('aircraft', entity('t', 11.97, 57.7));
    const roster = buildRoster(target, [
      target,
      contact('aircraft', entity('far', 13.0, 57.7)),
      contact('aircraft', entity('b', 11.99, 57.7)),
      contact('aircraft', entity('a', 11.975, 57.7)),
      contact('bikes', entity('bike', 11.971, 57.7, 'bike_station')),
    ]);
    expect(roster.map((c) => c.id)).toEqual(['t', 'a', 'b']);
    expect(roster[1]?.distanceKm).toBeGreaterThan(0);
  });

  it('includes every visible satellite regardless of distance', () => {
    const target = contact('satellites', entity('iss', 10, 60, 'satellite'));
    const roster = buildRoster(target, [
      contact('satellites', entity('other', 60, 20, 'satellite')),
    ]);
    expect(roster.map((c) => c.id)).toEqual(['iss', 'other']);
  });
});
