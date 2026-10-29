import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { loadConfig, loadDotEnv } from './config';
import { connectors } from './connectors';

loadDotEnv();
const config = loadConfig(process.env);
const webRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));
const { app, scheduler, servesWeb } = await buildApp({
  config,
  connectors,
  webRoot,
  persistHistory: true,
});

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (err) {
  app.log.fatal({ err }, 'failed to start');
  process.exit(1);
}
scheduler.start();
app.log.info(
  servesWeb
    ? `GBG OSINT is running: open http://localhost:${config.PORT}`
    : 'API only: the web app is not built (use `npm start`, or `npm run dev` for development)',
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
