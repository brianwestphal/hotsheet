/**
 * HS-9239 — the PGLite query-instrumentation Proxy must be transparent: it times
 * `query`/`exec`/`dumpDataDir` into freeze.log but must NOT change results or
 * break methods that rely on PGLite's private class fields (the Proxy
 * private-field hazard). These run against a real in-memory PGLite.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clusterInFlight, resetEvictionTrackingForTests } from './clusterEviction.js';
import { instrumentDbQueries, isClosedInstanceError, isQueryInstrumentationEnabled, setClusterReopener, setStorageFailureHandler } from './queryInstrumentation.js';

describe('instrumentDbQueries (HS-9239)', () => {
  afterEach(() => { delete process.env.HOTSHEET_DISABLE_QUERY_INSTRUMENTATION; resetEvictionTrackingForTests(); });

  it('passes query / exec results through unchanged', async () => {
    const db = new PGlite();
    const wrapped = instrumentDbQueries(db, '/tmp/hs-instr-test/db');
    await wrapped.exec('CREATE TABLE t (id int, name text)');
    await wrapped.query('INSERT INTO t VALUES (1, $1), (2, $2)', ['alice', 'bob']);
    const res = await wrapped.query<{ id: number; name: string }>('SELECT * FROM t ORDER BY id');
    expect(res.rows).toEqual([{ id: 1, name: 'alice' }, { id: 2, name: 'bob' }]);
    await db.close();
  });

  it('non-timed methods that touch private state (transaction) still work through the Proxy', async () => {
    const db = new PGlite();
    const wrapped = instrumentDbQueries(db, '/tmp/hs-instr-test/db');
    await wrapped.exec('CREATE TABLE t (id int)');
    await wrapped.transaction(async (tx) => {
      await tx.query('INSERT INTO t VALUES (1)');
      await tx.query('INSERT INTO t VALUES (2)');
    });
    const res = await wrapped.query<{ id: number }>('SELECT count(*)::int AS id FROM t');
    expect(res.rows[0].id).toBe(2);
    await db.close();
  });

  it('still wraps transparently when freeze-timing is disabled (HS-9420 — proxy is always applied for in-flight tracking)', async () => {
    process.env.HOTSHEET_DISABLE_QUERY_INSTRUMENTATION = '1';
    expect(isQueryInstrumentationEnabled()).toBe(false);
    const db = new PGlite();
    const wrapped = instrumentDbQueries(db, '/tmp/hs-instr-disabled/db');
    // Not the raw instance anymore — it's a proxy (the escape hatch only skips
    // freeze timing, not the in-flight bookkeeping the evictor depends on).
    expect(wrapped).not.toBe(db);
    await wrapped.exec('CREATE TABLE t (id int)');
    await wrapped.query('INSERT INTO t VALUES (42)');
    const res = await wrapped.query<{ id: number }>('SELECT id FROM t');
    expect(res.rows).toEqual([{ id: 42 }]);
    await db.close();
  });

  it('tracks in-flight query count for the cluster-eviction guard (HS-9420)', async () => {
    const dbPath = '/tmp/hs-instr-inflight/db';
    // A fake whose query resolves only when we say so, so we can observe the
    // count mid-flight.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fake = { query: (): Promise<unknown> => gate.then(() => ({ rows: [] })) } as unknown as PGlite;
    const wrapped = instrumentDbQueries(fake, dbPath);

    expect(clusterInFlight(dbPath)).toBe(0);
    const inFlight = wrapped.query('SELECT 1');
    expect(clusterInFlight(dbPath)).toBe(1); // counted while pending
    release();
    await inFlight;
    expect(clusterInFlight(dbPath)).toBe(0); // released on settle
  });

  it('releases the in-flight count even when the query rejects (HS-9420)', async () => {
    const dbPath = '/tmp/hs-instr-reject/db';
    const fake = { query: (): Promise<unknown> => Promise.reject(new Error('boom')) } as unknown as PGlite;
    const wrapped = instrumentDbQueries(fake, dbPath);
    await expect(wrapped.query('SELECT 1')).rejects.toThrow('boom');
    expect(clusterInFlight(dbPath)).toBe(0);
  });

  it('is enabled by default (env unset)', () => {
    expect(isQueryInstrumentationEnabled()).toBe(true);
  });
});

/**
 * HS-9461 — a cluster evicted out from under a live request left its holder with
 * a stale handle, and the next query threw `PGlite is closed` (surfacing to the
 * user as the app going "disconnected"). The proxy now reopens and retries once.
 *
 * These run against REAL PGLite instances so the retry sees the genuine
 * pre-flight rejection rather than a hand-rolled imitation of it.
 */
