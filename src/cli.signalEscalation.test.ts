/**
 * HS-7934 — unit test for `createSignalHandler` from `src/cli.ts`.
 *
 * The end-to-end test in `src/lifecycle.e2e.test.ts` was racy in the
 * spawned-tsx envelope. The actual escalation logic is tiny and pure once
 * the runtime hooks are injected, so this file pins the contract directly:
 *
 *   1. Single signal → `runShutdown(signal)` runs, then `exit(0)` via
 *      `setImmediate`.
 *   2. Two signals before the first finishes → `exit(1)` fires
 *      immediately on the second invocation, no further `runShutdown` call.
 *   3. The `setImmediate` hop on the happy path matters: it yields to
 *      pending signal handlers before exit(0), so a slow second signal can
 *      still escalate.
 */
import { describe, expect, it, vi } from 'vitest';

import { createSignalHandler } from './cli.js';

describe('createSignalHandler (HS-7934)', () => {
  function makeHooks(opts?: { shutdownDelay?: number }) {
    const exit = vi.fn();
    const log = vi.fn();
    const runShutdown = vi.fn(async (_signal: string): Promise<void> => {
      if (opts?.shutdownDelay !== undefined) {
        await new Promise(r => setTimeout(r, opts.shutdownDelay));
      }
    });
    let pendingImmediate: (() => void) | null = null;
    const setImmediateFn = vi.fn((fn: () => void) => {
      pendingImmediate = fn;
    });
    const flushImmediate = (): void => {
      if (pendingImmediate !== null) {
        const f = pendingImmediate;
        pendingImmediate = null;
        f();
      }
    };
    return { exit, log, runShutdown, setImmediateFn, flushImmediate };
  }

  it('first signal: awaits runShutdown then schedules exit(0) via setImmediate', async () => {
    const hooks = makeHooks();
    const handler = createSignalHandler({
      runShutdown: hooks.runShutdown,
      exit: hooks.exit,
      setImmediate: hooks.setImmediateFn,
      log: hooks.log,
    });

    await handler('SIGINT');

    expect(hooks.runShutdown).toHaveBeenCalledTimes(1);
    expect(hooks.runShutdown).toHaveBeenCalledWith('SIGINT');
    expect(hooks.setImmediateFn).toHaveBeenCalledTimes(1);
    // exit(0) is scheduled but not yet called — only fires on flush.
    expect(hooks.exit).not.toHaveBeenCalled();

    hooks.flushImmediate();
    expect(hooks.exit).toHaveBeenCalledTimes(1);
    expect(hooks.exit).toHaveBeenCalledWith(0);
  });

  it('second signal during shutdown calls exit(1) IMMEDIATELY (no second runShutdown)', async () => {
    const hooks = makeHooks({ shutdownDelay: 50 });
    const handler = createSignalHandler({
      runShutdown: hooks.runShutdown,
      exit: hooks.exit,
      setImmediate: hooks.setImmediateFn,
      log: hooks.log,
    });

    // Fire the first signal — its runShutdown will resolve in 50ms.
    const first = handler('SIGINT');
    // Fire the second BEFORE the first resolves.
    const second = handler('SIGINT');

    await Promise.all([first, second]);

    // Only ONE shutdown was kicked off — second invocation skipped it.
    expect(hooks.runShutdown).toHaveBeenCalledTimes(1);
    // exit(1) fired synchronously inside the second handler; no setImmediate.
    expect(hooks.exit).toHaveBeenCalledWith(1);
    // The first handler's setImmediate(exit(0)) was scheduled, but the
    // contract is "exit(1) wins". Even if exit(0) fires later, the test's
    // mock `exit` records both calls — exit(1) MUST come first.
    expect(hooks.exit.mock.calls[0]?.[0]).toBe(1);
  });

  it('SIGTERM is handled identically to SIGINT', async () => {
    const hooks = makeHooks();
    const handler = createSignalHandler({
      runShutdown: hooks.runShutdown,
      exit: hooks.exit,
      setImmediate: hooks.setImmediateFn,
      log: hooks.log,
    });
    await handler('SIGTERM');
    expect(hooks.runShutdown).toHaveBeenCalledWith('SIGTERM');
  });

  it('logs an error when the second signal escalates so the user can see the reason', async () => {
    const hooks = makeHooks({ shutdownDelay: 20 });
    const handler = createSignalHandler({
      runShutdown: hooks.runShutdown,
      exit: hooks.exit,
      setImmediate: hooks.setImmediateFn,
      log: hooks.log,
    });
    void handler('SIGINT');
    await handler('SIGINT');
    expect(hooks.log).toHaveBeenCalled();
    expect(hooks.log.mock.calls[0]?.[0]).toContain('forcing exit(1)');
  });

  it('a third signal also escalates (signalCount keeps incrementing)', async () => {
    const hooks = makeHooks({ shutdownDelay: 50 });
    const handler = createSignalHandler({
      runShutdown: hooks.runShutdown,
      exit: hooks.exit,
      setImmediate: hooks.setImmediateFn,
      log: hooks.log,
    });
    void handler('SIGINT');
    await handler('SIGINT'); // exit(1)
    await handler('SIGINT'); // exit(1) again
    const exit1Calls = hooks.exit.mock.calls.filter(c => c[0] === 1).length;
    expect(exit1Calls).toBe(2);
  });
});
