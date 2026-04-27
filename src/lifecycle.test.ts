/**
 * HS-7931 — unit tests for the graceful-shutdown pipeline.
 *
 * The pipeline coordinates four pieces of state (HTTP server, PTY registry,
 * PGLite cache, instance lockfile). These tests exercise the
 * `gracefulShutdown` orchestrator end-to-end against doubles for each piece
 * so the ordering invariants + idempotence guarantees from
 * `docs/45-pglite-robustness.md` §45.3 are pinned down.
 */
import { Server as HttpServer } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetLifecycleForTests,
  _shutdownStarted,
  gracefulShutdown,
  registerHttpServerForShutdown,
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

beforeEach(() => {
  _resetLifecycleForTests();
  removeInstanceMock.mockReset();
  closeAllDatabasesMock.mockReset();
  closeAllDatabasesMock.mockImplementation(async () => Promise.resolve());
  destroyAllTerminalsMock.mockReset();
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
  return { close: closeFn } as unknown as HttpServer;
}

describe('gracefulShutdown (HS-7931)', () => {
  it('runs every cleanup step in order: http close → terminals → databases → lockfile', async () => {
    const order: string[] = [];
    const server = {
      close: vi.fn((cb?: (err?: Error) => void) => { order.push('http'); cb?.(); }),
    } as unknown as HttpServer;
    destroyAllTerminalsMock.mockImplementation(() => { order.push('terminals'); });
    closeAllDatabasesMock.mockImplementation(async () => { order.push('databases'); });
    removeInstanceMock.mockImplementation(() => { order.push('lockfile'); });

    registerHttpServerForShutdown(server);
    await gracefulShutdown('test');

    expect(order).toEqual(['http', 'terminals', 'databases', 'lockfile']);
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
