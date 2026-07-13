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

// HS-9352 — worker count. The coverage path is single-worker against its one
// external server (no per-worker isolation there). Otherwise parallelize so each
// worker's ISOLATED server handles ~1/N of the sweep instead of all ~280 specs:
//   - no-terminal (the big, formerly-flaky suite) → 2 workers on CI. GitHub's
//     runner is CPU-constrained (~2 cores — see HS-9141); 2 workers = ~1 server
//     per core, so we HALVE per-server load without oversubscribing the CPUs
//     (which would reintroduce the very timing flakiness this removes). A later
//     ticket can raise this if the runner gets more cores.
//   - terminal scope stays single-worker: those specs are PTY-timing-sensitive,
//     already on their own green job (HS-9141), and get isolated servers too —
//     parallelize them conservatively (a later ticket can raise this).
// Local runs let Playwright pick the default (CPU-based) for no-terminal.
const workers = coveragePath ? 1 : terminalScope ? 1 : isCI ? 2 : undefined;

export default defineConfig({
  testDir: 'e2e',
  // HS-9352 — build the client once before workers start (each worker only
  // serves the built assets). Skipped on the coverage path (builds itself).
  globalSetup: './e2e/globalSetup.ts',
  // Smoke tests use playwright.config.smoke.ts with their own server.
  testIgnore: ['**/smoke/**', ...(scope === 'no-terminal' ? TERMINAL_SPECS : [])],
  ...(terminalScope ? { testMatch: TERMINAL_SPECS } : {}),
  // Terminal specs get extra headroom for the real-PTY escape-sequence round-trips.
  timeout: terminalScope ? 60_000 : 30_000,
  // Retry on CI only. Even with per-worker isolation (HS-9352) a spec can flake on
  // a loaded runner; retries keep one flake from failing the job without masking a
  // deterministic failure (which fails every attempt). Local runs keep retries: 0.
  retries: isCI ? 2 : 0,
  workers,
  use: {
    // HS-9352 — a fallback only. The real per-worker baseURL is injected by the
    // `workerServer` fixture in e2e/coverage-fixture.ts (http://localhost:4190+N,
    // or 4190 on the coverage path). Specs that don't use that fixture (none in
    // practice) would fall back to this.
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
});
