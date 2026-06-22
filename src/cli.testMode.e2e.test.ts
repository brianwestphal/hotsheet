/**
 * HS-8921 — launch-level proof that `--test` runs a fully-isolated instance.
 *
 * Unlike the shared `spawnHotSheet` harness (which always passes explicit
 * `--data-dir` / `--port`, overriding the `--test` defaults), this spawns
 * `tsx src/cli.ts --test` with NONE of those flags so the `--test` defaults
 * actually apply, then asserts:
 *   - the server binds the test default port (4274),
 *   - global state lands under `<HOME>/.hotsheet-test` (not `<HOME>/.hotsheet`),
 *   - the sandbox project DB is created under the isolated home,
 *   - the launch cwd gets NO `.hotsheet/` (the "doesn't edit my real projects"
 *     guarantee),
 *   - the served page renders the TEST badge with the bound port (HS-8922).
 *
 * Gated by `canRunServerSpawnTests` like the other `*.e2e.test.ts` suites.
 */
import { type ChildProcess, spawn } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canRunServerSpawnTests, waitForServerReady } from './spawnTestServer.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const REPO_ROOT = join(import.meta.dirname, '..');
const TEST_PORT = 4274;

let proc: ChildProcess | null = null;
let cleanupDirs: string[] = [];

beforeEach(() => {
  proc = null;
  cleanupDirs = [];
});

afterEach(async () => {
  if (proc !== null && proc.exitCode === null && !proc.killed) {
    proc.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 200));
  }
  for (const d of cleanupDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe.skipIf(!canRunServerSpawnTests)('--test isolated instance e2e (HS-8921) (skipped: no tsx child-spawn here, or running inside a Hot Sheet terminal; HS-8202)', () => {
  it('binds 4274, writes global state under <HOME>/.hotsheet-test, creates the sandbox DB, leaves the cwd clean', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hs-test-mode-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'hs-test-mode-cwd-'));
    cleanupDirs.push(home, cwd);

    const tsxBin = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
    // HOTSHEET_HOME is explicitly removed so `--test` derives ~/.hotsheet-test
    // under the temp HOME. PLUGINS_ENABLED off to keep boot light.
    // TSX_TSCONFIG_PATH pins the repo tsconfig so tsx applies the custom JSX
    // runtime (`jsxImportSource: "#jsx"`) even though we launch from a temp cwd
    // (tsx resolves tsconfig relative to cwd by default → JSX would otherwise
    // fall back to `React.createElement` and the page render would 500). This
    // mirrors the dev/Tauri launcher (`build_dev_server_args`).
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PLUGINS_ENABLED: 'false',
      TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json'),
    };
    delete env.HOTSHEET_HOME;
    // `--strict-port` so the child binds EXACTLY the test default port (4274)
    // or fails fast — without it a busy 4274 would silently auto-shift and the
    // `binds 4274` readiness wait would hang on the wrong port.
    const child = spawn(tsxBin, [join(REPO_ROOT, 'src', 'cli.ts'), '--test', '--no-open', '--strict-port'], {
      cwd, // launch from a project-less temp dir
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc = child;

    let buffered = '';
    const onChunk = (c: Buffer | string): void => { buffered += c.toString(); };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);

    // Binds the test default port.
    await waitForServerReady(TEST_PORT, 40_000);
    // Wait for the post-startup phase (global files are written after listen).
    const deadline = Date.now() + 30_000;
    while (!buffered.includes('startup finished') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(buffered).toContain('startup finished');

    const testHome = join(home, '.hotsheet-test');
    // Global state under the isolated test home...
    expect(existsSync(join(testHome, 'instance.json'))).toBe(true);
    expect(existsSync(join(testHome, 'projects.json'))).toBe(true);
    // ...the sandbox project DB created there...
    expect(existsSync(join(testHome, 'sandbox-project', '.hotsheet', 'db'))).toBe(true);
    // ...the real <HOME>/.hotsheet never created...
    expect(existsSync(join(home, '.hotsheet'))).toBe(false);
    // ...and the launch cwd left clean (no .hotsheet written into a real project).
    expect(existsSync(join(cwd, '.hotsheet'))).toBe(false);

    // HS-8922 — the served page renders the TEST badge with the bound port.
    const pageRes = await fetch(`http://localhost:${TEST_PORT}/`);
    const pageHtml = await pageRes.text();
    expect(pageHtml).toContain('test-instance-badge');
    expect(pageHtml).toContain(`TEST :${TEST_PORT}`);
  });
});