describe('stale-handle healing after eviction (HS-9461)', () => {
  afterEach(() => { setClusterReopener(null); resetEvictionTrackingForTests(); });

  /** Silence the "[db] reopened evicted cluster …" line the heal logs. */
  function quietConsole(): () => void {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    return () => { spy.mockRestore(); };
  }

  it('isClosedInstanceError matches only PGLite closed/closing pre-flight errors', () => {
    expect(isClosedInstanceError(new Error('PGlite is closed'))).toBe(true);
    expect(isClosedInstanceError(new Error('PGlite is closing'))).toBe(true);
    // Not the class: a real query failure, and the storage-corruption class
    // (HS-9458) which has its own recovery path and must NOT be retried here.
    expect(isClosedInstanceError(new Error('relation "t" does not exist'))).toBe(false);
    expect(isClosedInstanceError(new Error('xlog flush request 0/1 is not satisfied'))).toBe(false);
    expect(isClosedInstanceError(null)).toBe(false);
    expect(isClosedInstanceError(undefined)).toBe(false);
  });

  it('reopens and retries a query issued against an evicted instance', async () => {
    const restore = quietConsole();
    try {
      const dbPath = '/tmp/hs-instr-heal/db';
      const evicted = new PGlite();
      await evicted.exec('CREATE TABLE t (id int)');
      const stale = instrumentDbQueries(evicted, dbPath);
      await evicted.close(); // the eviction

      const fresh = new PGlite();
      await fresh.exec('CREATE TABLE t (id int); INSERT INTO t VALUES (7)');
      let seenPath: string | null = null;
      let calls = 0;
      setClusterReopener(async (p) => { calls += 1; seenPath = p; return await Promise.resolve(fresh); });

      // The caller still holds the OLD handle — it must transparently succeed.
      const res = await stale.query<{ id: number }>('SELECT id FROM t');
      expect(res.rows).toEqual([{ id: 7 }]);
      expect(calls).toBe(1);
      expect(seenPath).toBe(dbPath);
      expect(clusterInFlight(dbPath)).toBe(0); // balanced across the heal
      await fresh.close();
    } finally { restore(); }
  });

  it('propagates the original error when no reopener is registered', async () => {
    const db = new PGlite();
    await db.exec('CREATE TABLE t (id int)');
    const stale = instrumentDbQueries(db, '/tmp/hs-instr-noreopener/db');
    await db.close();
    setClusterReopener(null);
    await expect(stale.query('SELECT 1')).rejects.toThrow('PGlite is closed');
    expect(clusterInFlight('/tmp/hs-instr-noreopener/db')).toBe(0);
  });

  it('propagates when the reopener DECLINES — deliberate close or shutdown', async () => {
    // The decline path is what stops a late request resurrecting a cluster that
    // `closeDbForDir` closed on purpose, or one `closeAllDatabases` is retiring.
    const dbPath = '/tmp/hs-instr-declined/db';
    const db = new PGlite();
    await db.exec('CREATE TABLE t (id int)');
    const stale = instrumentDbQueries(db, dbPath);
    await db.close();
    let calls = 0;
    setClusterReopener(async () => { calls += 1; return await Promise.resolve(null); });
    await expect(stale.query('SELECT 1')).rejects.toThrow('PGlite is closed');
    expect(calls).toBe(1);
    expect(clusterInFlight(dbPath)).toBe(0);
  });

  it('does NOT reopen for an ordinary query error', async () => {
    const dbPath = '/tmp/hs-instr-realerror/db';
    const db = new PGlite();
    const wrapped = instrumentDbQueries(db, dbPath);
    let calls = 0;
    setClusterReopener(async () => { calls += 1; return await Promise.resolve(null); });
    await expect(wrapped.query('SELECT * FROM nope')).rejects.toThrow(/nope/);
    expect(calls).toBe(0); // the reopener must not be consulted
    expect(clusterInFlight(dbPath)).toBe(0);
    await db.close();
  });

  it('retries only ONCE — a still-closed replacement surfaces the error', async () => {
    // Guards against a reopen loop if the replacement is itself unusable.
    const restore = quietConsole();
    try {
      const dbPath = '/tmp/hs-instr-once/db';
      const first = new PGlite();
      await first.exec('CREATE TABLE t (id int)');
      const stale = instrumentDbQueries(first, dbPath);
      await first.close();
      const second = new PGlite();
      await second.exec('CREATE TABLE t (id int)');
      await second.close();
      let calls = 0;
      setClusterReopener(async () => { calls += 1; return await Promise.resolve(second); });
      await expect(stale.query('SELECT 1')).rejects.toThrow('PGlite is closed');
      expect(calls).toBe(1); // exactly one reopen attempt, no loop
      expect(clusterInFlight(dbPath)).toBe(0);
    } finally { restore(); }
  });

  it('heals exec as well as query', async () => {
    const restore = quietConsole();
    try {
      const dbPath = '/tmp/hs-instr-heal-exec/db';
      const evicted = new PGlite();
      await evicted.exec('CREATE TABLE t (id int)');
      const stale = instrumentDbQueries(evicted, dbPath);
      await evicted.close();
      const fresh = new PGlite();
      await fresh.exec('CREATE TABLE t (id int)');
      setClusterReopener(async () => await Promise.resolve(fresh));
      await stale.exec('INSERT INTO t VALUES (3)');
      const res = await fresh.query<{ id: number }>('SELECT id FROM t');
      expect(res.rows).toEqual([{ id: 3 }]);
      await fresh.close();
    } finally { restore(); }
  });
});

