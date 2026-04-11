import 'dotenv/config';
import { defineConfig } from '@playwright/test';

// When NO_WEB_SERVER is set, the coverage script manages the server lifecycle
// directly (so it can control NODE_V8_COVERAGE and graceful shutdown).
const useWebServer = !process.env.NO_WEB_SERVER;

export default defineConfig({
  testDir: 'e2e',
  testIgnore: ['**/smoke/**'],  // Smoke tests use playwright.config.smoke.ts with their own server
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
          // Use isolated HOME so global files (instance.json, projects.json, config.json)
          // don't interfere with any running Hot Sheet instance
          command:
            `export HOME=$(mktemp -d) && export PLUGINS_ENABLED=${process.env.PLUGINS_ENABLED ?? 'false'} && npm run build:client && npx tsx src/cli.ts --data-dir /tmp/hotsheet-e2e-$(date +%s%N) --no-open --port 4190 --strict-port`,
          port: 4190,
          reuseExistingServer: false,
          timeout: 30_000,
        },
      }
    : {}),
});
