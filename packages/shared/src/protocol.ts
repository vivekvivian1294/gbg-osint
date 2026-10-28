import { z } from 'zod';
import { ChannelItemSchema, ChannelKind, IsoTime } from './model';

/** Dot-separated, lower-case channel names such as `events.police` or `transit.vehicles`. */
export const ChannelName = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:\.[a-z0-9_-]+)+$/);

export const ChannelInfoSchema = z.object({
  name: ChannelName,
  kind: ChannelKind,
  sourceId: z.string(),
});
export type ChannelInfo = z.infer<typeof ChannelInfoSchema>;

export const MAX_SUBSCRIPTIONS = 50;

export const ClientMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('subscribe'),
    channels: z.array(ChannelName).min(1).max(MAX_SUBSCRIPTIONS),
  }),
  z.object({
    type: z.literal('unsubscribe'),
    channels: z.array(ChannelName).min(1).max(MAX_SUBSCRIPTIONS),
  }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const ServerMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot'),
    channel: ChannelName,
    items: z.array(ChannelItemSchema),
    ts: IsoTime,
  }),
  z.object({
    type: z.literal('delta'),
    channel: ChannelName,
    upsert: z.array(ChannelItemSchema),
    remove: z.array(z.string()),
    ts: IsoTime,
  }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
  z.object({ type: z.literal('pong') }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
