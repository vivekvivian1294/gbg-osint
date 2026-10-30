import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  clean: true,
  sourcemap: true,
  // The shared package ships TypeScript source, so it must be bundled.
  noExternal: ['@gbg-osint/shared'],
  // `node:sqlite` only exists with its prefix.
  removeNodeProtocol: false,
});
