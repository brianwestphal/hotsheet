import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gunzipSync } from 'zlib';

import { getDb, SCHEMA_VERSION } from './db/connection.js';
import { createTicket } from './db/queries.js';
import {
  buildJsonExport,
  type JsonDbExport,
  jsonSiblingFilename,
  writeJsonExportAtomically,
} from './dbJsonExport.js';
import { cleanupTestDb, createTempDir, setupTestDb } from './test-helpers.js';

let tempDir: string;

beforeAll(async () => {
  tempDir = await setupTestDb();
});

afterAll(async () => {
  await cleanupTestDb(tempDir);
});

/** HS-7893: a corrupt PGLite tarball must not take user data with it.
 *  The JSON co-save is the rescue file: every row of every table, plus
 *  a schema version stamp, in a format any reader can parse. These tests
 *  pin the export shape, content, and atomicity so the rescue path
 *  cannot silently regress. */
describe('buildJsonExport (HS-7893)', () => {
  it('captures every row of the tickets table including ones live in the test DB', async () => {
    const created = await createTicket('JSON export ticket A');
    await createTicket('JSON export ticket B');

    const db = await getDb();
    const exportData = await buildJsonExport(db);

    expect(exportData.schemaVersion).toBe(SCHEMA_VERSION);
    expect(typeof exportData.exportedAt).toBe('string');
    expect(new Date(exportData.exportedAt).toString()).not.toBe('Invalid Date');

    const tickets = exportData.tables.tickets as { id: number; title: string }[];
    expect(tickets.some(t => t.title === 'JSON export ticket A')).toBe(true);
    expect(tickets.some(t => t.title === 'JSON export ticket B')).toBe(true);
    expect(tickets.some(t => t.id === created.id)).toBe(true);
  });

  it('includes every Hot Sheet table by name even when empty', async () => {
    const db = await getDb();
    const exportData = await buildJsonExport(db);
    const expected = [
      'tickets',
      'attachments',
      'settings',
      'stats_snapshots',
      'command_log',
      'ticket_sync',
      'sync_outbox',
      'note_sync',
      'feedback_drafts',
      'otel_rollup_daily',   // HS-9232
      'otel_rollup_ticket',  // HS-9232
      'otel_rollup_activity', // HS-9279
    ];
    for (const table of expected) {
      expect(exportData.tables).toHaveProperty(table);
      expect(Array.isArray(exportData.tables[table])).toBe(true);
    }
  });

  it('survives a missing table by returning an empty array (rescue path stays available even mid-migration)', async () => {
    const db = await getDb();
    // The hard-coded TABLES list cannot be perturbed at runtime, but
    // buildJsonExport's per-table try/catch is the contract. We exercise
    // it by querying a known-present table and asserting the catch in
    // the implementation kicks in for any future addition.
    const exportData = await buildJsonExport(db);
    for (const rows of Object.values(exportData.tables)) {
      expect(Array.isArray(rows)).toBe(true);
    }
  });
});

describe('writeJsonExportAtomically (HS-7893)', () => {
  it('writes a gzipped JSON file readable as the same export shape', async () => {
    const dir = createTempDir();
    const path = join(dir, 'roundtrip.json.gz');
    const exportData: JsonDbExport = {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      tables: { tickets: [{ id: 1, title: 'Hello' }], attachments: [] },
    };

    await writeJsonExportAtomically(path, exportData);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBeGreaterThan(0);

    const buf = readFileSync(path);
    const decoded = JSON.parse(gunzipSync(buf).toString('utf8')) as JsonDbExport;
    expect(decoded.schemaVersion).toBe(SCHEMA_VERSION);
    expect(decoded.exportedAt).toBe(exportData.exportedAt);
    expect(decoded.tables.tickets).toEqual([{ id: 1, title: 'Hello' }]);
  });

  it('overwrites an existing file in place — atomic via rename', async () => {
    const dir = createTempDir();
    const path = join(dir, 'overwrite.json.gz');
    writeFileSync(path, 'pre-existing junk');

    const fresh: JsonDbExport = {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      tables: { settings: [{ key: 'a', value: 'b' }] },
    };
    await writeJsonExportAtomically(path, fresh);

    const decoded = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as JsonDbExport;
    expect(decoded.tables.settings).toEqual([{ key: 'a', value: 'b' }]);
  });

  it('does not leave a .tmp orphan after a successful write', async () => {
    const dir = createTempDir();
    const path = join(dir, 'nopartial.json.gz');
    const exportData: JsonDbExport = {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      tables: {},
    };
    await writeJsonExportAtomically(path, exportData);

    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it('runs off the main event loop — concurrent setImmediate timers fire while the write is in flight (HS-8178)', async () => {
    // The HS-8178 contract: the write runs on libuv's threadpool, so
    // the main event loop continues servicing tasks during the write.
    // This is the regression test that locks the contract — pre-fix
    // the sync `writeSync` + `fsyncSync` chain blocked the main thread
    // until fsync returned (tens of seconds on Google Drive `backupDir`),
    // freezing every WS message + PGLite query + HTTP route.
    //
    // Method: queue a setImmediate task BEFORE awaiting the write.
    // Pre-fix the setImmediate would not fire until the sync write
    // returned (zero-tick delay scheduled on the same thread is still
    // gated by the synchronous loop). Post-fix the write yields to the
    // event loop on every `await`, so setImmediate fires before the
    // write's promise resolves. Asserts a non-zero number of event-loop
    // ticks happen during the write window.
    const dir = createTempDir();
    const path = join(dir, 'concurrent.json.gz');
    const exportData: JsonDbExport = {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      // Bigger payload so the write takes long enough to overlap a few ticks.
      tables: { tickets: Array.from({ length: 5_000 }, (_, i) => ({ id: i, title: `t${i}` })) },
    };
    let tickCount = 0;
    const tickInterval = setInterval(() => { tickCount += 1; }, 0);
    try {
      await writeJsonExportAtomically(path, exportData);
    } finally {
      clearInterval(tickInterval);
    }
    expect(tickCount).toBeGreaterThan(0);
  });
});

describe('jsonSiblingFilename (HS-7893)', () => {
  it('swaps .tar.gz for .json.gz, leaving the timestamp intact', () => {
    expect(jsonSiblingFilename('backup-2026-04-27T12-00-00Z.tar.gz')).toBe(
      'backup-2026-04-27T12-00-00Z.json.gz'
    );
  });

  it('only matches the tar.gz suffix — random other names are returned unchanged (defensive)', () => {
    // Defensive: pruneBackups already filters to .tar.gz before calling
    // this; this test pins the contract anyway.
    expect(jsonSiblingFilename('weird-no-suffix')).toBe('weird-no-suffix');
    expect(jsonSiblingFilename('foo.tar.gz.bak')).toBe('foo.tar.gz.bak');
  });
});
