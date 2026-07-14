import 'dotenv/config';
import { defineConfig } from '@playwright/test';

// HS-9352 — the coverage path (scripts/test-all.sh) sets NO_WEB_SERVER: it
// builds the client + runs its OWN single external server on 4190 with
// NODE_V8_COVERAGE, and runs Playwright single-worker against it. Every OTHER
// run gets per-worker isolated servers spawned by the `workerServer` fixture
// (e2e/coverage-fixture.ts) — so no single server is loaded by the whole sweep.
const coveragePath = process.env.NO_WEB_SERVER !== undefined && process.env.NO_WEB_SERVER !== '';

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
  // HS-9350 — this spec spawns 3 live PTYs and asserts the quit-confirm preview
  // xterm PAINTS (`.xterm-screen` renders `TOP-STATUS-BAR`) — a real-PTY render
  // round-trip, same timing class as the specs above. Left in the `no-terminal`
  // job it failed deterministically (3/3 CI + local sweeps) because the shared
  // server, loaded by ~280 other specs, couldn't spawn+paint the PTY inside the
  // 8s window. It passes in isolation. Route it to the dedicated `e2e-terminal`
  // job (fresh server + full runner + 60s timeout) where terminal timing lives.
  '**/quit-confirm-dialog-growth.spec.ts',
];
const scope = process.env.E2E_SCOPE;
const terminalScope = scope === 'terminal';

const isCI = process.env.CI !== undefined && process.env.CI !== '';

// HS-9352 — per-worker ISOLATED servers apply ONLY to the no-terminal scope (the
// big, formerly-flaky suite). The terminal scope keeps its single shared
// `webServer` (below): it's workers:1 so it gains nothing from isolation, and it's
// PTY-timing-sensitive + was already green (HS-9141) — routing it through the new
// fixture destabilized it, so leave it exactly as it was. The coverage path runs
// its own single external server (scripts/test-all.sh, NO_WEB_SERVER).
const perWorkerServers = !coveragePath && !terminalScope;

// Worker count:
//   - no-terminal → 2 workers on CI: each worker's isolated server handles ~half
//     the sweep instead of all ~280 specs, halving per-server load. Local runs let
//     Playwright pick the CPU-based default.
//   - terminal / coverage → single-worker against their one shared server.
const workers = perWorkerServers ? (isCI ? 2 : undefined) : 1;

export default defineConfig({
  testDir: 'e2e',
  // HS-9352 — build the client once before the per-worker servers start (they only
  // serve the built assets). Only needed for the per-worker (no-terminal) path;
  // the terminal `webServer` (scripts/e2e-server.mjs) and the coverage path build
  // the client themselves.
  ...(perWorkerServers ? { globalSetup: './e2e/globalSetup.ts' } : {}),
  // Smoke tests use playwright.config.smoke.ts with their own server.
  testIgnore: ['**/smoke/**', ...(scope === 'no-terminal' ? TERMINAL_SPECS : [])],
  ...(terminalScope ? { testMatch: TERMINAL_SPECS } : {}),
  // Terminal specs get extra headroom for the real-PTY escape-sequence round-trips.
  timeout: terminalScope ? 60_000 : 30_000,
  // Retry on CI only. Per-worker isolation (HS-9352) cut the flake RATE, and the
  // known save-race / WS-liveness offenders are hardened, but the suite still has a
  // broad pre-existing timing-flake tail (e.g. sidebar:117 is ~33% flaky even in
  // isolation — a WS-connect race). 3 retries (4 attempts) is the backstop that
  // keeps a rotating low-rate flake from reddening the job; it does NOT mask a
  // deterministic failure (which fails all 4). Local runs keep retries: 0 so flakes
  // surface during dev. HS-9353 tracks fixing the tail so this can drop back to 2.
  retries: isCI ? 3 : 0,
  workers,
  use: {
    // HS-9352 — for no-terminal the real per-worker baseURL is injected by the
    // `workerServer` fixture (e2e/coverage-fixture.ts). For terminal + coverage the
    // fixture targets this shared server on 4190.
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
  // HS-9352 — the terminal scope keeps its single shared webServer (the setup it
  // was green on). No-terminal spawns per-worker isolated servers via the fixture
  // (no webServer here); the coverage path (NO_WEB_SERVER) runs its own external
  // server. HS-8714 — scripts/e2e-server.mjs is the cross-platform launcher
  // (isolates HOME, temp data dir, builds the client, then `node --import tsx`).
  ...(terminalScope && !coveragePath
    ? {
        webServer: {
          command: 'node scripts/e2e-server.mjs',
          port: 4190,
          reuseExistingServer: false,
          timeout: 120_000,
        },
      }
    : {}),
});
