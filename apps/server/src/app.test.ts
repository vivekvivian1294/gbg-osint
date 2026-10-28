import type { ServerMessage } from '@gbg-osint/shared';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { buildApp } from './app';
import { loadConfig } from './config';
import type { OnDemandConnector, PollConnector } from './core/connector';
import { UpstreamError } from './core/http';

const connector: PollConnector = {
  id: 'fake',
  name: 'Fake',
  licence: 'CC0',
  mode: 'poll',
  intervalMs: 60_000,
  allowedHosts: [],
  channels: [{ name: 'test.metrics', kind: 'metrics' }],
  poll: async () => undefined,
};

const files: OnDemandConnector = {
  id: 'files',
  name: 'Files',
  licence: 'CC0',
  mode: 'on-demand',
  allowedHosts: [],
  channels: [],
  async serve(_ctx, path) {
    if (path === 'down.png') throw new UpstreamError('HTTP 503 from secret.example');
    return path === 'tiles/1/2.json'
      ? { type: 'application/json', body: '{"ok":true}', maxAgeSec: 3600 }
      : undefined;
  },
};

const metric = {
  id: 'm1',
  source: 'fake',
  name: 'Temp',
  unit: '°C',
  value: 7,
  ts: '2026-10-23T10:00:00.000Z',
};

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup(env: Record<string, string> = {}, webRoot?: string) {
  const config = loadConfig({ LOG_LEVEL: 'silent', ...env });
  const built = await buildApp({
    config,
    connectors: [connector, files],
    env: {},
    ...(webRoot && { webRoot }),
  });
  await built.app.ready();
  built.scheduler.start();
  close = async () => {
    built.scheduler.stop();
    await built.app.close();
  };
  return built;
}

function nextMessage(ws: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve) =>
    ws.once('message', (data) => resolve(JSON.parse(String(data)) as ServerMessage)),
  );
}

describe('HTTP API', () => {
  it('serves health, sources and channels', async () => {
    const { app } = await setup();

    const health = await app.inject('/api/health');
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok' });
    expect(health.headers['x-content-type-options']).toBe('nosniff');

    const sources = await app.inject('/api/sources');
    expect(sources.json()).toEqual([
      expect.objectContaining({ id: 'fake', channels: ['test.metrics'] }),
      expect.objectContaining({ id: 'files', mode: 'on-demand', state: 'idle', channels: [] }),
    ]);

    const channels = await app.inject('/api/channels');
    expect(channels.json()).toEqual([{ name: 'test.metrics', kind: 'metrics', sourceId: 'fake' }]);
  });

  it('serves only browser-safe keys in the client config', async () => {
    expect((await (await setup()).app.inject('/api/client-config')).json()).toEqual({});
    await close?.();
    const { app } = await setup({ CARTO_API_KEY: 'cb1_test-key_123' });
    expect((await app.inject('/api/client-config')).json()).toEqual({
      cartoKey: 'cb1_test-key_123',
    });
    expect(() => loadConfig({ CARTO_API_KEY: 'bad key"><script>' })).toThrow();
  });

  it('serves snapshots and 404s unknown or malformed channels', async () => {
    const { app, store } = await setup();
    store.replace('test.metrics', [metric]);

    const ok = await app.inject('/api/channels/test.metrics/snapshot');
    expect(ok.json()).toMatchObject({ channel: 'test.metrics', items: [metric] });

    expect((await app.inject('/api/channels/nope.channel/snapshot')).statusCode).toBe(404);
    expect((await app.inject('/api/channels/..%2F..%2Fetc/snapshot')).statusCode).toBe(404);
    expect((await app.inject('/api/unknown')).json()).toEqual({ error: 'Not Found' });
  });

  it('rate limits per client', async () => {
    const { app } = await setup({ RATE_LIMIT_PER_MINUTE: '2' });
    await app.inject('/api/health');
    await app.inject('/api/health');
    expect((await app.inject('/api/health')).statusCode).toBe(429);
  });

  it('serves connector files and rejects unknown or unsafe paths', async () => {
    const { app } = await setup();
    const ok = await app.inject('/api/data/files/tiles/1/2.json');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect(ok.headers['cache-control']).toBe('public, max-age=3600');

    for (const path of [
      '/api/data/files/tiles/1/3.json',
      '/api/data/nope/tiles/1/2.json',
      '/api/data/files/..%2F..%2Fetc%2Fpasswd',
      '/api/data/files/tiles/../1/2.json',
      '/api/data/files/.hidden',
    ]) {
      expect((await app.inject(path)).statusCode, path).toBe(404);
    }
    const down = await app.inject('/api/data/files/down.png');
    expect(down.statusCode).toBe(502);
    expect(down.body).not.toContain('secret');
  });
});

