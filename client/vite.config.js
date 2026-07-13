import { defineConfig } from 'vite';

// In dev, the Vite server proxies API, art, and websocket traffic to the
// game server on :3000. In production the game server serves the built app
// itself, so no proxy is involved.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/cards': 'http://localhost:3000',
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
  build: { outDir: 'dist' },
});
