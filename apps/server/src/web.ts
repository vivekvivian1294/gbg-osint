import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';

const TILE_HOSTS = [
  'https://server.arcgisonline.com',
  'https://tile.openstreetmap.org',
  'https://*.basemaps.cartocdn.com',
];

/** Content-Security-Policy for the web app; Cesium's WebAssembly needs 'wasm-unsafe-eval'. */
export const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
  workerSrc: ["'self'", 'blob:'],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:', 'blob:', ...TILE_HOSTS, 'https://api.trafikinfo.trafikverket.se'],
  connectSrc: ["'self'", ...TILE_HOSTS],
  // Radio streams come from many broadcaster hosts; audio can't run script.
  mediaSrc: ["'self'", 'https:'],
  fontSrc: ["'self'", 'data:'],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
};

/** Serves the built web app, if there is one, so a single process runs the whole tool. */
export async function registerWebApp(app: FastifyInstance, root: string): Promise<boolean> {
  if (!existsSync(join(root, 'index.html'))) return false;
  await app.register(fastifyStatic, {
    root,
    setHeaders(reply, path) {
      // Vite fingerprints everything under assets/, so it never changes.
      if (path.includes(`${sep}assets${sep}`)) {
        void reply.header('cache-control', 'public, max-age=31536000, immutable');
      }
    },
  });
  return true;
}
