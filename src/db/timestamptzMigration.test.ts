/**
 * HS-9654 — the TIMESTAMPTZ migration must be IDEMPOTENT: an already-migrated cluster
 * (every existing install, in steady state) must run ZERO `ALTER … TYPE TIMESTAMPTZ`.
 *
 * The old `initSchema` ran all 6 ALTERs unconditionally on EVERY cluster open and
 * swallowed the result. On a cluster where the no-op ALTER threw a non-benign,
 * non-storage error (`cache lookup failed for attribute 0 of relation 0`), that fired a
 * PGLite (WASM) error every open; under docs/128 cluster-eviction churn the repeated
 * throws became a WASM trap storm that pinned the event loop for 60 s → the §45
 * watchdog SIGKILLed the server (2026-08-14). Guarding the migration so it only ALTERs
 * columns still typed `timestamp without time zone` removes the error source entirely.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { migrateColumnsToTimestamptz } from './connection.js';

let db: PGlite | null = null;

afterEach(async () => {
  await db?.close();
  db = null;
});

async function columnType(d: PGlite, table: string, column: string): Promise<string | undefined> {
  const res = await d.query<{ data_type: string }>(
    `SELECT data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return res.rows[0]?.data_type;
}

describe('migrateColumnsToTimestamptz (HS-9654)', () => {
  it('migrates a legacy `timestamp without time zone` column, then is a no-op that runs NO further DDL', async () => {
    db = new PGlite();
    await db.exec(`CREATE TABLE tickets (id SERIAL PRIMARY KEY, created_at TIMESTAMP NOT NULL DEFAULT NOW());`);
    expect(await columnType(db, 'tickets', 'created_at')).toBe('timestamp without time zone');

    // First run migrates it.
    await migrateColumnsToTimestamptz(db, [['tickets', 'created_at']]);
    expect(await columnType(db, 'tickets', 'created_at')).toBe('timestamp with time zone');

    // Second run (the every-open steady state) must issue NO ALTER — that blind
    // re-ALTER was the throw-storm source. Spy on exec to prove zero DDL is sent.
    const execSpy = vi.spyOn(db, 'exec');
    await migrateColumnsToTimestamptz(db, [['tickets', 'created_at']]);
    expect(execSpy).not.toHaveBeenCalled();
    expect(await columnType(db, 'tickets', 'created_at')).toBe('timestamp with time zone');
  });

  it('runs NO DDL on a cluster that is already fully TIMESTAMPTZ (the fresh-CREATE case)', async () => {
    db = new PGlite();
    await db.exec(`CREATE TABLE tickets (id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
    const execSpy = vi.spyOn(db, 'exec');
    await migrateColumnsToTimestamptz(db, [['tickets', 'created_at']]);
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('only ALTERs the columns in the target set, ignoring other legacy timestamp columns', async () => {
    db = new PGlite();
    await db.exec(`
      CREATE TABLE tickets (id SERIAL PRIMARY KEY, created_at TIMESTAMP, unrelated_at TIMESTAMP);
    `);
    await migrateColumnsToTimestamptz(db, [['tickets', 'created_at']]);
    expect(await columnType(db, 'tickets', 'created_at')).toBe('timestamp with time zone');
    // A column not in the target set is left alone.
    expect(await columnType(db, 'tickets', 'unrelated_at')).toBe('timestamp without time zone');
  });
});
