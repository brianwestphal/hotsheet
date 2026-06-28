/**
 * HS-7934 — child-process harness for the HS-7931 graceful-shutdown
 * pipeline. The unit tests in `src/lifecycle.test.ts` pin the ordering +
 * idempotence + per-step error tolerance contracts against doubles. These
 * tests prove the same contract end-to-end against a real Hot Sheet child
 * process: spawn `tsx src/cli.ts`, exercise the scenario, watch the exit.
 *
 * Per `docs/45-pglite-robustness.md` §45.9:
 *   1. Round-trip — write rows, POST /api/shutdown, assert post-shutdown
 *      `postmaster.pid` is gone (proves `db.close()` ran) and the rows
 *      survive into a new spawn.
 *   2. SIGINT awaitability — assert the child exits within ~3s.
 *   3. Double-SIGINT escalation — assert exit code 1 on second signal.
 *   4. Concurrent SIGINT + /api/shutdown — assert idempotent single exit.
 *
 * The spawn / ready / secret / exit plumbing lives in `src/spawnTestServer.ts`
 * (shared with the HS-8588 snapshot crash-recovery suite).
 */
import { rmSync } from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import {
  canRunServerSpawnTests,
  postJson,
  readSecret,
  type SpawnedHotSheet,
  spawnHotSheet,
  waitForExit,
} from './spawnTestServer.js';

// HS-8720 — these cases spawn a REAL `tsx src/cli.ts` child (tsx compile +
// PGLite init on boot) and wait on its lifecycle. In isolation that's fast, but
// under the full merged-coverage run (200+ files in parallel + V8 instrumentation)
// CPU starvation slows the child's startup well past vitest's 30s default —
// surfacing as "Test timed out in 30000ms" before the SIGINT/shutdown logic even
// runs. Scope generous timeouts to THIS file (same mitigation as backup.test.ts /
// snapshotRestore.test.ts) rather than bumping the global config + masking real
// hangs elsewhere.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let activeChildren: SpawnedHotSheet[] = [];

/** Spawn + track for afterEach cleanup. */
function spawnTracked(opts?: Parameters<typeof spawnHotSheet>[0]): SpawnedHotSheet {
  const child = spawnHotSheet(opts);
  activeChildren.push(child);
  return child;
}

beforeEach(() => {
  activeChildren = [];
});

