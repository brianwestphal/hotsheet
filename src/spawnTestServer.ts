/**
 * Shared child-process harness for the `*.e2e.test.ts` suites that need a
 * REAL Hot Sheet server (spawned `tsx src/cli.ts`) rather than an in-process
 * Hono app. Extracted from `src/lifecycle.e2e.test.ts` (HS-7934) so the
 * HS-8588 snapshot crash-recovery suite can reuse the same spawn / ready /
 * secret / exit plumbing instead of duplicating it.
 *
 * NOT production code — only imported by test files, so it never reaches the
 * `dist/cli.js` bundle (tsup only bundles the CLI + client entry points).
 */
import { type ChildProcess, execFileSync, spawn } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { getProjectSecret } from './secret-file.js';

const REPO_ROOT = join(import.meta.dirname, '..');
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli.ts');

/**
 * HS-9315 — probe whether `node --import tsx <file>` can run a real `.ts` child
 * here. `spawnHotSheet` uses the in-process `--import tsx` launcher (NOT the
 * `.bin/tsx` / `npx tsx` launcher, which spawns the target as a grandchild and
 * needs a tsx IPC unix-socket that restricted sandboxes deny — HS-8202 — AND
 * eats signals: a SIGINT to the tracked PID hits the tsx parent, which exits 130
 * instead of running cli.ts's clean-exit handler). `--import tsx` registers the
 * loader in the SAME process, so there is no grandchild and no IPC socket — it
 * works in the partial sandbox where the old `npx tsx` child-spawn EPERM'd.
 *
 * The probe must EXECUTE a real `.ts` file (not `--help`): that exercises the
 * exact loader-registration + module-execution path the real spawn uses.
 */
export function probeCanSpawnTsxChild(): boolean {
  const probeFile = join(tmpdir(), `hotsheet-tsx-probe-${process.pid}.ts`);
  try {
    writeFileSync(probeFile, 'process.stdout.write("tsx-probe-ok");\n');
    const out = execFileSync(process.execPath, ['--import', 'tsx', probeFile], { encoding: 'utf8', timeout: 8000, stdio: 'pipe' });
    return out.includes('tsx-probe-ok');
  } catch {
    return false;
  } finally {
    try { rmSync(probeFile, { force: true }); } catch { /* ignore */ }
  }
}

export const canSpawnTsxChild = probeCanSpawnTsxChild();

/**
 * The gate the spawn-bearing e2e suites actually use. Requires BOTH that tsx
 * can really spawn a child here (`canSpawnTsxChild`) AND that we are NOT running
 * inside a Hot Sheet-spawned terminal (`HOTSHEET_IN_TERMINAL=1`). The latter is
 * the canonical `isInsideHotSheetTerminal()` from `test-helpers.ts` — inlined
 * here (rather than imported) to keep this harness free of the DB-connection
 * import chain that `test-helpers.ts` pulls in. See that helper's doc comment
 * for why server-spawn + signal tests are unreliable co-resident with a live
 * Hot Sheet (tsx-through-a-TTY exits 130 instead of running the clean-exit
 * handler). CI doesn't set the var, so it still runs these suites.
 */
export const canRunServerSpawnTests = canSpawnTsxChild && process.env.HOTSHEET_IN_TERMINAL !== '1';

export interface SpawnedHotSheet {
  proc: ChildProcess;
  port: number;
  dataDir: string;
  homeDir: string;
  /** Resolves when `GET /api/stats` returns 200, or rejects after the timeout. */
  ready: Promise<void>;
  /** Resolves once `marker` appears in the child's combined stdout/stderr. */
  waitForOutput: (marker: string, timeoutMs: number) => Promise<void>;
}

/**
 * Pick a port from an ephemeral range outside the dev server (4174) + the
 * Playwright webServer (4190), so a stale instance can't collide.
 */
export function pickRandomPort(): number {
  return 4500 + Math.floor(Math.random() * 1000);
}

export interface SpawnHotSheetOptions {
  /** Reuse an existing data dir (e.g. a relaunch onto a corrupted cluster).
   *  When omitted a fresh temp dir is created. */
  dataDir?: string;
  /** Reuse an existing HOME (needed when a relaunch must restore the same
   *  multi-project list from `<HOME>/.hotsheet/`). When omitted a fresh temp
   *  HOME is created so the child never stomps the developer's real one. */
  homeDir?: string;
  port?: number;
  /** Extra environment variables merged into the child's env (after HOME /
   *  USERPROFILE / PLUGINS_ENABLED). Used e.g. to set `HOTSHEET_HOME` for the
   *  global-dir relocation e2e (HS-8920). */
  extraEnv?: Record<string, string>;
}

