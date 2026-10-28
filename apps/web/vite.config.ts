import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = 'http://127.0.0.1:8787';
const proxy = {
  '/api': API_TARGET,
  '/ws': { target: API_TARGET, ws: true },
};

// The Content-Security-Policy is set by the server (apps/server/src/web.ts); check it with `npm start`.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 4173, strictPort: true, proxy },
  build: { chunkSizeWarningLimit: 8000 },
});
