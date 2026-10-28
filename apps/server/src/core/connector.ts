import type { ChannelKind } from '@gbg-osint/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { ConnectorCache } from './cache';
import type { HttpClient } from './http';

export interface ChannelDef {
  name: string;
  kind: ChannelKind;
}

/** Items are validated against the channel's schema; invalid items are dropped and logged. */
export interface Publisher {
  replace(channel: string, items: readonly unknown[]): void;
  apply(channel: string, upsert: readonly unknown[], remove?: readonly string[]): void;
}

export interface ConnectorContext {
  http: HttpClient;
  publish: Publisher;
  cache: ConnectorCache;
  log: FastifyBaseLogger;
  /** Only the variables listed in `requiredEnv` / `optionalEnv`. */
  env: Readonly<Record<string, string>>;
  signal: AbortSignal;
  /** Stream connectors report their own health; poll connectors are tracked automatically. */
  health: { ok(): void; fail(err: unknown): void };
}

/** A derived file (radar frame, building tile, photo) served under `/api/data/<id>/<path>`. */
export interface ServedFile {
  type: string;
  body: Buffer | string;
  maxAgeSec: number;
}

interface ConnectorBase {
  id: string;
  name: string;
  licence: string;
  attribution?: string;
  homepage?: string;
  allowedHosts: readonly string[];
  requiredEnv?: readonly string[];
  optionalEnv?: readonly string[];
  channels: readonly ChannelDef[];
  /** `path` comes from the browser: validate it strictly. Unknown paths return undefined. */
  serve?(ctx: ConnectorContext, path: string): Promise<ServedFile | undefined>;
}

export interface PollConnector extends ConnectorBase {
  mode: 'poll';
  intervalMs: number;
  poll(ctx: ConnectorContext): Promise<void>;
}

export interface StreamConnector extends ConnectorBase {
  mode: 'stream';
  /** Runs until the stream ends or `ctx.signal` aborts; the runtime reconnects with backoff. */
  run(ctx: ConnectorContext): Promise<void>;
}

/** Fetches upstream only when a browser asks for a file; results should be cached. */
export interface OnDemandConnector extends ConnectorBase {
  mode: 'on-demand';
  serve(ctx: ConnectorContext, path: string): Promise<ServedFile | undefined>;
}

export type Connector = PollConnector | StreamConnector | OnDemandConnector;
