import { z } from 'zod';
import { EntitySchema } from './model';

/** Extruded building footprints for one web-mercator tile, in tile units (0…extent). */
export const BuildingTileSchema = z.object({
  z: z.number().int().min(0).max(22),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  extent: z.number().int().positive(),
  /** `[height, minHeight, polygons]`; each polygon is `[exterior, ...holes]` of flat x,y rings. */
  buildings: z.array(
    z.tuple([z.number(), z.number(), z.array(z.array(z.array(z.number()).min(6)).min(1))]),
  ),
});
export type BuildingTile = z.infer<typeof BuildingTileSchema>;
export type Building = BuildingTile['buildings'][number];

/** Street-level photos (entities of kind `photo`) for one tile. */
export const PhotoTileSchema = z.object({ items: z.array(EntitySchema).max(500) });
export type PhotoTile = z.infer<typeof PhotoTileSchema>;

const HttpsUrl = z.url({ protocol: /^https$/ });

/** Live radio streams for the radio panel; only HTTPS streams, so pages never mix content. */
export const RadioStationSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  provider: z.enum(['Sveriges Radio', 'Radio Browser']),
  stream: HttpsUrl,
  homepage: HttpsUrl.optional(),
  codec: z.string().max(16).optional(),
  bitrateKbps: z.number().int().nonnegative().max(1000).optional(),
});
export type RadioStation = z.infer<typeof RadioStationSchema>;
export const RadioListSchema = z.object({ stations: z.array(RadioStationSchema).max(100) });

/** A route between two points from the routing service, as an encoded polyline. */
export const RouteSchema = z.object({
  profile: z.enum(['foot', 'bike', 'car']),
  distanceM: z.number().nonnegative(),
  durationS: z.number().nonnegative(),
  line: z.string().min(2).max(200_000),
});
export type Route = z.infer<typeof RouteSchema>;
