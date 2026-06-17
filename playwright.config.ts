import 'dotenv/config';
import { defineConfig } from '@playwright/test';

// When NO_WEB_SERVER is set, the coverage script manages the server lifecycle
// directly (so it can control NODE_V8_COVERAGE and graceful shutdown).
const useWebServer = !process.env.NO_WEB_SERVER;

export default defineConfig({
  testDir: 'e2e',
  testIgnore: ['**/smoke/**'],  // Smoke tests use playwright.config.smoke.ts with their own server
  timeout: 30_000,
  // Retry on CI only. The single-worker browser suite runs on a shared, often
  // loaded ubuntu runner where individual specs intermittently flake on timing
  // (e.g. a slow /api/backups/now, a sidebar re-render mid-interaction) — these
  // pass on a clean retry and pass locally. Retries keep one flaky spec from
  // failing the whole job; they do NOT mask a deterministic failure (which fails
  // every attempt). Local runs keep retries: 0 so flakes surface during dev.
  retries: process.env.CI !== undefined && process.env.CI !== '' ? 2 : 0,
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
          // HS-8714 — cross-platform Node launcher (scripts/e2e-server.mjs):
          // isolates the global home (so the E2E server never touches a real
          // ~/.hotsheet), picks a unique temp data dir, builds the client, and
          // spawns the server via `node --import tsx`. Replaces the old Unix-only
          // shell command so E2E runs on Windows too. PLUGINS_ENABLED flows
          // through the environment.
          command: 'node scripts/e2e-server.mjs',
          port: 4190,
          reuseExistingServer: false,
          timeout: 30_000,
        },
      }
    : {}),
});
