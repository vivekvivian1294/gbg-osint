import { IonToken, PublicKey } from '@gbg-osint/shared';
import { existsSync } from 'node:fs';
import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Comma-separated proxy addresses/subnets to trust, e.g. `loopback,uniquelocal`. Empty = none. */
  TRUST_PROXY: z
    .string()
    .regex(/^[\w.:/, -]*$/)
    .default(''),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  WS_MAX_CONNECTIONS_PER_IP: z.coerce.number().int().positive().default(10),
  UPSTREAM_USER_AGENT: z.string().min(1).max(200).default('gbg-osint-dashboard/0.1'),
  /** Where connectors cache slow-changing upstream data. Defaults to the OS temp directory. */
  CACHE_DIR: z.string().min(1).optional(),
  /** CARTO basemap key; it is sent to the browser, so use a key restricted to CARTO basemaps. */
  CARTO_API_KEY: z.union([z.literal(''), PublicKey]).optional(),
  /** Cesium ion token for 3D terrain and buildings; it is sent to the browser like the CARTO key. */
  CESIUM_ION_ACCESS_TOKEN: z.union([z.literal(''), IonToken]).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Loads the repo-root .env in development; in containers env vars come from the runtime. */
export function loadDotEnv(path = new URL('../../../.env', import.meta.url)): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
