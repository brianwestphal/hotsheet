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
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dirname, '..');
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli.ts');

/**
 * HS-8202 — restricted sandboxes block tsx's IPC mkfifo, so spawning a tsx
 * child EPERMs and the readiness probe times out (30 s of red per case).
 * Probe once and let suites `describe.skipIf(!canSpawnTsxChild)` cleanly.
 */
export function probeCanSpawnTsxChild(): boolean {
  try {
    execFileSync('npx', ['tsx', '--help'], { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export const canSpawnTsxChild = probeCanSpawnTsxChild();

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
}

/**
 * Spawn `tsx src/cli.ts` as an isolated child. The local `node_modules/.bin/tsx`
 * binary is used directly (not `npx`) so the CLI is the child PID — `npx`
 * inserts a signal-proxying parent that makes back-to-back signals unreliable.
 */
export function spawnHotSheet(options: SpawnHotSheetOptions = {}): SpawnedHotSheet {
  const port = options.port ?? pickRandomPort();
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'hs-e2e-data-'));
  const homeDir = options.homeDir ?? mkdtempSync(join(tmpdir(), 'hs-e2e-home-'));
  const tsxBin = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
  const proc = spawn(tsxBin, [CLI_ENTRY, '--data-dir', dataDir, '--no-open', '--port', String(port)], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, PLUGINS_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Buffer stdout/stderr so individual tests can synchronize on log lines.
  let buffered = '';
  const waiters: Array<{ marker: string; resolve: () => void }> = [];
  const onChunk = (c: Buffer | string): void => {
    const text = typeof c === 'string' ? c : c.toString('utf-8');
    buffered += text;
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i] as { marker: string; resolve: () => void };
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

/** Read a project's secret from its `settings.json` (written by startup). */
export function readSecret(dataDir: string): string {
  const raw: unknown = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf-8'));
  if (raw === null || typeof raw !== 'object' || !('secret' in raw)) {
    throw new Error('settings.json missing secret');
  }
  const secret = (raw as Record<string, unknown>).secret;
  if (typeof secret !== 'string' || secret === '') {
    throw new Error('settings.json missing secret');
  }
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
