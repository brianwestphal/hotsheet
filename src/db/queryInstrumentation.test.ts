/**
 * HS-9239 — the PGLite query-instrumentation Proxy must be transparent: it times
 * `query`/`exec`/`dumpDataDir` into freeze.log but must NOT change results or
 * break methods that rely on PGLite's private class fields (the Proxy
 * private-field hazard). These run against a real in-memory PGLite.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

import { clusterInFlight, resetEvictionTrackingForTests } from './clusterEviction.js';
import { instrumentDbQueries, isQueryInstrumentationEnabled } from './queryInstrumentation.js';

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