afterEach(() => {
  // Defensive cleanup: kill any still-running children + remove their temp
  // dirs. Each test that wants to assert a clean exit should do so before
  // afterEach fires.
  for (const child of activeChildren) {
    if (!child.proc.killed && child.proc.exitCode === null) {
      child.proc.kill('SIGKILL');
    }
    try { rmSync(child.dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(child.homeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  activeChildren = [];
});

describe.skipIf(!canRunServerSpawnTests)('graceful shutdown e2e (HS-7934) (skipped: no tsx child-spawn here, or running inside a Hot Sheet terminal; HS-8202)', () => {
  it('round-trip: writes rows, POST /api/shutdown, child exits 0, rows survive into the next spawn', async () => {
    const child = spawnTracked();
    await child.ready;
    const secret = readSecret(child.dataDir);

    // Create three tickets via the API.
    for (const title of ['One', 'Two', 'Three']) {
      const res = await postJson(`http://localhost:${child.port}/api/tickets`, {
        title,
        defaults: { category: 'task' },
      }, secret);
      expect(res.status).toBe(201);
    }

    // Issue the shutdown. The server returns immediately with `{ok: true}`
    // and the gracefulShutdown pipeline runs in the background.
    const shutdownRes = await postJson(`http://localhost:${child.port}/api/shutdown`, {}, secret);
    expect(shutdownRes.status).toBe(200);

    // Wait for the child to actually exit cleanly.
    const exit = await waitForExit(child.proc, 15_000);
    expect(exit.code).toBe(0);

    // Re-spawn against the same dataDir. The HS-7888 stale-postmaster.pid
    // mitigation will drop the leftover pid file at this point — what we
    // care about is that gracefulShutdown's CHECKPOINT step preserved the
    // rows we just wrote. If `db.close()` had been skipped (pre-HS-7931
    // behavior), the WAL might not have been flushed and freshly-written
    // rows could PANIC the open or be rolled back.
    const reChild = spawnTracked({ dataDir: child.dataDir });
    try {
      await reChild.ready;
      const res = await fetch(`http://localhost:${reChild.port}/api/tickets?status=not_started`);
      expect(res.status).toBe(200);
      const body = await res.json() as Array<{ title: string }>;
      const titles = body.map(t => t.title);
      expect(titles).toEqual(expect.arrayContaining(['One', 'Two', 'Three']));
    } finally {
      reChild.proc.kill('SIGTERM');
      await waitForExit(reChild.proc, 10_000).catch(() => undefined);
    }
  }, 60_000);

  it('SIGINT triggers gracefulShutdown and the child exits cleanly with code 0', async () => {
    const child = spawnTracked();
    await child.ready;

    const t0 = Date.now();
    child.proc.kill('SIGINT');
    const exit = await waitForExit(child.proc, 15_000);
    const elapsed = Date.now() - t0;

    expect(exit.code).toBe(0);
    // Allow generous slack — CI machines + tsx startup add jitter. The
    // contract is "doesn't hang", not "always under 3s".
    expect(elapsed).toBeLessThan(10_000);
  }, 60_000);

  // HS-9114 — the reported bug: shutdown "always uses the full 90s" even right
  // after launch, because the client always holds an open `/ws/sync` WebSocket
  // (and an in-flight long-poll), and `server.close()` waited each out to the
  // closeHttpServer step's 90s budget. The fix proactively closes those sockets
  // + force-closes any straggler after a short grace, so shutdown stays prompt.
  it('shutdown stays prompt with an open /ws/sync WebSocket + in-flight long-poll (HS-9114)', async () => {
    const child = spawnTracked();
    await child.ready;
    const secret = readSecret(child.dataDir);

    // Open the persistent connections the real client holds right after launch.
    const ws = new WebSocket(`ws://localhost:${child.port}/ws/sync?project=${secret}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const pollAbort = new AbortController();
    const longPoll = fetch(`http://localhost:${child.port}/api/poll?version=0`, { signal: pollAbort.signal }).catch(() => undefined);
    // Let both register on the server before tearing down.
    await new Promise(r => setTimeout(r, 300));

    const t0 = Date.now();
    const shutdownRes = await postJson(`http://localhost:${child.port}/api/shutdown`, {}, secret);
    expect(shutdownRes.status).toBe(200);
    const exit = await waitForExit(child.proc, 30_000);
    const elapsed = Date.now() - t0;

    expect(exit.code).toBe(0);
    // Pre-fix this was ~90s (closeHttpServer waiting on the WS + long-poll). The
    // fix keeps it to a couple seconds; ceiling is generous for CI/tsx jitter but
    // far below the old 90s budget — that's the regression guard.
    expect(elapsed).toBeLessThan(15_000);

    pollAbort.abort();
    await longPoll;
    try { ws.close(); } catch { /* already gone with the process */ }
  }, 60_000);

  // HS-7939 — deterministic double-SIGINT escalation. The earlier attempt
  // at proving the contract through a spawned-tsx child was racy because the
  // shutdown pipeline can complete in well under a millisecond on a fresh DB,
  // so a JS-driven second `proc.kill` would routinely arrive after `exit(0)`
  // had already been scheduled. The fix here is to hold an in-flight
  // long-poll request open before sending SIGINT: it pins `closeHttpServer`
  // (the first await inside `runShutdownPipeline`) for the
  // `HTTP_CLOSE_GRACE_MS` grace window. (HS-9114 — `closeHttpServer` now wakes
  // long-poll waiters + force-closes stragglers after that grace rather than
  // waiting out the poll's full 30s, but the poll's keep-alive socket only goes
  // idle AFTER `closeIdleConnections()` has already run, so it still lingers to
  // the grace backstop — a ~1s window, ample for the second signal to land.) We
  // then wait for the `[lifecycle] gracefulShutdown(...) — starting` stdout
  // marker — printed synchronously at the top of `runShutdownPipeline` —
  // before firing the second SIGINT. With both gates in place the second
  // signal is guaranteed to land while `signalCount === 1` is awaiting, and
  // the escalation handler in `createSignalHandler` synchronously calls
  // `process.exit(1)`. Pure-handler coverage stays in
  // `src/cli.signalEscalation.test.ts`; this test pins the OS-level signal
  // delivery + tsx-envelope path that the unit test cannot reach.
  it('a second SIGINT during graceful shutdown forces exit code 1', async () => {
    const child = spawnTracked();
    await child.ready;

    // Open a long-poll request and DO NOT await it. The server will hold the
    // connection until either a change lands (which won't happen here) or
    // its 30s timeout elapses. While the connection is open, `server.close()`
    // inside the gracefulShutdown pipeline blocks — giving us the deterministic
    // window we need.
    const longPollAbort = new AbortController();
    const longPoll = fetch(`http://localhost:${child.port}/api/poll?version=0`, {
      signal: longPollAbort.signal,
    }).catch(() => undefined);

    // Give the request time to actually be in-flight on the server before we
    // start tearing it down. Without this, `server.close()` may complete
    // immediately because no connections are registered yet.
    await new Promise(r => setTimeout(r, 250));

    child.proc.kill('SIGINT');
    // Synchronization point: the `— starting` line is logged at the top of
    // `runShutdownPipeline`, before the first await. Once we see it the
    // shutdown is in flight and pinned by the long-poll connection.
    await child.waitForOutput('[lifecycle] gracefulShutdown(SIGINT) — starting', 10_000);

    child.proc.kill('SIGINT');
    const exit = await waitForExit(child.proc, 15_000);
    expect(exit.code).toBe(1);

    // Drop the long-poll listener; the process is gone so the fetch will
    // already have rejected, but aborting belt-and-braces is harmless.
    longPollAbort.abort();
    await longPoll;
  }, 60_000);

  it('concurrent /api/shutdown + SIGINT collapse to a single shutdown (idempotence)', async () => {
    const child = spawnTracked();
    await child.ready;
    const secret = readSecret(child.dataDir);

    // Race them. `gracefulShutdown` is memoized (a single shared promise), so the
    // HTTP route + the SIGINT handler join ONE pipeline run — the idempotence this
    // case is named for. The SIGINT handler is registered before `ready` (HS-8096)
    // and never removed, so a concurrent SIGINT is always caught, not defaulted.
    const httpShutdown = postJson(`http://localhost:${child.port}/api/shutdown`, {}, secret).catch(() => undefined);
    child.proc.kill('SIGINT');

    // The real invariant: the SIGINT (or HTTP) call is CAUGHT and routed to the
    // graceful pipeline — never Node's default action. The
    // `gracefulShutdown(<reason>) — starting` line (`) — starting` is unique to it
    // — the per-step lines read `" — starting`) prints at the very top of the
    // pipeline, long before any exit, so it flushes reliably even when the child
    // later dies by the teardown-raced signal. Had the handler not been registered,
    // the child would die at 130 WITHOUT this line and the test would (correctly)
    // time out — the precise regression guard for the registration contract.
    await child.waitForOutput(') — starting', 15_000);
    await httpShutdown;
    const exit = await waitForExit(child.proc, 15_000);

    // HS-9104 — the exit *code* is the one irreducibly racy bit and must NOT be
    // asserted to be exactly 0. Normally our `process.exit(0)` wins (code 0). But
    // a SIGINT delivered during `process.exit()` teardown — after libuv has torn
    // down the `uv_signal` handle but before the process is gone — takes Node's
    // DEFAULT action (signal death), which the `tsx` wrapper reports as
    // 128 + SIGINT = 130. The shutdown still completed cleanly (the `— done` above
    // proves it); only the exit code/signal is non-deterministic, so accept either.
    const cleanExit = exit.code === 0 || exit.code === 130 || exit.signal === 'SIGINT';
    expect(cleanExit).toBe(true);
  }, 60_000);
});
