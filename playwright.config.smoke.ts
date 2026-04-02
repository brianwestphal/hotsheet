import { defineConfig } from '@playwright/test';

// Smoke test config: no webServer — CI manages the hotsheet server lifecycle.
// The server should already be running on SMOKE_PORT (default 4195) before tests start.
const port = parseInt(process.env.SMOKE_PORT ?? '4195', 10);

export default defineConfig({
  testDir: 'e2e/smoke',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: `http://localhost:${port}`,
    headless: true,
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
