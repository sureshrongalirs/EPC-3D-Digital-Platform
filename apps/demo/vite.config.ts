import { defineConfig } from 'vitest/config';

const API_PROXY_TARGET = process.env['API_PROXY_TARGET'] ?? 'http://localhost:3000';

export default defineConfig({
  server: {
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
