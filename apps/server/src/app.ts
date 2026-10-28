import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyError } from 'fastify';
import type { Config } from './config';
import type { Connector } from './core/connector';
import { clientKey } from './core/net';
import { Scheduler } from './core/scheduler';
import { ChannelStore } from './core/store';
import { registerGateway } from './realtime/gateway';
import { registerApiRoutes } from './routes/api';
import { CSP_DIRECTIVES, registerWebApp } from './web';

export const VERSION = '0.1.0';

export interface BuildAppOptions {
  config: Config;
  connectors: readonly Connector[];
  env?: NodeJS.ProcessEnv;
  /** Built web app to serve (apps/web/dist); skipped when it hasn't been built. */
  webRoot?: string;
}

export async function buildApp({
  config,
  connectors,
  env = process.env,
  webRoot,
}: BuildAppOptions) {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    trustProxy: config.TRUST_PROXY.trim() || false,
    bodyLimit: 16 * 1024,
  });

  const store = new ChannelStore();
  const scheduler = new Scheduler(connectors, {
    store,
    log: app.log,
    env,
    userAgent: config.UPSTREAM_USER_AGENT,
    ...(config.CACHE_DIR && { cacheDir: config.CACHE_DIR }),
  });

  await app.register(helmet, {
    contentSecurityPolicy: { useDefaults: false, directives: CSP_DIRECTIVES },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    // Served over plain HTTP on localhost.
    strictTransportSecurity: false,
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  });
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    keyGenerator: (request) => clientKey(request.ip),
    // The web app's own files (Cesium alone is dozens) aren't limited.
    allowList: (request) => !request.url.startsWith('/api/') && !request.url.startsWith('/ws'),
  });
  await app.register(websocket, { options: { maxPayload: 4 * 1024 } });

  app.setErrorHandler((err: FastifyError, request, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) request.log.error({ err }, 'request failed');
    void reply.code(status).send({ error: status >= 500 ? 'Internal Server Error' : err.message });
  });
  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({ error: 'Not Found' });
  });

  registerApiRoutes(app, {
    store,
    scheduler,
    version: VERSION,
    clientConfig: config.CARTO_API_KEY ? { cartoKey: config.CARTO_API_KEY } : {},
    dataRateLimitPerMinute: config.RATE_LIMIT_PER_MINUTE * 5,
  });
  registerGateway(app, store, { maxConnectionsPerIp: config.WS_MAX_CONNECTIONS_PER_IP });
  const servesWeb = webRoot ? await registerWebApp(app, webRoot) : false;

  app.addHook('onClose', async () => scheduler.stop());

  return { app, store, scheduler, servesWeb };
}
