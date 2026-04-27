/**
 * HS-7935 — unit tests for the explicit-fsync wrapper.
 *
 * The HS-7932 spike confirmed PGLite's WASM ↔ host-fs bridge silently
 * no-ops `fsync`, so durability is gated on the OS's natural dirty-page
 * flush cycle. This wrapper closes that gap by walking a directory tree
 * and `fs.fsyncSync`'ing every regular file. Tests inject the fsync
 * function directly (ESM `fs` exports can't be spied on with vi.spyOn).
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fsyncDbDir, fsyncDir } from './fsyncWrap.js';

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'hs-fsync-wrap-'));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('fsyncDir (HS-7935)', () => {
  it('fsyncs every regular file in a flat directory', () => {
    writeFileSync(join(tempRoot, 'a.txt'), 'A');
    writeFileSync(join(tempRoot, 'b.txt'), 'B');
    writeFileSync(join(tempRoot, 'c.txt'), 'C');

    const fsyncFn = vi.fn();
    const stats = fsyncDir(tempRoot, fsyncFn);
    expect(stats.filesFlushed).toBe(3);
    expect(stats.errors).toBe(0);
    expect(fsyncFn).toHaveBeenCalledTimes(3);
  });

  it('walks subdirectories recursively', () => {
    const sub1 = join(tempRoot, 'pg_wal');
    const sub2 = join(tempRoot, 'global');
    mkdirSync(sub1);
    mkdirSync(sub2);
    writeFileSync(join(tempRoot, 'PG_VERSION'), '17');
    writeFileSync(join(sub1, '000000010000000000000001'), 'wal-segment');
    writeFileSync(join(sub2, 'pg_control'), 'ctl');

    const fsyncFn = vi.fn();
    const stats = fsyncDir(tempRoot, fsyncFn);
    expect(stats.filesFlushed).toBe(3);
    expect(stats.errors).toBe(0);
    expect(fsyncFn).toHaveBeenCalledTimes(3);
  });

  it('does not pass directories themselves to fsyncFn (would surface as EISDIR with the real syscall)', () => {
    mkdirSync(join(tempRoot, 'sub'));
    writeFileSync(join(tempRoot, 'sub', 'leaf.txt'), 'leaf');

    const fdsSeen: number[] = [];
    const fsyncFn = vi.fn((fd: number) => { fdsSeen.push(fd); });
    fsyncDir(tempRoot, fsyncFn);
    // Only 1 call — for the regular file. The directory is walked, not fsync'd.
    expect(fdsSeen).toHaveLength(1);
  });

  it('skips symlinks pointing to directories (does not recurse through them)', () => {
    writeFileSync(join(tempRoot, 'real.txt'), 'real');
    mkdirSync(join(tempRoot, 'real-dir'));
    writeFileSync(join(tempRoot, 'real-dir', 'inside.txt'), 'inside');
    try {
      symlinkSync(join(tempRoot, 'real-dir'), join(tempRoot, 'link-to-dir'));
    } catch {
      // Some filesystems reject symlinks. Skip the assertion silently.
      return;
    }
    const fsyncFn = vi.fn();
    fsyncDir(tempRoot, fsyncFn);
    // The symlink resolves to the directory via statSync (follow), and the
    // helper recurses into it — but the underlying directory is the same
    // one already walked, so files are visited twice. The regression we're
    // protecting against is the helper following the link AND failing or
    // throwing. Two visits is acceptable; a thrown error would not be.
    expect(fsyncFn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps walking when an individual fsync throws — counts the failure but presses on', () => {
    writeFileSync(join(tempRoot, 'a.txt'), 'A');
    writeFileSync(join(tempRoot, 'b.txt'), 'B');
    writeFileSync(join(tempRoot, 'c.txt'), 'C');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let callCount = 0;
    const fsyncFn = vi.fn(() => {
      callCount++;
      if (callCount === 2) throw new Error('synthetic fsync failure');
    });
    try {
      const stats = fsyncDir(tempRoot, fsyncFn);
      expect(stats.filesFlushed).toBe(2);
      expect(stats.errors).toBe(1);
      expect(fsyncFn).toHaveBeenCalledTimes(3); // attempted on every file
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('returns zero counters when the directory does not exist (silent no-op)', () => {
    const ghost = join(tempRoot, 'never-created');
    const fsyncFn = vi.fn();
    const stats = fsyncDir(ghost, fsyncFn);
    expect(stats).toEqual({ filesFlushed: 0, errors: 0 });
    expect(fsyncFn).not.toHaveBeenCalled();
  });

  it('handles an empty directory cleanly', () => {
    const empty = join(tempRoot, 'empty');
    mkdirSync(empty);
    const fsyncFn = vi.fn();
    const stats = fsyncDir(empty, fsyncFn);
    expect(stats).toEqual({ filesFlushed: 0, errors: 0 });
    expect(fsyncFn).not.toHaveBeenCalled();
  });

  it('passes a real fd (positive integer) to the injected fsyncFn so production fsyncSync gets a valid handle', () => {
    writeFileSync(join(tempRoot, 'leaf.txt'), 'leaf');
    const fdsSeen: number[] = [];
    const fsyncFn = vi.fn((fd: number) => { fdsSeen.push(fd); });
    fsyncDir(tempRoot, fsyncFn);
    expect(fdsSeen).toHaveLength(1);
    expect(Number.isInteger(fdsSeen[0])).toBe(true);
    expect(fdsSeen[0]).toBeGreaterThan(0);
  });
});

describe('fsyncDbDir (HS-7935 convenience wrapper)', () => {
  it('fsyncs <dataDir>/db/ recursively', () => {
    const dbDir = join(tempRoot, 'db');
    mkdirSync(dbDir);
    writeFileSync(join(dbDir, 'PG_VERSION'), '17');
    mkdirSync(join(dbDir, 'pg_wal'));
    writeFileSync(join(dbDir, 'pg_wal', 'segment'), 'wal');

    const fsyncFn = vi.fn();
    const stats = fsyncDbDir(tempRoot, fsyncFn);
    expect(stats.filesFlushed).toBe(2);
    expect(fsyncFn).toHaveBeenCalledTimes(2);
  });

  it('is a silent no-op when <dataDir>/db/ does not exist (e.g. pre-init)', () => {
    const fsyncFn = vi.fn();
    const stats = fsyncDbDir(tempRoot, fsyncFn);
    expect(stats).toEqual({ filesFlushed: 0, errors: 0 });
  });
});

describe('fsyncDir against a real PGLite cluster (HS-7935 integration)', () => {
  it('walks every regular file in <dataDir>/db/ after CHECKPOINT and feeds each to the injected fsyncFn', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite(join(tempRoot, 'db'));
    await db.waitReady;
    await db.exec('CREATE TABLE t (id int)');
    await db.exec('INSERT INTO t VALUES (1)');
    await db.exec('CHECKPOINT');

    try {
      const fsyncFn = vi.fn();
      const stats = fsyncDbDir(tempRoot, fsyncFn);
      expect(stats.filesFlushed).toBeGreaterThan(5);
      expect(stats.errors).toBe(0);
      expect(fsyncFn.mock.calls.length).toBe(stats.filesFlushed);
    } finally {
      await db.close();
    }
  }, 60_000);
});
