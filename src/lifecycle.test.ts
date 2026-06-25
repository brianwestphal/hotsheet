/**
 * HS-7931 — unit tests for the graceful-shutdown pipeline.
 *
 * The pipeline coordinates four pieces of state (HTTP server, PTY registry,
 * PGLite cache, instance lockfile). These tests exercise the
 * `gracefulShutdown` orchestrator end-to-end against doubles for each piece
 * so the ordering invariants + idempotence guarantees from
 * `docs/45-pglite-robustness.md` §45.3 are pinned down.
 */
import type { Server as HttpServer } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetLifecycleForTests,
  _setShutdownTimeoutsForTests,
  _shutdownStarted,
  gracefulShutdown,
  registerHttpServerForShutdown,
  stepTimeoutFor,
} from './lifecycle.js';

// Mocks — instance file + DB cache + PTY registry. The registry is lazy-
// imported by the pipeline so we mock it via vi.mock to avoid pulling in
// node-pty.
const removeInstanceMock = vi.fn();
vi.mock('./instance.js', () => ({
  removeInstanceFile: () => { removeInstanceMock(); },
}));

const closeAllDatabasesMock = vi.fn(async () => Promise.resolve());
vi.mock('./db/connection.js', () => ({
  closeAllDatabases: () => closeAllDatabasesMock(),
}));

const destroyAllTerminalsMock = vi.fn();
vi.mock('./terminals/registry.js', () => ({
  destroyAllTerminals: () => { destroyAllTerminalsMock(); },
}));

// HS-8040 — shell-routes module is dynamically imported by the pipeline
// to kill button-launched commands before terminals close. Mocked here so
// the test default doesn't pull in the real spawn-based module + so the
// 1000 ms default grace period doesn't slow each test.
const killAllRunningShellCommandsMock = vi.fn((): Promise<{ killed: number }> => Promise.resolve({ killed: 0 }));
vi.mock('./routes/shell.js', () => ({
  killAllRunningShellCommands: () => killAllRunningShellCommandsMock(),
}));

// HS-8586 — Snapshot Protection adds a final-snapshot step to the pipeline,
// dynamically imported between terminal/git-watcher teardown and DB close.
// Mocked so the test default is a no-op + so the ordering test can observe it.
const snapshotAllForShutdownMock = vi.fn((): Promise<void> => Promise.resolve());
vi.mock('./db/snapshot.js', () => ({
  snapshotAllForShutdown: () => snapshotAllForShutdownMock(),
}));

beforeEach(() => {
  _resetLifecycleForTests();
  removeInstanceMock.mockReset();
  closeAllDatabasesMock.mockReset();
  closeAllDatabasesMock.mockImplementation(async () => Promise.resolve());
  destroyAllTerminalsMock.mockReset();
  killAllRunningShellCommandsMock.mockReset();
  killAllRunningShellCommandsMock.mockImplementation(() => Promise.resolve({ killed: 0 }));
  snapshotAllForShutdownMock.mockReset();
  snapshotAllForShutdownMock.mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  _resetLifecycleForTests();
});

function makeFakeServer(closeBehavior: 'immediate' | 'delayed' | 'error' = 'immediate'): HttpServer {
  const closeFn = vi.fn((cb?: (err?: Error) => void) => {
    if (closeBehavior === 'error') {
      cb?.(new Error('synthetic close error'));
    } else if (closeBehavior === 'delayed') {
      setTimeout(() => cb?.(), 5);
    } else {
      cb?.();
    }
  });
  // HS-8199: stub `closeIdleConnections` so production `lifecycle.ts` can call
  // it without an optional chain (Node 18.2+ always provides it; the prod
  // code's `?.` was purely a test-stub accommodation).
  const closeIdleConnectionsFn = vi.fn();
  return { close: closeFn, closeIdleConnections: closeIdleConnectionsFn } as unknown as HttpServer;
}

