import { ChannelName, type ClientConfig, type Health } from '@gbg-osint/shared';
import type { FastifyInstance } from 'fastify';
import { buildBrief } from '../core/brief';
import type { History } from '../core/history';
import { UpstreamError } from '../core/http';
import type { Scheduler } from '../core/scheduler';
import { spotReport } from '../core/spot';
import type { ChannelStore } from '../core/store';

const CONNECTOR_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
/** Path segments of letters, digits, `_` and `-`, joined by `/` or `.` (so no `..`). */
const DATA_PATH = /^[A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*$/;
const MAX_DATA_PATH = 200;
/** A history key prefix such as `env.weather/` or `env.harbour/viva-101/` (a channel name first). */
const HISTORY_PREFIX = /^[a-z0-9]+(?:\.[a-z0-9_-]+)+\/(?:[A-Za-z0-9_.:-]{1,128}\/)?$/;
const MAX_HISTORY_PREFIX = 200;
const ITEM_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const COORD = /^-?\d{1,3}(?:\.\d{1,7})?$/;

export interface ApiDeps {
  store: ChannelStore;
  scheduler: Scheduler;
  history: History;
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

  app.get('/api/brief', async () => buildBrief(deps.store, deps.history, Date.now()));

  app.get<{ Querystring: { lon?: string; lat?: string } }>('/api/spot', async (request, reply) => {
    const { lon = '', lat = '' } = request.query;
    const x = Number(lon);
    const y = Number(lat);
    if (!COORD.test(lon) || !COORD.test(lat) || Math.abs(x) > 180 || Math.abs(y) > 90) {
      return reply.code(404).send({ error: 'Not Found' });
    }
    return spotReport(deps.store, x, y);
  });

  app.get<{ Querystring: { prefix?: string } }>('/api/history/series', async (request, reply) => {
    const prefix = request.query.prefix ?? '';
    if (prefix.length > MAX_HISTORY_PREFIX || !HISTORY_PREFIX.test(prefix)) {
      return reply.code(404).send({ error: 'Not Found' });
    }
    return { series: deps.history.seriesUnder(prefix) };
  });

  app.get<{ Params: { channel: string; id: string } }>(
    '/api/history/track/:channel/:id',
    async (request, reply) => {
      const { channel, id } = request.params;
      if (!ChannelName.safeParse(channel).success || !ITEM_ID.test(id)) {
        return reply.code(404).send({ error: 'Not Found' });
      }
      const key = `${channel}/${id}`;
      return deps.history.trackOf(key) ?? { key, points: [] };
    },
  );

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
