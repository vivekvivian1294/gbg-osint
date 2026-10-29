import { z } from 'zod';
import { EntitySchema, EventSchema, HttpUrl } from './model';

const Channel = z.string().min(1).max(64);
const Metres = z.number().nonnegative();

/** "What's here?" for a point, from the server's live data. */
export const SpotReportSchema = z.object({
  lon: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
  /** The statistical district (SCB RegSO) the point lies in. */
  district: z
    .object({
      channel: Channel,
      id: z.string().min(1).max(128),
      label: z.string().min(1).max(200),
      props: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  /** Events with a precise location within 500 m, nearest first. */
  events: z.array(z.object({ channel: Channel, distanceM: Metres, event: EventSchema })).max(20),
  /** The nearest road cameras within 5 km. */
  cameras: z.array(z.object({ channel: Channel, distanceM: Metres, entity: EntitySchema })).max(3),
});
export type SpotReport = z.infer<typeof SpotReportSchema>;

/** Wikipedia articles near a point (geosearch), nearest first. */
export const WikiNearbySchema = z.object({
  articles: z
    .array(z.object({ title: z.string().min(1).max(300), url: HttpUrl, distanceM: Metres }))
    .max(20),
});
export type WikiNearby = z.infer<typeof WikiNearbySchema>;
