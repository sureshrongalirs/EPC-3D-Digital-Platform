import { defineConfig } from 'vitest/config';

const API_PROXY_TARGET = process.env['API_PROXY_TARGET'] ?? 'http://localhost:3000';

export default defineConfig({
  server: {
    port: 5173,
    // Fail fast instead of silently drifting to 5174/5175/... when the port's already
    // taken (e.g. a stale dev server from an earlier session) — a wrong-but-successful
    // port is more confusing than an immediate, clear error.
    strictPort: true,
    proxy: {
      // apps/demo talks to the real server/api over relative paths; the dev server
      // forwards them so there's no CORS config to maintain in either app.
      '/api': API_PROXY_TARGET,
      '/files': API_PROXY_TARGET,
    },
  },
  test: {
    environment: 'node',
  },
});