describe('gracefulShutdown (HS-7931)', () => {
  it('runs every cleanup step in order: http close → shells → terminals → snapshot → databases → lockfile (HS-8040, HS-8586)', async () => {
    const order: string[] = [];
    const server = {
      close: vi.fn((cb?: (err?: Error) => void) => { order.push('http'); cb?.(); }),
      closeIdleConnections: vi.fn(),
    } as unknown as HttpServer;
    killAllRunningShellCommandsMock.mockImplementation(() => {
      order.push('shells');
      return Promise.resolve({ killed: 0 });
    });
    destroyAllTerminalsMock.mockImplementation(() => { order.push('terminals'); });
    snapshotAllForShutdownMock.mockImplementation(() => { order.push('snapshot'); return Promise.resolve(); });
    closeAllDatabasesMock.mockImplementation(() => { order.push('databases'); return Promise.resolve(); });
    removeInstanceMock.mockImplementation(() => { order.push('lockfile'); });

    registerHttpServerForShutdown(server);
    await gracefulShutdown('test');

    // HS-8040 — shells must come AFTER http close (no new spawn-exec
    // requests can arrive while we're killing) and BEFORE terminals
    // (we kill button-launched processes; terminals are PTY-backed and
    // a separate shutdown path).
    // HS-8586 — the final snapshot must come AFTER terminals teardown (no new
    // writes can arrive) and BEFORE databases close (the DBs must still be
    // open to dump).
    expect(order).toEqual(['http', 'shells', 'terminals', 'snapshot', 'databases', 'lockfile']);
  });

  // HS-8040 — pipeline doesn't wedge if the shell-kill step throws.
  it('does not fail the pipeline if `killAllRunningShellCommands` throws (HS-8040)', async () => {
    killAllRunningShellCommandsMock.mockImplementation(() => Promise.reject(new Error('synthetic shell kill')));
    registerHttpServerForShutdown(makeFakeServer());

    await gracefulShutdown('test');

    // Subsequent steps still run.
    expect(destroyAllTerminalsMock).toHaveBeenCalledTimes(1);
    expect(closeAllDatabasesMock).toHaveBeenCalledTimes(1);
    expect(removeInstanceMock).toHaveBeenCalledTimes(1);
  });

  // HS-8828 — a step that THROWS was already tolerated; the new contract is
  // that a step that HANGS (never settles) is bounded by a per-step timeout so
  // the pipeline still advances. Pre-fix this wedged `gracefulShutdown` forever
  // → the SIGINT/SIGTERM handler never reached `process.exit(0)` → the app
  // "never quit" (the reported symptom, when run via `npm run tauri:dev`).
  it('does not wedge when a step HANGS — abandons it after the per-step timeout and runs the rest (HS-8828)', async () => {
    _setShutdownTimeoutsForTests(20, 2000); // 20ms per-step, generous overall
    // `closeAllDatabases` never resolves — the classic "PGLite CHECKPOINT
    // blocked" hang.
    closeAllDatabasesMock.mockImplementation(() => new Promise<void>(() => { /* never resolves */ }));
    registerHttpServerForShutdown(makeFakeServer());

    // Must resolve despite the hang (the test would itself time out otherwise).
    await gracefulShutdown('test');

    // The hung DB-close step was abandoned, but the lockfile-removal step that
    // comes AFTER it still ran.
    expect(removeInstanceMock).toHaveBeenCalledTimes(1);
  });

  it('honors the overall deadline when a step hangs longer than the per-step budget (HS-8828)', async () => {
    // Per-step budget high, overall ceiling low: the overall deadline must win
    // and resolve `gracefulShutdown` so `process.exit(0)` can fire.
    _setShutdownTimeoutsForTests(10_000, 30);
    // `snapshotAllForShutdown` (the step BEFORE databases + lockfile) hangs.
    snapshotAllForShutdownMock.mockImplementation(() => new Promise<void>(() => { /* never resolves */ }));
    registerHttpServerForShutdown(makeFakeServer());

    await gracefulShutdown('test');

    // The 30ms overall deadline pre-empted the pipeline mid-snapshot, so the
    // later steps never ran — proving the ceiling fired (not the 10s per-step).
    expect(closeAllDatabasesMock).not.toHaveBeenCalled();
    expect(removeInstanceMock).not.toHaveBeenCalled();
  });

  it('is idempotent — concurrent callers share the same underlying promise', async () => {
    registerHttpServerForShutdown(makeFakeServer('delayed'));

    const a = gracefulShutdown('http');
    const b = gracefulShutdown('SIGINT');
    const c = gracefulShutdown('SIGTERM');

    // All three resolve, but the underlying steps fire only once.
    await Promise.all([a, b, c]);
    expect(closeAllDatabasesMock).toHaveBeenCalledTimes(1);
    expect(destroyAllTerminalsMock).toHaveBeenCalledTimes(1);
    expect(removeInstanceMock).toHaveBeenCalledTimes(1);
  });

  it('does not fail the pipeline if `closeAllDatabases` throws — subsequent steps still run', async () => {
    closeAllDatabasesMock.mockImplementation(async () => Promise.reject(new Error('synthetic db close')));
    registerHttpServerForShutdown(makeFakeServer());

    await gracefulShutdown('test');

    // Even though the DB close threw, the lockfile must still be removed.
    expect(removeInstanceMock).toHaveBeenCalledTimes(1);
  });

  it('does not fail the pipeline if the http server reports a close error', async () => {
    registerHttpServerForShutdown(makeFakeServer('error'));

    await gracefulShutdown('test');

    expect(closeAllDatabasesMock).toHaveBeenCalledTimes(1);
    expect(removeInstanceMock).toHaveBeenCalledTimes(1);
  });

  it('does not fail the pipeline if the PTY registry blows up', async () => {
    destroyAllTerminalsMock.mockImplementation(() => { throw new Error('synthetic registry'); });
    registerHttpServerForShutdown(makeFakeServer());

    await gracefulShutdown('test');

    expect(closeAllDatabasesMock).toHaveBeenCalledTimes(1);
    expect(removeInstanceMock).toHaveBeenCalledTimes(1);
  });

  it('skips the http close step when no server is registered (CLI-mode path)', async () => {
    // No registerHttpServerForShutdown call — `--close` from a different
    // process triggers `gracefulShutdown` here without a local http server.
    await gracefulShutdown('test');

    expect(closeAllDatabasesMock).toHaveBeenCalledTimes(1);
    expect(removeInstanceMock).toHaveBeenCalledTimes(1);
  });

  it('exposes a `_shutdownStarted` test hook that flips on first call', async () => {
    expect(_shutdownStarted()).toBe(false);
    const p = gracefulShutdown('test');
    expect(_shutdownStarted()).toBe(true);
    await p;
    // Still true after resolution — that's the contract; the reset hook is
    // what resets it between tests.
    expect(_shutdownStarted()).toBe(true);
  });
});

