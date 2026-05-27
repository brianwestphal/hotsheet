import { defineConfig } from 'vitest/config';

export default defineConfig({
  // HS-7331 — alias both `#jsx/jsx-runtime` and `#jsx/jsx-dev-runtime` to the
  // project's custom JSX runtime so vitest can compile .tsx files. The build
  // pipeline (esbuild) only needs the non-dev alias; vitest's dev-mode
  // transform imports `-dev-runtime` and fails without this mapping.
  resolve: {
    alias: {
      '#jsx/jsx-runtime': '/src/jsx-runtime.ts',
      '#jsx/jsx-dev-runtime': '/src/jsx-runtime.ts',
    },
  },
  test: {
    pool: 'forks',
    testTimeout: 30000,
    // HS-8650 — raise the per-hook timeout from vitest's 10s default to match
    // `testTimeout`. The PGLite-heavy DB suites tear down real embedded-Postgres
    // clusters in `afterEach` (`closeAllDatabases()` → CHECKPOINT + close); under
    // the full merged-coverage run (200+ files in parallel + V8 instrumentation)
    // that close work can exceed 10s purely from CPU starvation, surfacing as a
    // flaky "Hook timed out in 10000ms" that isn't a real hang. 30s gives every
    // teardown hook the same headroom the bodies already get. (The slowest
    // suite, `snapshotRestore.test.ts`, scopes an even-higher local override.)
    hookTimeout: 30000,
    // HS-8097: `node_modules/**` only matches the top-level node_modules.
    // The Tauri release artefact at
    // `src-tauri/target/release/bundle/.../server/node_modules/` ships with
    // node-pty's own .test.ts / .test.js files; Vitest globs would match
    // them and they fail to load (mocha-style, missing `ps-list`, etc.),
    // masking real test failures behind phantom file-level failures.
    // `**/node_modules/**` covers both. The whole `src-tauri/target/**`
    // build-output tree is excluded too so no Cargo / bundle artefact
    // can ever be picked up by a glob.
    exclude: ['e2e/**', '**/node_modules/**', 'src-tauri/target/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json'],
      reportsDirectory: './coverage',
      all: true,
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/test-helpers.ts',
        'src/spawnTestServer.ts',
        'src/types.ts',
      ],
    },
  },
});
