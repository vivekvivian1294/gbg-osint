import { ITEM_SCHEMAS, type ChannelItem, type SourceStatus } from '@gbg-osint/shared';
import type { FastifyBaseLogger } from 'fastify';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backoffDelay } from './backoff';
import { createDiskCache, type ConnectorCache } from './cache';
import type { Connector, ConnectorContext, Publisher, ServedFile } from './connector';
import { UpstreamError, createHttpClient } from './http';
import type { ChannelStore } from './store';

const DOWN_AFTER_FAILURES = 3;
const STALE_AFTER_INTERVALS = 3;
const MAX_RETRY_BASE_MS = 60_000;
const MAX_POLL_BACKOFF_MS = 30 * 60_000;
const STREAM_RETRY_BASE_MS = 5_000;
const STREAM_RETRY_MAX_MS = 5 * 60_000;
const MAX_CONCURRENT_SERVES = 6;
const MAX_QUEUED_SERVES = 200;

export interface RuntimeDeps {
  store: ChannelStore;
  log: FastifyBaseLogger;
  env: NodeJS.ProcessEnv;
  userAgent: string;
  cacheDir?: string;
  now?: () => number;
}

/** Runs one connector: scheduling, retries with backoff, validation and health tracking. */
export class ConnectorRuntime {
  private readonly log: FastifyBaseLogger;
  private readonly now: () => number;
  private readonly missingEnv: string[];
  private readonly env: Record<string, string>;
  private readonly cache: ConnectorCache;
  private abort = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private failures = 0;
  private lastSuccess: number | undefined;
  private lastError: string | undefined;
  private readonly inflight = new Map<string, Promise<ServedFile | undefined>>();
  private activeServes = 0;
  private readonly serveQueue: (() => void)[] = [];

  constructor(
    readonly connector: Connector,
    private readonly deps: RuntimeDeps,
  ) {
    this.log = deps.log.child({ connector: connector.id });
    this.now = deps.now ?? Date.now;
    this.missingEnv = (connector.requiredEnv ?? []).filter((k) => !deps.env[k]);
    this.env = Object.fromEntries(
      [...(connector.requiredEnv ?? []), ...(connector.optionalEnv ?? [])]
        .filter((k) => deps.env[k])
        .map((k) => [k, deps.env[k] as string]),
    );
    for (const ch of connector.channels) deps.store.register(ch.name, ch.kind, connector.id);
    this.cache = createDiskCache(deps.cacheDir ?? join(tmpdir(), 'gbg-osint-cache'), connector.id);
  }

  start(): void {
    if (this.running) return;
    if (this.missingEnv.length > 0) {
      this.log.warn({ missingEnv: this.missingEnv }, 'connector disabled: missing configuration');
      return;
    }
    this.running = true;
    this.abort = new AbortController();
    if (this.connector.mode === 'poll') void this.runPoll();
    else if (this.connector.mode === 'stream') void this.runStream();
  }

  /** Concurrent requests for the same path share one upstream fetch. */
  serve(path: string): Promise<ServedFile | undefined> {
    const c = this.connector;
    if (!c.serve || !this.running) return Promise.resolve(undefined);
    const pending = this.inflight.get(path);
    if (pending) return pending;
    if (this.serveQueue.length >= MAX_QUEUED_SERVES) {
      return Promise.reject(new UpstreamError('Too many pending requests'));
    }
    const task = this.withServeSlot(() => c.serve!(this.context(), path))
      .then(
        (file) => {
          if (c.mode === 'on-demand') this.markOk();
          return file;
        },
        (err: unknown) => {
          if (c.mode === 'on-demand' && this.running) this.markFailed(err);
          throw err;
        },
      )
      .finally(() => this.inflight.delete(path));
    this.inflight.set(path, task);
    return task;
  }

