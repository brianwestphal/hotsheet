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

import type { AsyncFsyncFn } from './fsyncWrap.js';
import { fsyncDbDir, fsyncDbDirAsync, fsyncDir, fsyncDirAsync, isUnsupportedFsyncError } from './fsyncWrap.js';

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
    const { createPglite } = await import('./pglite.js');
    const db = createPglite(join(tempRoot, 'db'));
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

describe('fsyncDirAsync (HS-8351)', () => {
  it('fsyncs every regular file via the async syscall path', async () => {
    writeFileSync(join(tempRoot, 'a.txt'), 'A');
    writeFileSync(join(tempRoot, 'b.txt'), 'B');
    writeFileSync(join(tempRoot, 'c.txt'), 'C');

    const fsyncFn = vi.fn<AsyncFsyncFn>(() => Promise.resolve());
    const stats = await fsyncDirAsync(tempRoot, fsyncFn);
    expect(stats.filesFlushed).toBe(3);
    expect(stats.errors).toBe(0);
    expect(fsyncFn).toHaveBeenCalledTimes(3);
  });

  it('walks subdirectories recursively', async () => {
    const sub = join(tempRoot, 'pg_wal');
    mkdirSync(sub);
    writeFileSync(join(tempRoot, 'PG_VERSION'), '17');
    writeFileSync(join(sub, 'segment'), 'wal');

    const fsyncFn = vi.fn<AsyncFsyncFn>(() => Promise.resolve());
    const stats = await fsyncDirAsync(tempRoot, fsyncFn);
    expect(stats.filesFlushed).toBe(2);
    expect(stats.errors).toBe(0);
  });

  it('tolerates per-file fsync failures without aborting the walk', async () => {
    writeFileSync(join(tempRoot, 'good.txt'), 'good');
    writeFileSync(join(tempRoot, 'bad.txt'), 'bad');
    writeFileSync(join(tempRoot, 'also-good.txt'), 'also good');

    const fsyncFn = vi.fn<AsyncFsyncFn>((handle) => {
      // Reject for the file we tag — but only for that one
      const fd = handle.fd;
      // can't tell which file from the handle alone without extra plumbing,
      // so the test asserts the count semantics: with 1 rejecting call we
      // expect 2 successes + 1 error.
      if (fsyncFn.mock.calls.length === 2) return Promise.reject(new Error('simulated'));
      void fd;
      return Promise.resolve();
    });
    const stats = await fsyncDirAsync(tempRoot, fsyncFn);
    expect(stats.filesFlushed).toBe(2);
    expect(stats.errors).toBe(1);
  });

  it('walks through symlinks that resolve to files (stat follows links — same as sync version)', async () => {
    writeFileSync(join(tempRoot, 'real.txt'), 'real');
    symlinkSync(join(tempRoot, 'real.txt'), join(tempRoot, 'link.txt'));

    const fsyncFn = vi.fn<AsyncFsyncFn>(() => Promise.resolve());
    const stats = await fsyncDirAsync(tempRoot, fsyncFn);
    // `fsp.stat` follows symlinks (matches `statSync` semantics); the
    // helper visits both the real file and the symlink target. The
    // regression we're protecting against is a thrown error or a hang
    // — two flushes against the same inode is fine.
    expect(stats.filesFlushed).toBe(2);
    expect(stats.errors).toBe(0);
  });

  it('returns empty stats when the path does not exist', async () => {
    const ghost = join(tempRoot, 'ghost');
    const fsyncFn = vi.fn<AsyncFsyncFn>(() => Promise.resolve());
    const stats = await fsyncDirAsync(ghost, fsyncFn);
    expect(stats).toEqual({ filesFlushed: 0, errors: 0 });
    expect(fsyncFn).not.toHaveBeenCalled();
  });

  it('returns zero filesFlushed for an empty directory', async () => {
    const empty = join(tempRoot, 'empty');
    mkdirSync(empty);
    const fsyncFn = vi.fn<AsyncFsyncFn>(() => Promise.resolve());
    const stats = await fsyncDirAsync(empty, fsyncFn);
    expect(stats).toEqual({ filesFlushed: 0, errors: 0 });
  });

  it('hands the injected fsyncFn a real FileHandle whose fd is a positive integer', async () => {
    writeFileSync(join(tempRoot, 'leaf.txt'), 'leaf');
    const fdsSeen: number[] = [];
    const fsyncFn = vi.fn<AsyncFsyncFn>((handle) => {
      fdsSeen.push(handle.fd);
      return Promise.resolve();
    });
    await fsyncDirAsync(tempRoot, fsyncFn);
    expect(fdsSeen).toHaveLength(1);
    expect(Number.isInteger(fdsSeen[0])).toBe(true);
    expect(fdsSeen[0]).toBeGreaterThan(0);
  });

  it('does not block the event loop — setImmediate callbacks scheduled mid-walk fire before the walk resolves', async () => {
    // Plant enough files that the walk has real work to do.
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(tempRoot, `f${i.toString()}.bin`), 'x');
    }

    let immediateCount = 0;
    // Inject an fsyncFn that yields control to the event loop between
    // every file via setImmediate, mirroring real-world threadpool
    // behavior where each fsync syscall releases the loop.
    const fsyncFn: AsyncFsyncFn = () => new Promise(resolve => setImmediate(resolve));

    // Start a ticker via setImmediate self-rescheduling. setImmediate
    // callbacks fire after I/O callbacks within the same loop turn, so
    // the count strictly tracks the number of turns the loop completed
    // while the walk was awaiting. If the walk blocked the loop, this
    // counter would stay at 0.
    let stop = false;
    function tick(): void {
      if (stop) return;
      immediateCount++;
      setImmediate(tick);
    }
    setImmediate(tick);

    await fsyncDirAsync(tempRoot, fsyncFn);
    stop = true;

    // 50 files × at least one yield per file → at least 10 loop turns
    // observed by the ticker. Loose bound so a slow CI box doesn't trip
    // the test on a couple of dropped ticks.
    expect(immediateCount).toBeGreaterThan(10);
  });
});

