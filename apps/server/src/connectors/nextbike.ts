import type { Entity } from '@gbg-osint/shared';
import { z } from 'zod';
import type { PollConnector } from '../core/connector';

const CHANNEL = 'mobility.bikes';
const FEED = 'https://gbfs.nextbike.net/maps/gbfs/v2/nextbike_zg/sv';
const INFO_MAX_AGE_MS = 60 * 60_000;

const StationInfo = z.object({
  data: z.object({
    stations: z.array(
      z.object({ station_id: z.string(), name: z.string(), lat: z.number(), lon: z.number() }),
    ),
  }),
});
const StationStatus = z.object({
  data: z.object({
    stations: z.array(
      z.object({
        station_id: z.string(),
        num_bikes_available: z.number(),
        num_docks_available: z.number().optional(),
        is_renting: z.boolean().optional(),
        last_reported: z.number(),
      }),
    ),
  }),
});

export function parseBikeStations(infoRaw: unknown, statusRaw: unknown): Entity[] {
  const info = new Map(StationInfo.parse(infoRaw).data.stations.map((s) => [s.station_id, s]));
  const entities: Entity[] = [];
  for (const s of StationStatus.parse(statusRaw).data.stations) {
    const station = info.get(s.station_id);
    if (!station) continue;
    entities.push({
      id: s.station_id,
      source: 'nextbike',
      kind: 'bike_station',
      lon: station.lon,
      lat: station.lat,
      label: station.name,
      ts: new Date(s.last_reported * 1000).toISOString(),
      props: {
        bikes: s.num_bikes_available,
        ...(s.num_docks_available !== undefined && { docks: s.num_docks_available }),
        renting: s.is_renting ?? true,
      },
    });
  }
  return entities;
}

let stationInfo: { raw: unknown; fetchedAt: number } | undefined;

export const styrOchStall: PollConnector = {
  id: 'nextbike.styrochstall',
  name: 'Styr & Ställ (nextbike GBFS)',
  licence: 'CC0 1.0',
  homepage: 'https://styrochstall.se/',
  mode: 'poll',
  intervalMs: 60_000,
  allowedHosts: ['gbfs.nextbike.net'],
  channels: [{ name: CHANNEL, kind: 'entities' }],
  async poll(ctx) {
    if (!stationInfo || Date.now() - stationInfo.fetchedAt > INFO_MAX_AGE_MS) {
      stationInfo = {
        raw: await ctx.http.getJson(`${FEED}/station_information.json`),
        fetchedAt: Date.now(),
      };
    }
    const status = await ctx.http.getJson(`${FEED}/station_status.json`);
    ctx.publish.replace(CHANNEL, parseBikeStations(stationInfo.raw, status));
  },
};
