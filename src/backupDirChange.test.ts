/**
 * HS-9532 — containment classification for a changed `backupDir`.
 *
 * Every case here is a way to destroy real backups by telling a user a live tree
 * is abandoned. The maintainer raised the ancestor/descendant case specifically;
 * the same-path-different-spelling cases are the ones that look safe and are not.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  classifyDirChange,
  compareResolvedDirs,
  isOrphanedRelation,
  MAX_REMEMBERED_BACKUP_DIRS,
  rememberPreviousDir,
} from './backupDirChange.js';
import { readFileSettings, writeFileSettings } from './file-settings.js';

const tmps: string[] = [];
const mkTmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'hs-bdc-'));
  tmps.push(d);
  return d;
};
afterEach(() => {
  while (tmps.length > 0) {
    const d = tmps.pop();
    if (d !== undefined) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  }
});

describe('compareResolvedDirs', () => {
  it('detects an unrelated move as disjoint — the only reportable case', () => {
    expect(compareResolvedDirs('/a/old', '/b/new', false)).toBe('disjoint');
  });

  it('detects the NEW root living inside the OLD one', () => {
    // Deleting the "abandoned" tree here destroys the live backups inside it.
    expect(compareResolvedDirs('/Backups', '/Backups/hotsheet', false)).toBe('old-contains-new');
  });

  it('detects the OLD root living inside the NEW one', () => {
    // Nothing is stranded — the old tree is already inside the managed root.
    expect(compareResolvedDirs('/Backups/hotsheet', '/Backups', false)).toBe('new-contains-old');
  });

  it('treats an identical path as unchanged', () => {
    expect(compareResolvedDirs('/Backups', '/Backups', false)).toBe('same');
  });

  it('ignores a trailing separator', () => {
    expect(compareResolvedDirs('/Backups/', '/Backups', false)).toBe('same');
  });

  it('does NOT mistake a name-prefix sibling for containment', () => {
    // Without comparing on a separator boundary, `/a/backups-old` reads as living
    // inside `/a/backups` — and the sibling gets reported as part of the live set
    // (or vice versa), which is exactly backwards.
    expect(compareResolvedDirs('/a/backups', '/a/backups-old', false)).toBe('disjoint');
    expect(compareResolvedDirs('/a/backups-old', '/a/backups', false)).toBe('disjoint');
  });

  it('honors case-insensitivity when the volume is case-insensitive', () => {
    // macOS's default. A case difference names ONE directory, so calling it a
    // change would orphan a tree that is still live.
    expect(compareResolvedDirs('/Users/x/Backups', '/users/x/backups', true)).toBe('same');
    expect(compareResolvedDirs('/Users/x/Backups', '/users/x/backups', false)).toBe('disjoint');
  });

  it('applies case-insensitivity to containment too, not just equality', () => {
    expect(compareResolvedDirs('/Backups', '/backups/hotsheet', true)).toBe('old-contains-new');
  });
});

describe('isOrphanedRelation', () => {
  it('reports ONLY disjoint — every other relation has nothing stranded', () => {
    expect(isOrphanedRelation('disjoint')).toBe(true);
    for (const r of ['same', 'old-contains-new', 'new-contains-old', 'unknown'] as const) {
      expect(isOrphanedRelation(r), r).toBe(false);
    }
  });
});

describe('classifyDirChange', () => {
  it('resolves symlinks, so two names for one directory are `same`', async () => {
    // The case a string compare cannot see. Reporting this as a change would
    // point a delete button at the live backup tree.
    const root = mkTmp();
    const real = join(root, 'real');
    mkdirSync(real);
    const link = join(root, 'link');
    symlinkSync(real, link);
    expect(await classifyDirChange(link, real, { caseInsensitive: false })).toBe('same');
  });

  it('resolves `..` segments', async () => {
    const root = mkTmp();
    mkdirSync(join(root, 'a'));
    expect(await classifyDirChange(join(root, 'a', '..', 'a'), join(root, 'a'), { caseInsensitive: false })).toBe('same');
  });

  it('classifies a genuinely different directory as disjoint', async () => {
    const a = mkTmp();
    const b = mkTmp();
    expect(await classifyDirChange(a, b, { caseInsensitive: false })).toBe('disjoint');
  });

  it('returns `unknown` — never `disjoint` — when the OLD root cannot be resolved', async () => {
    // An unplugged drive or a dead cloud mount (the HS-9527 case). We cannot
    // prove it is unrelated to the new root, and guessing wrong means telling the
    // user to delete something live. Silence is the cheap error here.
    const b = mkTmp();
    expect(await classifyDirChange('/nope/does/not/exist', b, { caseInsensitive: false })).toBe('unknown');
  });

  it('returns `unknown` when the NEW root cannot be resolved', async () => {
    const a = mkTmp();
    expect(await classifyDirChange(a, '/nope/does/not/exist', { caseInsensitive: false })).toBe('unknown');
  });

  it('returns `unknown` for empty input rather than throwing', async () => {
    expect(await classifyDirChange('', '/x', { caseInsensitive: false })).toBe('unknown');
    expect(await classifyDirChange('/x', '   ', { caseInsensitive: false })).toBe('unknown');
  });

  it('does not let a realpath throw escape to the caller', async () => {
    // This runs on a settings-write path. A dead mount must not fail the write.
    const boom = (): Promise<string> => Promise.reject(new Error('EIO'));
    await expect(classifyDirChange('/a', '/b', { realpath: boom, caseInsensitive: false })).resolves.toBe('unknown');
  });
});

describe('rememberPreviousDir', () => {
  it('records the old root, newest first', () => {
    expect(rememberPreviousDir(['/older'], '/old', '/new')).toEqual(['/old', '/older']);
  });

  it('deduplicates by resolved path, so toggling does not accumulate phantoms', () => {
    // A user switching back and forth between two folders would otherwise grow
    // one bogus "stranded" entry per switch.
    expect(rememberPreviousDir(['/a', '/b'], '/a', '/new')).toEqual(['/a', '/b']);
  });

  it('never records the CURRENT root as a previous one', () => {
    // That would report the live tree as stranded — the worst possible output.
    expect(rememberPreviousDir([], '/same', '/same')).toEqual([]);
    expect(rememberPreviousDir(['/new'], '/old', '/new')).toEqual(['/old']);
  });

  it('caps the list so a churny user cannot grow it without bound', () => {
    let list: string[] = [];
    for (let i = 0; i < MAX_REMEMBERED_BACKUP_DIRS + 5; i++) {
      list = rememberPreviousDir(list, `/dir-${String(i)}`, '/current');
    }
    expect(list).toHaveLength(MAX_REMEMBERED_BACKUP_DIRS);
    expect(list[0]).toBe(`/dir-${String(MAX_REMEMBERED_BACKUP_DIRS + 4)}`); // newest kept
  });

  it('drops the current root out of an existing list', () => {
    // It may have been recorded as "previous" before the user switched back.
    expect(rememberPreviousDir(['/x', '/new'], '/old', '/new')).toEqual(['/old', '/x']);
  });
});

describe('writeFileSettings records the outgoing backupDir (HS-9532)', () => {
  it('captures the old root when backupDir changes', () => {
    const dir = mkTmp();
    writeFileSettings(dir, { backupDir: '/vol/first' });
    writeFileSettings(dir, { backupDir: '/vol/second' });
    expect(readFileSettings(dir).previousBackupDirs).toEqual(['/vol/first']);
  });

  it('does NOT record anything when backupDir is unchanged', () => {
    const dir = mkTmp();
    writeFileSettings(dir, { backupDir: '/vol/first' });
    writeFileSettings(dir, { backupDir: '/vol/first' });
    expect(readFileSettings(dir).previousBackupDirs ?? []).toEqual([]);
  });

  it('leaves an unrelated settings write completely alone', () => {
    // The common path. Folding history in here must not touch other writes.
    const dir = mkTmp();
    writeFileSettings(dir, { backupDir: '/vol/first' });
    writeFileSettings(dir, { appName: 'Something' });
    expect(readFileSettings(dir).previousBackupDirs ?? []).toEqual([]);
    expect(readFileSettings(dir).backupDir).toBe('/vol/first');
  });

  it('records nothing on the FIRST time backupDir is ever set', () => {
    // There is no previous root to strand.
    const dir = mkTmp();
    writeFileSettings(dir, { backupDir: '/vol/first' });
    expect(readFileSettings(dir).previousBackupDirs ?? []).toEqual([]);
  });

  it('accumulates across several moves, newest first', () => {
    const dir = mkTmp();
    for (const p of ['/a', '/b', '/c']) writeFileSettings(dir, { backupDir: p });
    expect(readFileSettings(dir).previousBackupDirs).toEqual(['/b', '/a']);
  });

  it('drops the root back out of history when the user switches back to it', () => {
    // Otherwise the CURRENT live root sits in the stranded list — the worst
    // possible thing to show a user next to a delete button.
    const dir = mkTmp();
    for (const p of ['/a', '/b', '/a']) writeFileSettings(dir, { backupDir: p });
    expect(readFileSettings(dir).previousBackupDirs).toEqual(['/b']);
  });
});
