import { ServerMessage, type ChannelItem, type ClientMessage } from '@gbg-osint/shared';

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface LiveSnapshot {
  version: number;
  connection: ConnectionState;
}

const OPEN = 1;
const MAX_RETRY_MS = 30_000;

/**
 * Single WebSocket to the server: keeps the desired channel subscriptions, reconnects with
 * backoff and holds the latest items per channel. Exposes a `useSyncExternalStore` interface.
 */
export class LiveClient {
  private ws: WebSocket | null = null;
  private readonly desired = new Set<string>();
  private readonly data = new Map<string, Map<string, ChannelItem>>();
  private readonly versions = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private snapshot: LiveSnapshot = { version: 0, connection: 'closed' };

  constructor(
    private readonly url: string,
    private readonly createSocket: (url: string) => WebSocket = (u) => new WebSocket(u),
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // Deferred so an immediate stop() (React StrictMode) never opens a socket.
    this.retryTimer = setTimeout(() => this.connect(), 0);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setConnection('closed');
  }

  setChannels(channels: Iterable<string>): void {
    const next = new Set(channels);
    const added = [...next].filter((c) => !this.desired.has(c));
    const removed = [...this.desired].filter((c) => !next.has(c));
    for (const c of removed) {
      this.desired.delete(c);
      this.data.delete(c);
      this.versions.set(c, this.version(c) + 1);
    }
    for (const c of added) this.desired.add(c);
    if (removed.length > 0) {
      this.send({ type: 'unsubscribe', channels: removed });
      this.bump();
    }
    if (added.length > 0) this.send({ type: 'subscribe', channels: added });
  }

  items(channel: string): ChannelItem[] {
    return [...(this.data.get(channel)?.values() ?? [])];
  }

  /** Increments whenever the channel's items change. */
  version(channel: string): number {
    return this.versions.get(channel) ?? 0;
  }

  readonly getSnapshot = (): LiveSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private connect(): void {
    this.setConnection('connecting');
    const ws = this.createSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      this.setConnection('open');
      if (this.desired.size > 0) this.send({ type: 'subscribe', channels: [...this.desired] });
    };
    ws.onmessage = (event: MessageEvent) => this.onMessage(event.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setConnection('closed');
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    const base = Math.min(MAX_RETRY_MS, 1000 * 2 ** this.retries);
    this.retries++;
    this.retryTimer = setTimeout(() => this.connect(), base * (0.8 + Math.random() * 0.4));
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = ServerMessage.safeParse(json);
    if (!parsed.success) {
      console.warn('Ignoring invalid message from server');
      return;
    }
    const msg = parsed.data;
    switch (msg.type) {
      case 'snapshot':
        if (!this.desired.has(msg.channel)) return;
        this.data.set(msg.channel, new Map(msg.items.map((item) => [item.id, item])));
        break;
      case 'delta': {
        const channel = this.data.get(msg.channel);
        if (!channel) return;
        for (const item of msg.upsert) channel.set(item.id, item);
        for (const id of msg.remove) channel.delete(id);
        break;
      }
      case 'error':
        console.warn(`Server: ${msg.message}`);
        return;
      case 'pong':
        return;
    }
    this.versions.set(msg.channel, this.version(msg.channel) + 1);
    this.bump();
  }

  private bump(): void {
    this.snapshot = { ...this.snapshot, version: this.snapshot.version + 1 };
    this.emit();
  }

  private setConnection(connection: ConnectionState): void {
    if (this.snapshot.connection === connection) return;
    this.snapshot = { ...this.snapshot, connection };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