  private async withServeSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeServes >= MAX_CONCURRENT_SERVES) {
      await new Promise<void>((resolve) => this.serveQueue.push(resolve));
    }
    this.activeServes++;
    try {
      return await fn();
    } finally {
      this.activeServes--;
      this.serveQueue.shift()?.();
    }
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.abort.abort();
  }

  status(): SourceStatus {
    const c = this.connector;
    return {
      id: c.id,
      name: c.name,
      mode: c.mode,
      licence: c.licence,
      ...(c.attribution && { attribution: c.attribution }),
      ...(c.homepage && { homepage: c.homepage }),
      ...this.state(),
      ...(this.lastSuccess !== undefined && {
        lastSuccess: new Date(this.lastSuccess).toISOString(),
      }),
      ...(this.lastError && { lastError: this.lastError }),
      consecutiveFailures: this.failures,
      channels: c.channels.map((ch) => ch.name),
      missingEnv: this.missingEnv,
    };
  }

  private state(): Pick<SourceStatus, 'state' | 'reason'> {
    if (this.missingEnv.length > 0) {
      return { state: 'disabled', reason: `Missing configuration: ${this.missingEnv.join(', ')}` };
    }
    if (this.lastSuccess === undefined && this.failures === 0) return { state: 'idle' };
    if (this.failures >= DOWN_AFTER_FAILURES || (this.failures > 0 && !this.lastSuccess)) {
      return { state: 'down', reason: this.lastError };
    }
    if (this.failures > 0) return { state: 'degraded', reason: this.lastError };
    const c = this.connector;
    if (
      c.mode === 'poll' &&
      this.lastSuccess !== undefined &&
      this.now() - this.lastSuccess > c.intervalMs * STALE_AFTER_INTERVALS
    ) {
      return { state: 'degraded', reason: 'Data is stale' };
    }
    return { state: 'ok' };
  }

  private context(): ConnectorContext {
    return {
      http: createHttpClient({
        allowedHosts: this.connector.allowedHosts,
        userAgent: this.deps.userAgent,
        signal: this.abort.signal,
      }),
      publish: this.publisher(),
      cache: this.cache,
      log: this.log,
      env: this.env,
      signal: this.abort.signal,
      health: { ok: () => this.markOk(), fail: (err) => this.markFailed(err) },
    };
  }

  private publisher(): Publisher {
    const declared = new Map(this.connector.channels.map((ch) => [ch.name, ch.kind]));
    const validate = (channel: string, items: readonly unknown[]): ChannelItem[] => {
      const kind = declared.get(channel);
      if (!kind) throw new Error(`Connector ${this.connector.id} cannot publish to ${channel}`);
      const schema = ITEM_SCHEMAS[kind];
      const valid: ChannelItem[] = [];
      let dropped = 0;
      for (const item of items) {
        const parsed = schema.safeParse(item);
        if (parsed.success) valid.push(parsed.data);
        else dropped++;
      }
      if (dropped > 0) this.log.warn({ channel, dropped }, 'dropped invalid items');
      return valid;
    };
    return {
      replace: (channel, items) => {
        this.deps.store.replace(channel, validate(channel, items));
      },
      apply: (channel, upsert, remove = []) => {
        this.deps.store.apply(channel, validate(channel, upsert), remove);
      },
    };
  }

  private async runPoll(): Promise<void> {
    const c = this.connector;
    if (c.mode !== 'poll' || !this.running) return;
    let delay = c.intervalMs;
    try {
      await c.poll(this.context());
      this.markOk();
    } catch (err) {
      if (!this.running) return;
      this.markFailed(err);
      const base = Math.min(c.intervalMs, MAX_RETRY_BASE_MS);
      const maxMs = Math.min(Math.max(c.intervalMs * 8, base), MAX_POLL_BACKOFF_MS);
      delay = backoffDelay(this.failures, base, maxMs);
    }
    if (this.running) this.timer = setTimeout(() => void this.runPoll(), delay);
  }

  private async runStream(): Promise<void> {
    const c = this.connector;
    if (c.mode !== 'stream' || !this.running) return;
    try {
      await c.run(this.context());
      if (this.running) this.markFailed(new UpstreamError('Stream ended'));
    } catch (err) {
      if (this.running) this.markFailed(err);
    }
    if (!this.running) return;
    const delay = backoffDelay(this.failures, STREAM_RETRY_BASE_MS, STREAM_RETRY_MAX_MS);
    this.timer = setTimeout(() => void this.runStream(), delay);
  }

  private markOk(): void {
    this.failures = 0;
    this.lastError = undefined;
    this.lastSuccess = this.now();
  }

  private markFailed(err: unknown): void {
    this.failures++;
    this.lastError =
      err instanceof UpstreamError ? err.message : 'Connector error (see server logs)';
    this.log.error({ err, failures: this.failures }, 'connector run failed');
  }
}

export class Scheduler {
  private readonly runtimes: ConnectorRuntime[];

  constructor(connectors: readonly Connector[], deps: RuntimeDeps) {
    const ids = new Set<string>();
    for (const c of connectors) {
      if (ids.has(c.id)) throw new Error(`Duplicate connector id: ${c.id}`);
      ids.add(c.id);
    }
    this.runtimes = connectors.map((c) => new ConnectorRuntime(c, deps));
  }

  start(): void {
    for (const r of this.runtimes) r.start();
  }

  stop(): void {
    for (const r of this.runtimes) r.stop();
  }

  statuses(): SourceStatus[] {
    return this.runtimes.map((r) => r.status());
  }

  serve(connectorId: string, path: string): Promise<ServedFile | undefined> {
    const runtime = this.runtimes.find((r) => r.connector.id === connectorId);
    return runtime ? runtime.serve(path) : Promise.resolve(undefined);
  }
}
