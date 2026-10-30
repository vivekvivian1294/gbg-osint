import {
  ChannelName,
  HISTORY_DAYS,
  MAX_SUBSCRIPTIONS,
  type ClientConfig,
  type Health,
} from '@gbg-osint/shared';
import type { FastifyInstance } from 'fastify';
import { buildBrief } from '../core/brief';
import { HISTORY_KEEP_MS, HISTORY_WINDOW_MS, type History } from '../core/history';
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
const HOURS = /^\d{1,3}$/;
const EPOCH_MS = /^\d{13}$/;

/** Start of the requested window: `hours` back from now (1 hour to the whole history), 24 by default. */
function windowStart(hours: string | undefined, now: number): number | undefined {
  if (hours === undefined) return now - HISTORY_WINDOW_MS;
  const h = HOURS.test(hours) ? Number(hours) : 0;
  return h >= 1 && h <= HISTORY_DAYS * 24 ? now - h * 3600_000 : undefined;
}

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

  app.get<{ Querystring: { prefix?: string; hours?: string } }>(
    '/api/history/series',
    async (request, reply) => {
      const prefix = request.query.prefix ?? '';
      const from = windowStart(request.query.hours, Date.now());
      if (prefix.length > MAX_HISTORY_PREFIX || !HISTORY_PREFIX.test(prefix) || !from) {
        return reply.code(404).send({ error: 'Not Found' });
      }
      return { series: deps.history.seriesUnder(prefix, from) };
    },
  );

  app.get<{ Params: { channel: string; id: string }; Querystring: { hours?: string } }>(
    '/api/history/track/:channel/:id',
    async (request, reply) => {
      const { channel, id } = request.params;
      const from = windowStart(request.query.hours, Date.now());
      if (!ChannelName.safeParse(channel).success || !ITEM_ID.test(id) || !from) {
        return reply.code(404).send({ error: 'Not Found' });
      }
      const key = `${channel}/${id}`;
      return deps.history.trackOf(key, from) ?? { key, points: [] };
    },
  );

  app.get('/api/history/range', async () => deps.history.range());

  app.get<{ Querystring: { t?: string; channels?: string } }>(
    '/api/history/at',
    async (request, reply) => {
      const { t = '', channels = '' } = request.query;
      const now = Date.now();
      const at = Number(t);
      const names = [...new Set(channels.split(','))];
      if (
        !EPOCH_MS.test(t) ||
        at > now ||
        at < now - HISTORY_KEEP_MS ||
        names.length > MAX_SUBSCRIPTIONS ||
        !names.every((n) => ChannelName.safeParse(n).success)
      ) {
        return reply.code(404).send({ error: 'Not Found' });
      }
      const known = names.flatMap((name) => {
        const kind = deps.store.kindOf(name);
        return kind ? [{ name, kind }] : [];
      });
      const items = deps.history.at(at, known);
      return { t: at, channels: [...items].map(([channel, list]) => ({ channel, items: list })) };
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
