import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveClient } from './live';

class FakeSocket {
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const event = {
  id: 'e1',
  source: 'polisen',
  category: 'Trafikolycka',
  severity: 'minor',
  title: 'Trafikolycka, Göteborg',
  locationPrecision: 'municipality',
  start: '2026-10-23T10:00:00+02:00',
};

describe('LiveClient', () => {
  let sockets: FakeSocket[];
  let client: LiveClient;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    client = new LiveClient('ws://test/ws', () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s as unknown as WebSocket;
    });
  });
  afterEach(() => {
    client.stop();
    vi.useRealTimers();
  });

  it('subscribes on open and applies snapshots and deltas', () => {
    client.setChannels(['events.police']);
    client.start();
    vi.advanceTimersByTime(0);
    const ws = sockets[0]!;
    ws.open();
    expect(ws.sent).toEqual([{ type: 'subscribe', channels: ['events.police'] }]);
    expect(client.getSnapshot().connection).toBe('open');

    ws.receive({ type: 'snapshot', channel: 'events.police', items: [event], ts: event.start });
    expect(client.items('events.police')).toEqual([event]);

    ws.receive({
      type: 'delta',
      channel: 'events.police',
      upsert: [{ ...event, id: 'e2' }],
      remove: ['e1'],
      ts: event.start,
    });
    expect(client.items('events.police').map((e) => e.id)).toEqual(['e2']);
  });

  it('ignores invalid messages and data for unsubscribed channels', () => {
    client.start();
    vi.advanceTimersByTime(0);
    const ws = sockets[0]!;
    ws.open();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const before = client.getSnapshot();
    ws.receive({ type: 'snapshot', channel: 'events.police', items: [event], ts: event.start });
    ws.receive({ type: 'nonsense' });
    expect(client.items('events.police')).toEqual([]);
    expect(client.getSnapshot()).toBe(before);
    warn.mockRestore();
  });

  it('unsubscribes and drops data for removed channels', () => {
    client.setChannels(['events.police']);
    client.start();
    vi.advanceTimersByTime(0);
    const ws = sockets[0]!;
    ws.open();
    ws.receive({ type: 'snapshot', channel: 'events.police', items: [event], ts: event.start });
    client.setChannels([]);
    expect(ws.sent.at(-1)).toEqual({ type: 'unsubscribe', channels: ['events.police'] });
    expect(client.items('events.police')).toEqual([]);
  });

  it('reconnects with backoff and re-subscribes', () => {
    client.setChannels(['events.police']);
    client.start();
    vi.advanceTimersByTime(0);
    sockets[0]!.open();
    sockets[0]!.close();
    expect(client.getSnapshot().connection).toBe('closed');

    vi.advanceTimersByTime(1500);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(sockets[1]!.sent).toEqual([{ type: 'subscribe', channels: ['events.police'] }]);
  });

  it('does not connect or reconnect after stop', () => {
    client.start();
    client.stop();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(0);

    client.start();
    vi.advanceTimersByTime(0);
    client.stop();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });
});