describe('registerHttpServerForShutdown', () => {
  it('accepts null to clear the registration (test cleanup)', async () => {
    registerHttpServerForShutdown(makeFakeServer());
    registerHttpServerForShutdown(null);
    // No server should be closed since the registration was cleared.
    await gracefulShutdown('test');
    // No assertion on close — the contract is just that it doesn't throw.
    expect(closeAllDatabasesMock).toHaveBeenCalledTimes(1);
  });
});

// HS-9028 — the heavy steps (HTTP drain + DB snapshot/close) get a 90s budget so
// a real shutdown isn't cut off at 3s; the light steps keep the short default.
describe('stepTimeoutFor (HS-9028 per-step budgets)', () => {
  afterEach(() => { _resetLifecycleForTests(); });

  it('grants the HTTP + DB steps the 90s heavy budget', () => {
    expect(stepTimeoutFor('closeHttpServer')).toBe(90_000);
    expect(stepTimeoutFor('snapshotDatabases')).toBe(90_000);
    expect(stepTimeoutFor('closeDatabases')).toBe(90_000);
  });

  it('keeps light steps on the short default (3s)', () => {
    expect(stepTimeoutFor('killShellCommands')).toBe(3000);
    expect(stepTimeoutFor('disposeGitWatchers')).toBe(3000);
    expect(stepTimeoutFor('removeLockfile')).toBe(3000);
  });

  it('lets a test override win for every step (keeps the contract testable in ms)', () => {
    _setShutdownTimeoutsForTests(25, 1000);
    expect(stepTimeoutFor('closeHttpServer')).toBe(25);
    expect(stepTimeoutFor('killShellCommands')).toBe(25);
  });
});
