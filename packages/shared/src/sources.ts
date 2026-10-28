import { z } from 'zod';
import { HttpUrl, IsoTime } from './model';
import { ChannelName } from './protocol';

export const SourceState = z.enum(['idle', 'ok', 'degraded', 'down', 'disabled']);
export type SourceState = z.infer<typeof SourceState>;

export const SourceStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  mode: z.enum(['poll', 'stream', 'on-demand']),
  licence: z.string(),
  attribution: z.string().optional(),
  homepage: HttpUrl.optional(),
  state: SourceState,
  reason: z.string().optional(),
  lastSuccess: IsoTime.optional(),
  lastError: z.string().optional(),
  consecutiveFailures: z.number().int().nonnegative(),
  channels: z.array(ChannelName),
  /** Names (never values) of environment variables the source needs but lacks. */
  missingEnv: z.array(z.string()),
});
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

export const HealthSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  uptimeSec: z.number(),
  time: IsoTime,
});
export type Health = z.infer<typeof HealthSchema>;

export const PublicKey = z.string().regex(/^[\w-]{8,200}$/);

/** Keys that are public by design (used in browser tile URLs); restrict them by domain. */
export const ClientConfigSchema = z.object({ cartoKey: PublicKey.optional() });
export type ClientConfig = z.infer<typeof ClientConfigSchema>;
