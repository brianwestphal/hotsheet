/**
 * HS-9536 — reporting stranded backup roots.
 *
 * The dangerous output here is a path shown next to "these backups are
 * abandoned". Every test is about NOT saying that when it isn't true.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { _resetBackupFsForTests } from './backupFs.js';
import { findStrandedBackupRoots, measureRoot } from './strandedBackups.js';

const tmps: string[] = [];
const mkTmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'hs-stranded-'));
  tmps.push(d);
  return d;
};
/** Build a backup root with `n` tarballs in the given tier. */
const seedTier = (root: string, tier: string, n: number, bytes = 128): void => {
  mkdirSync(join(root, tier), { recursive: true });
  for (let i = 0; i < n; i++) {
    writeFileSync(join(root, tier, `backup-2026-07-31T0${String(i)}-00-00Z.tar.gz`), Buffer.alloc(bytes));
  }
};

afterEach(() => {
  _resetBackupFsForTests();
  while (tmps.length > 0) {
    const d = tmps.pop();
    if (d !== undefined) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  }
});

describe('measureRoot', () => {
  it('sums tarballs across tiers and reports the newest', async () => {
    const root = mkTmp();
    seedTier(root, '5min', 2, 100);
    seedTier(root, 'daily', 1, 50);
    const m = await measureRoot(root);
    expect(m.sizeBytes).toBe(250);
    expect(m.tierCount).toBe(2);
    expect(m.newestBackupAt).not.toBeNull();
  });

  it('reports nothing for an empty root rather than a zero-size entry', async () => {
    const root = mkTmp();
    mkdirSync(join(root, '5min'), { recursive: true });
    const m = await measureRoot(root);
    expect(m.tierCount).toBe(0);
    expect(m.newestBackupAt).toBeNull();
  });

  it('ignores non-tarball files', async () => {
    const root = mkTmp();
    seedTier(root, '5min', 1, 100);
    writeFileSync(join(root, '5min', 'backup-2026-07-31T00-00-00Z.json.gz'), Buffer.alloc(999));
    expect((await measureRoot(root)).sizeBytes).toBe(100);
  });

  it('does not throw for a root that does not exist', async () => {
    // The common case after the user cleans up by hand.
    const m = await measureRoot('/definitely/not/here');
    expect(m.tierCount).toBe(0);
  });
});

describe('findStrandedBackupRoots', () => {
  const measure = () => Promise.resolve({ sizeBytes: 1024, newestBackupAt: '2026-06-29T00:00:00.000Z', tierCount: 3 });

  it('reports a disjoint root', async () => {
    const out = await findStrandedBackupRoots(['/old'], '/new', {
      classify: () => Promise.resolve('disjoint'), measure,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ path: '/old', sizeBytes: 1024, tierCount: 3 });
  });

  it('drops every relation that is NOT disjoint', async () => {
    // The containment cases. Showing any of these next to a path is telling the
    // user their live backups are abandoned.
    for (const relation of ['same', 'old-contains-new', 'new-contains-old', 'unknown']) {
      const out = await findStrandedBackupRoots(['/old'], '/new', {
        classify: () => Promise.resolve(relation), measure,
      });
      expect(out, relation).toEqual([]);
    }
  });

  it('reports nothing when there is no current backupDir to compare against', async () => {
    // With no current root, no relation can be established — and only a PROVEN
    // disjoint is reportable.
    for (const current of [undefined, '', '   ']) {
      const out = await findStrandedBackupRoots(['/old'], current, {
        classify: () => Promise.resolve('disjoint'), measure,
      });
      expect(out).toEqual([]);
    }
  });

  it('drops a root that holds no backups — a cleaned-up folder is not news', async () => {
    const out = await findStrandedBackupRoots(['/old'], '/new', {
      classify: () => Promise.resolve('disjoint'),
      measure: () => Promise.resolve({ sizeBytes: 0, newestBackupAt: null, tierCount: 0 }),
    });
    expect(out).toEqual([]);
  });

  it('keeps a root whose size is UNKNOWN — the path is still the useful part', async () => {
    // An unreachable cloud folder. We cannot size it, but "backups remain at
    // <path>" is still true and actionable.
    const out = await findStrandedBackupRoots(['/old'], '/new', {
      classify: () => Promise.resolve('disjoint'),
      measure: () => Promise.resolve({ sizeBytes: null, newestBackupAt: null, tierCount: 2 }),
    });
    expect(out).toHaveLength(1);
    expect(out[0].sizeBytes).toBeNull();
  });

  it('evaluates every remembered root independently', async () => {
    const relations = new Map([['/a', 'disjoint'], ['/b', 'same'], ['/c', 'disjoint']]);
    const out = await findStrandedBackupRoots(['/a', '/b', '/c'], '/new', {
      classify: (oldDir) => Promise.resolve(relations.get(oldDir) ?? 'unknown'), measure,
    });
    expect(out.map(r => r.path)).toEqual(['/a', '/c']);
  });

  it('end-to-end against real directories, with the real classifier', async () => {
    const stranded = mkTmp();
    seedTier(stranded, '5min', 2, 64);
    const current = mkTmp();
    const out = await findStrandedBackupRoots([stranded], current);
    expect(out).toHaveLength(1);
    expect(out[0].sizeBytes).toBe(128);
  });

  it('end-to-end: a root CONTAINING the current one is not reported', async () => {
    // The maintainer's case, through the real classifier and real paths.
    const outer = mkTmp();
    seedTier(outer, '5min', 1);
    const inner = join(outer, 'nested');
    mkdirSync(inner, { recursive: true });
    expect(await findStrandedBackupRoots([outer], inner)).toEqual([]);
  });
});
