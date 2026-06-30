/**
 * HS-9225 — the PGLite query-instrumentation Proxy must be transparent: it times
 * `query`/`exec`/`dumpDataDir` into freeze.log but must NOT change results or
 * break methods that rely on PGLite's private class fields (the Proxy
 * private-field hazard). These run against a real in-memory PGLite.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

import { instrumentDbQueries, isQueryInstrumentationEnabled } from './queryInstrumentation.js';

describe('instrumentDbQueries (HS-9225)', () => {
  afterEach(() => { delete process.env.HOTSHEET_DISABLE_QUERY_INSTRUMENTATION; });

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

  it('returns the RAW instance (no Proxy) when disabled via env', () => {
    process.env.HOTSHEET_DISABLE_QUERY_INSTRUMENTATION = '1';
    const fake = { query: (): void => undefined } as unknown as PGlite;
    expect(instrumentDbQueries(fake, '/tmp/x/db')).toBe(fake);
    expect(isQueryInstrumentationEnabled()).toBe(false);
  });

  it('is enabled by default (env unset)', () => {
    expect(isQueryInstrumentationEnabled()).toBe(true);
  });
});