/**
 * Spawn `cli.ts` as an isolated child, IN-PROCESS via `node --import tsx` — NOT
 * the `.bin/tsx` / `npx tsx` launcher. `tsx <file>` spawns the target as a
 * grandchild, so a SIGINT sent to the tracked PID hits the tsx parent (which
 * exits 130) instead of cli.ts's in-process signal handler — the clean-exit path
 * and the "gracefulShutdown starting" stdout marker never happen (HS-9315).
 * `--import tsx` registers the loader in THIS node process, so the tracked PID IS
 * the cli.ts server (matches dev-mode `node --import tsx`), and signals + stdout
 * flow directly.
 */
export function spawnHotSheet(options: SpawnHotSheetOptions = {}): SpawnedHotSheet {
  const port = options.port ?? pickRandomPort();
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'hs-e2e-data-'));
  const homeDir = options.homeDir ?? mkdtempSync(join(tmpdir(), 'hs-e2e-home-'));
  const proc = spawn(process.execPath, ['--import', 'tsx', CLI_ENTRY, '--data-dir', dataDir, '--no-open', '--port', String(port)], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, PLUGINS_ENABLED: 'false', ...options.extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Buffer stdout/stderr so individual tests can synchronize on log lines.
  let buffered = '';
  const waiters: Array<{ marker: string; resolve: () => void }> = [];
  const onChunk = (c: Buffer | string): void => {
    const text = typeof c === 'string' ? c : c.toString('utf-8');
    buffered += text;
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (buffered.includes(w.marker)) {
        w.resolve();
        waiters.splice(i, 1);
      }
    }
    if (process.env.HS_E2E_DEBUG !== undefined) process.stderr.write(`[child:${port}] ${text}`);
  };
  proc.stdout.on('data', onChunk);
  proc.stderr.on('data', onChunk);
  proc.on('error', (err) => { console.error(`[child:${port}] spawn error:`, err); });

  const waitForOutput = (marker: string, timeoutMs: number): Promise<void> => {
    if (buffered.includes(marker)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const entry = { marker, resolve: () => resolve() };
      waiters.push(entry);
      const t = setTimeout(() => {
        const idx = waiters.indexOf(entry);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for child output to contain: ${marker}`));
      }, timeoutMs);
      const wrapped = entry.resolve;
      entry.resolve = (): void => { clearTimeout(t); wrapped(); };
    });
  };

  const ready = waitForServerReady(port, 30_000);
  return { proc, port, dataDir, homeDir, ready, waitForOutput };
}

/**
 * Poll `GET /api/stats` until 200. (`/api/poll` is a 30 s long-poll that
 * would hang the probe on a fresh DB.)
 */
export async function waitForServerReady(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1000);
      try {
        const res = await fetch(`http://localhost:${port}/api/stats`, { signal: ctrl.signal });
        if (res.ok) return;
      } finally { clearTimeout(t); }
    } catch {
      // Connection refused while the server is starting up.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Hot Sheet child on port ${port} did not become ready within ${timeoutMs}ms`);
}

export function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    if (proc.exitCode !== null) {
      resolve({ code: proc.exitCode, signal: proc.signalCode });
      return;
    }
    const t = setTimeout(() => {
      reject(new Error(`Process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    proc.once('exit', (code, signal) => {
      clearTimeout(t);
      resolve({ code, signal });
    });
  });
}

/** Read a project's secret (written by startup). HS-8999 — the secret lives in
 *  the `secret.json` sidecar now (`getProjectSecret` falls back to settings.json
 *  for an un-migrated project). */
export function readSecret(dataDir: string): string {
  const secret = getProjectSecret(dataDir);
  if (secret === '') throw new Error('no project secret found (secret.json / settings.json)');
  return secret;
}

export async function postJson(url: string, body: unknown, secret?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret !== undefined) headers['X-Hotsheet-Secret'] = secret;
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

export async function patchJson(url: string, body: unknown, secret?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret !== undefined) headers['X-Hotsheet-Secret'] = secret;
  return fetch(url, { method: 'PATCH', headers, body: JSON.stringify(body) });
}
