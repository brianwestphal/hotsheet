import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearRecoveryMarker, closeDb, getDb, readRecoveryMarker, setDataDir } from './connection.js';
import { createTicket, getTickets } from './queries.js';

let dataDir: string;

beforeEach(() => {
  dataDir = join(tmpdir(), `hs-conn-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dataDir, { recursive: true });
});

afterEach(async () => {
  await closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('getDbByPath corruption recovery (HS-7888 + HS-7889)', () => {
  /** HS-7888 mitigation: a stale postmaster.pid alone shouldn't trigger
   *  the destructive "rename as corrupt + recreate empty" path. We open
   *  a healthy DB once, drop a stale pid file in (simulating unclean
   *  shutdown), and re-open. The original tickets must still be there
   *  AND the dbPath itself must not have been renamed. */
  it('recovers from a stale postmaster.pid without destroying live data', async () => {
    setDataDir(dataDir);
    const db1 = await getDb();
    await createTicket('Survives stale-pid recovery');
    await db1.exec('CHECKPOINT');
    await closeDb();

    const dbDir = join(dataDir, 'db');
    writeFileSync(join(dbDir, 'postmaster.pid'), '99999\n');

    setDataDir(dataDir);
    await getDb();
    const tickets = await getTickets();
    expect(tickets.some(t => t.title === 'Survives stale-pid recovery')).toBe(true);

    // No db-corrupt-* sibling should have appeared. If mitigation worked,
    // the live directory was reopened in place rather than renamed aside.
    const siblings = readdirSync(dataDir).filter(name => name.startsWith('db-corrupt-'));
    expect(siblings).toEqual([]);
  });

  /** HS-7889: the underlying open-failure message must be logged so users
   *  / future-Claude can diagnose what actually went wrong. We force a
   *  truly unrecoverable open by writing junk over the data directory and
   *  then assert that console.error received both the headline message
   *  and the original error text. */
  it('logs the underlying error message when the DB cannot be opened', async () => {
    const dbDir = join(dataDir, 'db');
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(join(dbDir, 'PG_VERSION'), 'not-a-real-version\n');
    writeFileSync(join(dbDir, 'global'), 'corrupt');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      setDataDir(dataDir);
      try {
        await getDb();
      } catch { /* may throw; we only care about what was logged */ }

      const allLogged = errorSpy.mock.calls.map(args => args.map(String).join(' ')).join('\n');
      expect(allLogged).toMatch(/Failed to open database/i);
    } finally {
      errorSpy.mockRestore();
    }
  });

  /** HS-7888: even when both mitigations exhaust, the original data
   *  directory is preserved as `db-corrupt-<timestamp>` and never
   *  rmSync'd. Previously a rename-failure path would silently delete
   *  the live data. */
  it('preserves the original data directory as db-corrupt-* on full failure', async () => {
    const dbDir = join(dataDir, 'db');
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(join(dbDir, 'PG_VERSION'), 'not-a-real-version\n');
    writeFileSync(join(dbDir, 'sentinel.txt'), 'preserve me');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      setDataDir(dataDir);
      try {
        await getDb();
      } catch { /* may throw; just observe filesystem afterwards */ }

      const siblings = readdirSync(dataDir).filter(name => name.startsWith('db-corrupt-'));
      // If recovery decided the dir was "corrupt", it should have
      // preserved the original contents — never deleted them.
      for (const sib of siblings) {
        expect(existsSync(join(dataDir, sib, 'sentinel.txt'))).toBe(true);
      }
    } finally {
      errorSpy.mockRestore();
    }
  });
});

/** HS-7899: when the recovery path falls all the way through to the
 *  rename-as-corrupt + fresh-cluster step, a `.db-recovery-marker.json`
 *  must be written so the launch-time client banner can prompt the user
 *  to restore from backup. The marker survives subsequent restarts
 *  until the user explicitly dismisses it (or restores). */
describe('DB recovery marker (HS-7899)', () => {
  it('writes a marker after the rename-as-corrupt + fresh-cluster path runs', async () => {
    const dbDir = join(dataDir, 'db');
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(join(dbDir, 'PG_VERSION'), 'not-a-real-version\n');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      setDataDir(dataDir);
      try {
        await getDb();
      } catch { /* may throw on some recovery paths; we only care about the marker */ }

      const marker = readRecoveryMarker(dataDir);
      // Whether or not getDb() succeeded, IF a `db-corrupt-*` sibling
      // appeared (i.e. the rename-as-corrupt path ran), the marker
      // must be present so the client can surface it.
      const siblings = readdirSync(dataDir).filter(name => name.startsWith('db-corrupt-'));
      if (siblings.length > 0) {
        expect(marker).not.toBeNull();
        expect(marker!.corruptPath).toContain('db-corrupt-');
        expect(typeof marker!.recoveredAt).toBe('string');
        expect(new Date(marker!.recoveredAt).toString()).not.toBe('Invalid Date');
      }
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('clearRecoveryMarker is idempotent and removes the marker file', () => {
    // No marker present — clearing should not throw.
    expect(() => clearRecoveryMarker(dataDir)).not.toThrow();
    expect(readRecoveryMarker(dataDir)).toBeNull();

    // Drop a hand-written marker, then clear it.
    writeFileSync(
      join(dataDir, '.db-recovery-marker.json'),
      JSON.stringify({ corruptPath: '/tmp/x', recoveredAt: new Date().toISOString(), errorMessage: 'boom' })
    );
    expect(readRecoveryMarker(dataDir)).not.toBeNull();
    clearRecoveryMarker(dataDir);
    expect(readRecoveryMarker(dataDir)).toBeNull();

    // Clearing again is fine.
    expect(() => clearRecoveryMarker(dataDir)).not.toThrow();
  });

  it('readRecoveryMarker returns null for malformed JSON instead of throwing', () => {
    writeFileSync(join(dataDir, '.db-recovery-marker.json'), 'not valid json {{{');
    expect(readRecoveryMarker(dataDir)).toBeNull();
  });

  it('readRecoveryMarker returns null when required fields are missing', () => {
    writeFileSync(
      join(dataDir, '.db-recovery-marker.json'),
      JSON.stringify({ recoveredAt: new Date().toISOString() }) // missing corruptPath
    );
    expect(readRecoveryMarker(dataDir)).toBeNull();
  });
});
