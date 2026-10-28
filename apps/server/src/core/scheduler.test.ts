import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OnDemandConnector, PollConnector } from './connector';
import { UpstreamError } from './http';
import { Scheduler } from './scheduler';
import { ChannelStore } from './store';

const log = Fastify({ logger: false }).log;

const validMetric = {
  id: 'm1',
  source: 'fake',
  name: 'Temp',
  unit: '°C',
  value: 7,
  ts: '2026-10-23T10:00:00Z',
};

function fakeConnector(overrides: Partial<PollConnector> = {}): PollConnector {
  return {
    id: 'fake',
    name: 'Fake source',
    licence: 'CC0',
    mode: 'poll',
    intervalMs: 60_000,
    allowedHosts: [],
    channels: [{ name: 'test.metrics', kind: 'metrics' }],
    poll: async (ctx) => ctx.publish.replace('test.metrics', [validMetric]),
    ...overrides,
  };
}

describe('Scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls, publishes and reports ok', async () => {
    const store = new ChannelStore();
    const scheduler = new Scheduler([fakeConnector()], { store, log, env: {}, userAgent: 't' });
    expect(scheduler.statuses()[0]?.state).toBe('idle');

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.snapshot('test.metrics')).toEqual([validMetric]);
    expect(scheduler.statuses()[0]).toMatchObject({ state: 'ok', consecutiveFailures: 0 });
    scheduler.stop();
  });

  it('drops items that fail validation', async () => {
    const store = new ChannelStore();
    const connector = fakeConnector({
      poll: async (ctx) =>
        ctx.publish.replace('test.metrics', [
          validMetric,
          { ...validMetric, id: 'm2', value: 'x' },
        ]),
    });
    const scheduler = new Scheduler([connector], { store, log, env: {}, userAgent: 't' });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.snapshot('test.metrics')).toEqual([validMetric]);
    scheduler.stop();
  });

  it('backs off on failure and only exposes safe error messages', async () => {
    const poll = vi
      .fn<PollConnector['poll']>()
      .mockRejectedValueOnce(new UpstreamError('HTTP 503 from api.example.se'))
      .mockRejectedValueOnce(new Error('secret internals'))
      .mockRejectedValueOnce(new Error('secret internals'))
      .mockResolvedValue(undefined);
    const scheduler = new Scheduler([fakeConnector({ poll })], {
      store: new ChannelStore(),
      log,
      env: {},
      userAgent: 't',
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.statuses()[0]).toMatchObject({
      state: 'down',
      lastError: 'HTTP 503 from api.example.se',
    });

    await vi.advanceTimersByTimeAsync(80_000);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(scheduler.statuses()[0]?.lastError).toBe('Connector error (see server logs)');

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(scheduler.statuses()[0]).toMatchObject({ state: 'ok', consecutiveFailures: 0 });
    scheduler.stop();
  });

  it('disables connectors with missing env and only passes declared env', async () => {
    const poll = vi.fn<PollConnector['poll']>(async () => undefined);
    const scheduler = new Scheduler(
      [
        fakeConnector({ id: 'needs-key', requiredEnv: ['API_KEY'], poll }),
        fakeConnector({
          id: 'has-key',
          channels: [{ name: 'test.other', kind: 'metrics' }],
          requiredEnv: ['OTHER_KEY'],
          poll,
        }),
      ],
      { store: new ChannelStore(), log, env: { OTHER_KEY: 'k', UNRELATED: 'x' }, userAgent: 't' },
    );
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    const [disabled, enabled] = scheduler.statuses();
    expect(disabled).toMatchObject({ state: 'disabled', missingEnv: ['API_KEY'] });
    expect(enabled?.state).toBe('ok');
    expect(poll).toHaveBeenCalledTimes(1);
    expect(poll.mock.calls[0]?.[0].env).toEqual({ OTHER_KEY: 'k' });
    scheduler.stop();
  });

  it('marks data as stale when polls stop succeeding in time', async () => {
    let now = 0;
    const scheduler = new Scheduler([fakeConnector()], {
      store: new ChannelStore(),
      log,
      env: {},
      userAgent: 't',
      now: () => now,
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    scheduler.stop();
    now = 4 * 60_000;
    expect(scheduler.statuses()[0]).toMatchObject({ state: 'degraded', reason: 'Data is stale' });
  });

  it('retries long-interval sources within minutes, not a full interval', async () => {
    const poll = vi
      .fn<PollConnector['poll']>()
      .mockRejectedValueOnce(new UpstreamError('HTTP 502 from overpass-api.de'))
      .mockResolvedValue(undefined);
    const scheduler = new Scheduler([fakeConnector({ intervalMs: 24 * 3600_000, poll })], {
      store: new ChannelStore(),
      log,
      env: {},
      userAgent: 't',
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(75_000);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(scheduler.statuses()[0]?.state).toBe('ok');
    scheduler.stop();
  });

  it('stays idle while the first poll is in flight', async () => {
    let finish: () => void = () => undefined;
    const poll = () => new Promise<void>((resolve) => (finish = resolve));
    const scheduler = new Scheduler([fakeConnector({ poll })], {
      store: new ChannelStore(),
      log,
      env: {},
      userAgent: 't',
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.statuses()[0]?.state).toBe('idle');
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.statuses()[0]?.state).toBe('ok');
    scheduler.stop();
  });

  it('rejects duplicate connector ids', () => {
    expect(
      () =>
        new Scheduler([fakeConnector(), fakeConnector()], {
          store: new ChannelStore(),
          log,
          env: {},
          userAgent: 't',
        }),
    ).toThrow(/Duplicate/);
  });

  it('serves on-demand files, sharing concurrent requests and tracking health', async () => {
    let resolve: (body: string) => void = () => undefined;
    const serve = vi
      .fn<OnDemandConnector['serve']>()
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = (body) => r({ type: 'text/plain', body, maxAgeSec: 60 });
          }),
      )
      .mockRejectedValueOnce(new UpstreamError('HTTP 500 from tiles.example'));
    const connector: OnDemandConnector = {
      id: 'tiles',
      name: 'Tiles',
      licence: 'CC0',
      mode: 'on-demand',
      allowedHosts: [],
      channels: [],
      serve,
    };
    const scheduler = new Scheduler([connector], {
      store: new ChannelStore(),
      log,
      env: {},
      userAgent: 't',
    });
    expect(await scheduler.serve('tiles', 'a.txt')).toBeUndefined();

    scheduler.start();
    expect(scheduler.statuses()[0]).toMatchObject({ mode: 'on-demand', state: 'idle' });
    const first = scheduler.serve('tiles', 'a.txt');
    const second = scheduler.serve('tiles', 'a.txt');
    await vi.advanceTimersByTimeAsync(0);
    resolve('hello');
    expect(await first).toEqual({ type: 'text/plain', body: 'hello', maxAgeSec: 60 });
    expect(await second).toBe(await first);
    expect(serve).toHaveBeenCalledTimes(1);
    expect(scheduler.statuses()[0]?.state).toBe('ok');

    await expect(scheduler.serve('tiles', 'b.txt')).rejects.toThrow(UpstreamError);
    expect(scheduler.statuses()[0]).toMatchObject({ state: 'degraded', consecutiveFailures: 1 });
    expect(await scheduler.serve('nope', 'a.txt')).toBeUndefined();
    scheduler.stop();
  });
});