/**
 * HS-9460 — the storage-corruption class (docs/73 §73.5.1) appearing on a LIVE
 * query, not at open. Unlike the closed-instance case above this is NOT
 * retryable: the cluster is broken on disk and every write fails identically
 * until the process restarts. The proxy's job is only to notice it and report.
 */
describe('live storage-failure detection (HS-9460)', () => {
  afterEach(() => {
    setClusterReopener(null);
    setStorageFailureHandler(null);
    resetEvictionTrackingForTests();
  });

  const walError = (): Error =>
    new Error('xlog flush request 0/3BA18488 is not satisfied --- flushed only to 0/3BA175E0');

  it('reports a storage failure and propagates the error unchanged', async () => {
    const dbPath = '/tmp/hs-instr-storage/db';
    const seen: Array<{ dbPath: string; message: string }> = [];
    setStorageFailureHandler((p, err) => { seen.push({ dbPath: p, message: (err as Error).message }); });
    const fake = { query: (): Promise<unknown> => Promise.reject(walError()) } as unknown as PGlite;
    const wrapped = instrumentDbQueries(fake, dbPath);

    await expect(wrapped.query('INSERT INTO t VALUES (1)')).rejects.toThrow(/xlog flush request/);
    expect(seen).toHaveLength(1);
    expect(seen[0].dbPath).toBe(dbPath);
    expect(clusterInFlight(dbPath)).toBe(0);
  });

  it('does NOT try to reopen/retry a storage failure', async () => {
    // Reopening cannot help — the corruption is on disk, so a retry would just
    // fail again while masking the real failure behind a second one.
    const dbPath = '/tmp/hs-instr-storage-noretry/db';
    let reopens = 0;
    setClusterReopener(async () => { reopens += 1; return await Promise.resolve(null); });
    setStorageFailureHandler(() => { /* noticed */ });
    let calls = 0;
    const fake = {
      query: (): Promise<unknown> => { calls += 1; return Promise.reject(walError()); },
    } as unknown as PGlite;
    const wrapped = instrumentDbQueries(fake, dbPath);

    await expect(wrapped.query('SELECT 1')).rejects.toThrow(/xlog flush request/);
    expect(calls).toBe(1);   // ran once
    expect(reopens).toBe(0); // reopener never consulted
  });

  it('does not fire for a closed instance or an ordinary query error', async () => {
    // The two classes must stay separate: a closed instance HEALS (HS-9461), an
    // ordinary error is just an error. Neither should mark a cluster corrupt.
    const dbPath = '/tmp/hs-instr-storage-negative/db';
    let reports = 0;
    setStorageFailureHandler(() => { reports += 1; });

    const closed = { query: (): Promise<unknown> => Promise.reject(new Error('PGlite is closed')) } as unknown as PGlite;
    await expect(instrumentDbQueries(closed, dbPath).query('SELECT 1')).rejects.toThrow('PGlite is closed');
    expect(reports).toBe(0);

    const ordinary = { query: (): Promise<unknown> => Promise.reject(new Error('relation "t" does not exist')) } as unknown as PGlite;
    await expect(instrumentDbQueries(ordinary, dbPath).query('SELECT 1')).rejects.toThrow(/does not exist/);
    expect(reports).toBe(0);
  });

  it('reports every failing query (dedup is the handler\'s job, not the proxy\'s)', async () => {
    // The class fails EVERY write, so the proxy would otherwise need to know
    // about per-cluster state. It stays dumb; `connection.ts` dedups per dataDir
    // so the marker is written and logged once.
    const dbPath = '/tmp/hs-instr-storage-repeat/db';
    let reports = 0;
    setStorageFailureHandler(() => { reports += 1; });
    const fake = { query: (): Promise<unknown> => Promise.reject(walError()) } as unknown as PGlite;
    const wrapped = instrumentDbQueries(fake, dbPath);
    for (let i = 0; i < 3; i += 1) {
      await expect(wrapped.query('SELECT 1')).rejects.toThrow(/xlog/);
    }
    expect(reports).toBe(3);
  });
});