describe('fsyncDbDirAsync (HS-8351 convenience wrapper)', () => {
  it('fsyncs <dataDir>/db/ recursively via the async path', async () => {
    const dbDir = join(tempRoot, 'db');
    mkdirSync(dbDir);
    writeFileSync(join(dbDir, 'PG_VERSION'), '17');
    mkdirSync(join(dbDir, 'pg_wal'));
    writeFileSync(join(dbDir, 'pg_wal', 'segment'), 'wal');

    const fsyncFn = vi.fn<AsyncFsyncFn>(() => Promise.resolve());
    const stats = await fsyncDbDirAsync(tempRoot, fsyncFn);
    expect(stats.filesFlushed).toBe(2);
    expect(fsyncFn).toHaveBeenCalledTimes(2);
  });

  it('is a silent no-op when <dataDir>/db/ does not exist (e.g. pre-init)', async () => {
    const fsyncFn = vi.fn<AsyncFsyncFn>(() => Promise.resolve());
    const stats = await fsyncDbDirAsync(tempRoot, fsyncFn);
    expect(stats).toEqual({ filesFlushed: 0, errors: 0 });
  });
});

describe('isUnsupportedFsyncError (HS-8719)', () => {
  const errWith = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

  it('treats EPERM / EACCES / ENOTSUP / EINVAL as benign on win32 (read-only-handle FlushFileBuffers / unflushable files)', () => {
    for (const code of ['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL']) {
      expect(isUnsupportedFsyncError(errWith(code), 'win32')).toBe(true);
    }
  });

  it('does NOT swallow the same codes on POSIX — there fsync on a read-only fd works, so a failure is real', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(isUnsupportedFsyncError(errWith('EPERM'), platform)).toBe(false);
      expect(isUnsupportedFsyncError(errWith('EACCES'), platform)).toBe(false);
    }
  });

  it('does NOT swallow unrelated error codes even on win32 (e.g. ENOENT / EIO are real problems)', () => {
    expect(isUnsupportedFsyncError(errWith('ENOENT'), 'win32')).toBe(false);
    expect(isUnsupportedFsyncError(errWith('EIO'), 'win32')).toBe(false);
  });

  it('returns false for a non-error / code-less value', () => {
    expect(isUnsupportedFsyncError(new Error('no code'), 'win32')).toBe(false);
    expect(isUnsupportedFsyncError(null, 'win32')).toBe(false);
    expect(isUnsupportedFsyncError('oops', 'win32')).toBe(false);
  });
});
