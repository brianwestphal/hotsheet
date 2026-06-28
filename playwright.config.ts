import 'dotenv/config';
import { defineConfig } from '@playwright/test';

// When NO_WEB_SERVER is set, the coverage script manages the server lifecycle
// directly (so it can control NODE_V8_COVERAGE and graceful shutdown).
const useWebServer = !process.env.NO_WEB_SERVER;

// HS-9141 — the terminal/PTY/OSC specs are timing-sensitive (real BEL/title/CWD
// escape sequences round-trip through a live PTY → server detect → push →
// client render). On GH's constrained 2-CPU runner they miss their windows and
// cascade via the shared server (the suite is healthy locally — see HS-9141).
// Split them onto their own CI job via `E2E_SCOPE` so they get a fresh server +
// the full runner, and a cascade can't take down the rest of the e2e suite:
//   E2E_SCOPE=terminal     → ONLY these specs (the dedicated `e2e-terminal` job)
//   E2E_SCOPE=no-terminal  → everything EXCEPT these (the main `e2e` job)
//   unset                  → the whole suite (local default)
const TERMINAL_SPECS = [
  '**/terminal*.spec.ts',
  '**/show-hide-terminals.spec.ts',
  '**/drawer-terminal-grid.spec.ts',
];
const scope = process.env.E2E_SCOPE;
const terminalScope = scope === 'terminal';

export default defineConfig({
  testDir: 'e2e',
  // Smoke tests use playwright.config.smoke.ts with their own server.
  testIgnore: ['**/smoke/**', ...(scope === 'no-terminal' ? TERMINAL_SPECS : [])],
  ...(terminalScope ? { testMatch: TERMINAL_SPECS } : {}),
  // Terminal specs get extra headroom for the real-PTY escape-sequence round-trips.
  timeout: terminalScope ? 60_000 : 30_000,
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
