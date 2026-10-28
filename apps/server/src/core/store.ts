import type { ChannelInfo, ChannelItem, ChannelKind } from '@gbg-osint/shared';

export interface Delta {
  channel: string;
  upsert: ChannelItem[];
  remove: string[];
  ts: string;
}

type Listener = (delta: Delta) => void;

interface Channel {
  kind: ChannelKind;
  sourceId: string;
  items: Map<string, { item: ChannelItem; hash: string }>;
}

/** Latest state per channel, plus change notifications for the realtime gateway. */
export class ChannelStore {
  private readonly channels = new Map<string, Channel>();
  private readonly listeners = new Set<Listener>();

  register(name: string, kind: ChannelKind, sourceId: string): void {
    if (this.channels.has(name)) throw new Error(`Channel already registered: ${name}`);
    this.channels.set(name, { kind, sourceId, items: new Map() });
  }

  has(name: string): boolean {
    return this.channels.has(name);
  }

  kindOf(name: string): ChannelKind | undefined {
    return this.channels.get(name)?.kind;
  }

  list(): ChannelInfo[] {
    return [...this.channels].map(([name, c]) => ({ name, kind: c.kind, sourceId: c.sourceId }));
  }

  snapshot(name: string): ChannelItem[] {
    return [...this.get(name).items.values()].map((e) => e.item);
  }

  /** Replaces the whole channel content (typical for polled sources) and emits only the changes. */
  replace(name: string, items: readonly ChannelItem[]): Delta | null {
    const channel = this.get(name);
    const next = new Map<string, { item: ChannelItem; hash: string }>();
    const upsert: ChannelItem[] = [];
    for (const item of items) {
      const hash = JSON.stringify(item);
      next.set(item.id, { item, hash });
      if (channel.items.get(item.id)?.hash !== hash) upsert.push(item);
    }
    const remove = [...channel.items.keys()].filter((id) => !next.has(id));
    channel.items = next;
    return this.emit(name, upsert, remove);
  }

  /** Applies incremental changes (typical for streamed sources). */
  apply(
    name: string,
    upsert: readonly ChannelItem[],
    remove: readonly string[] = [],
  ): Delta | null {
    const channel = this.get(name);
    const changed: ChannelItem[] = [];
    for (const item of upsert) {
      const hash = JSON.stringify(item);
      if (channel.items.get(item.id)?.hash === hash) continue;
      channel.items.set(item.id, { item, hash });
      changed.push(item);
    }
    const removed = remove.filter((id) => channel.items.delete(id));
    return this.emit(name, changed, removed);
  }

  onDelta(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private get(name: string): Channel {
    const channel = this.channels.get(name);
    if (!channel) throw new Error(`Unknown channel: ${name}`);
    return channel;
  }

  private emit(channel: string, upsert: ChannelItem[], remove: string[]): Delta | null {
    if (upsert.length === 0 && remove.length === 0) return null;
    const delta: Delta = { channel, upsert, remove, ts: new Date().toISOString() };
    for (const listener of this.listeners) listener(delta);
    return delta;
  }
}
