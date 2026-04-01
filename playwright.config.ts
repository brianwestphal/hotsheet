import { defineConfig } from '@playwright/test';

// When NO_WEB_SERVER is set, the coverage script manages the server lifecycle
// directly (so it can control NODE_V8_COVERAGE and graceful shutdown).
const useWebServer = !process.env.NO_WEB_SERVER;

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: 'http://localhost:4190',
    headless: true,
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
  ...(useWebServer
    ? {
        webServer: {
          command:
            'npm run build:client && npx tsx src/cli.ts --data-dir /tmp/hotsheet-e2e-$(date +%s%N) --no-open --port 4190',
          port: 4190,
          reuseExistingServer: false,
          timeout: 30_000,
        },
      }
    : {}),
});