describe('web app', () => {
  const root = mkdtempSync(join(tmpdir(), 'gbg-web-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>GBG</title>');
  writeFileSync(join(root, 'assets', 'app-abc123.js'), 'console.log(1)');
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('is served by the same process, with a strict CSP', async () => {
    const { app, servesWeb } = await setup({}, root);
    expect(servesWeb).toBe(true);
    const page = await app.inject('/');
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<title>GBG</title>');
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('upgrade-insecure-requests');
    expect(page.headers['strict-transport-security']).toBeUndefined();
    expect(page.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(page.headers['permissions-policy']).toContain('camera=()');

    const asset = await app.inject('/assets/app-abc123.js');
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await app.inject('/missing.js')).json()).toEqual({ error: 'Not Found' });
    expect((await app.inject('/api/health')).json()).toMatchObject({ status: 'ok' });
  });

  it("doesn't rate limit the app's own files", async () => {
    const { app } = await setup({ RATE_LIMIT_PER_MINUTE: '2' }, root);
    for (let i = 0; i < 5; i++) expect((await app.inject('/')).statusCode).toBe(200);
    await app.inject('/api/health');
    await app.inject('/api/health');
    expect((await app.inject('/api/health')).statusCode).toBe(429);
  });

  it('runs API-only when the web app is not built', async () => {
    const { app, servesWeb } = await setup({}, join(root, 'nope'));
    expect(servesWeb).toBe(false);
    expect((await app.inject('/')).statusCode).toBe(404);
  });
});

describe('WebSocket gateway', () => {
  it('sends a snapshot on subscribe and deltas afterwards', async () => {
    const { app, store } = await setup();
    store.replace('test.metrics', [metric]);
    const ws = await app.injectWS('/ws');

    const snapshot = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'subscribe', channels: ['test.metrics'] }));
    expect(await snapshot).toMatchObject({ type: 'snapshot', items: [metric] });

    const delta = nextMessage(ws);
    store.replace('test.metrics', [{ ...metric, value: 8 }]);
    expect(await delta).toMatchObject({ type: 'delta', upsert: [{ value: 8 }], remove: [] });
    ws.terminate();
  });

  it('rejects unknown channels and invalid messages', async () => {
    const { app } = await setup();
    const ws = await app.injectWS('/ws');

    let reply = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'subscribe', channels: ['nope.channel'] }));
    expect(await reply).toMatchObject({ type: 'error', code: 'unknown_channel' });

    reply = nextMessage(ws);
    ws.send('not json');
    expect(await reply).toMatchObject({ type: 'error', code: 'invalid_json' });

    reply = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'subscribe', channels: ['../etc'] }));
    expect(await reply).toMatchObject({ type: 'error', code: 'invalid_message' });
    ws.terminate();
  });

  it('limits connections per IP', async () => {
    const { app } = await setup({ WS_MAX_CONNECTIONS_PER_IP: '1' });
    const first = await app.injectWS('/ws');
    const code = await new Promise<number>((resolve) => {
      void app.injectWS('/ws', {}, { onInit: (ws) => ws.once('close', resolve) });
    });
    expect(code).toBe(1008);
    first.terminate();
  });
});
