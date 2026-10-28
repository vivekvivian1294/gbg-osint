import { ChannelName, type ClientConfig, type Health } from '@gbg-osint/shared';
import type { FastifyInstance } from 'fastify';
import { UpstreamError } from '../core/http';
import type { Scheduler } from '../core/scheduler';
import type { ChannelStore } from '../core/store';

const CONNECTOR_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
/** Path segments of letters, digits, `_` and `-`, joined by `/` or `.` (so no `..`). */
const DATA_PATH = /^[A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*$/;
const MAX_DATA_PATH = 200;

export interface ApiDeps {
  store: ChannelStore;
  scheduler: Scheduler;
  version: string;
  clientConfig: ClientConfig;
  /** Map tiles and frames come in bursts, so `/api/data` has its own, higher limit. */
  dataRateLimitPerMinute: number;
}

export function registerApiRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const startedAt = Date.now();

  app.get('/api/health', async (): Promise<Health> => ({
    status: 'ok',
    version: deps.version,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    time: new Date().toISOString(),
  }));

  app.get('/api/client-config', async (): Promise<ClientConfig> => deps.clientConfig);

  app.get('/api/sources', async () => deps.scheduler.statuses());

  app.get('/api/channels', async () => deps.store.list());

  app.get<{ Params: { channel: string } }>(
    '/api/channels/:channel/snapshot',
    async (request, reply) => {
      const parsed = ChannelName.safeParse(request.params.channel);
      if (!parsed.success || !deps.store.has(parsed.data)) {
        return reply.code(404).send({ error: 'Unknown channel' });
      }
      return {
        channel: parsed.data,
        items: deps.store.snapshot(parsed.data),
        ts: new Date().toISOString(),
      };
    },
  );

  app.get<{ Params: { id: string; '*': string } }>(
    '/api/data/:id/*',
    { config: { rateLimit: { max: deps.dataRateLimitPerMinute, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id, '*': path } = request.params;
      if (!CONNECTOR_ID.test(id) || path.length > MAX_DATA_PATH || !DATA_PATH.test(path)) {
        return reply.code(404).send({ error: 'Not Found' });
      }
      let file;
      try {
        file = await deps.scheduler.serve(id, path);
      } catch (err) {
        if (!(err instanceof UpstreamError)) throw err;
        return reply.code(502).send({ error: 'Upstream source unavailable' });
      }
      if (!file) return reply.code(404).send({ error: 'Not Found' });
      return reply
        .header('cache-control', `public, max-age=${file.maxAgeSec}`)
        .type(file.type)
        .send(file.body);
    },
  );
}
