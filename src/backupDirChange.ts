/**
 * HS-9532 — deciding whether an old `backupDir` left anything stranded.
 *
 * ## Why this is its own module, and why it is this careful
 *
 * `pruneBackups` and the attachment GC only ever operate on the CURRENTLY
 * configured `backupDir`. Change the setting and the previous tree is abandoned
 * in place — no retention, no GC, no trace. Measured on the maintainer's machine:
 * 3.31 GB stranded across 7 projects since a single settings change.
 *
 * The maintainer's decision (2026-07-31) is **inform only**: record the previous
 * root, tell the user, never move or delete anything automatically. So this
 * module's entire job is to answer "is there something stranded, and where" —
 * and to be *certain* before saying yes.
 *
 * ## The containment hazard (the reason for `classifyDirChange`)
 *
 * The old and new roots can overlap, and both directions are destructive if the
 * code assumes they are disjoint:
 *
 *   - **New inside old** (`~/Backups` → `~/Backups/hotsheet`): the "abandoned"
 *     tree CONTAINS the live one. Telling a user to delete it — with a button
 *     that does it — destroys the current backups while claiming to clean up
 *     stale ones.
 *   - **Old inside new** (`~/Backups/hotsheet` → `~/Backups`): the old tree is
 *     already inside the managed root. Nothing is stranded; offering to delete it
 *     is offering to delete part of the live set.
 *   - **Same path, different spelling**: `~/Backups` vs `/Users/x/Backups`, a
 *     symlink, or a case difference on macOS's case-insensitive default. A naive
 *     string compare calls that a change and "orphans" a tree that is still live.
 *
 * **Only `disjoint` may ever be reported as orphaned.** The other three are
 * silent, because in none of them is anything actually stranded.
 *
 * ## Why resolution has to be async and tolerant
 *
 * `realpath` collapses symlinks and `..`, which is what makes the comparison
 * mean anything. But the old root may be an unplugged drive or a dead cloud
 * folder — exactly the HS-9527 case — so a failure to resolve must degrade to
 * "cannot tell", never to "disjoint". Erring toward silence costs the user a
 * notice; erring the other way costs them backups.
 */

import { promises as fsp } from 'fs';
import { sep } from 'path';

/** How the old root relates to the new one. */
export type DirRelation = 'same' | 'old-contains-new' | 'new-contains-old' | 'disjoint' | 'unknown';

/** Only this relation means the old tree is genuinely stranded. */
export function isOrphanedRelation(relation: DirRelation): boolean {
  return relation === 'disjoint';
}

/**
 * Compare two already-resolved absolute paths.
 *
 * Split from the filesystem work so the containment logic — the part that must
 * not be wrong — is testable without creating directories or symlinks.
 *
 * `caseInsensitive` reflects the VOLUME, not the platform: macOS defaults to
 * case-insensitive but can be formatted either way, so the caller decides.
 */
export function compareResolvedDirs(
  oldDir: string,
  newDir: string,
  caseInsensitive: boolean,
): DirRelation {
  const norm = (p: string): string => {
    const trimmed = p.replace(/[/\\]+$/, '');
    return caseInsensitive ? trimmed.toLowerCase() : trimmed;
  };
  const a = norm(oldDir);
  const b = norm(newDir);
  if (a === b) return 'same';
  // Compare with a trailing separator so `/a/bc` is not treated as living inside
  // `/a/b`. Without it, any sibling sharing a name prefix reads as containment.
  if (b.startsWith(a + sep)) return 'old-contains-new';
  if (a.startsWith(b + sep)) return 'new-contains-old';
  return 'disjoint';
}

export interface ClassifyDeps {
  /** Injected for tests; defaults to `fs.promises.realpath`. */
  realpath?: (p: string) => Promise<string>;
  /** Whether the filesystem is case-insensitive. Defaults to true on darwin/win32. */
  caseInsensitive?: boolean;
}

const defaultCaseInsensitive = (): boolean => process.platform === 'darwin' || process.platform === 'win32';

/**
 * Resolve both paths and classify their relationship.
 *
 * Returns `'unknown'` when either path cannot be resolved — an unplugged drive, a
 * dead cloud mount, a deleted directory. That is deliberately NOT `'disjoint'`:
 * an unreachable old root might be the live one seen through a broken mount, and
 * the cost of guessing wrong is a user deleting real backups.
 */
export async function classifyDirChange(
  oldDir: string,
  newDir: string,
  deps: ClassifyDeps = {},
): Promise<DirRelation> {
  const realpath = deps.realpath ?? ((p: string) => fsp.realpath(p));
  const caseInsensitive = deps.caseInsensitive ?? defaultCaseInsensitive();
  if (oldDir.trim() === '' || newDir.trim() === '') return 'unknown';
  let a: string;
  let b: string;
  try {
    a = await realpath(oldDir);
  } catch {
    // The old root may simply no longer exist — but "gone" is not "stranded",
    // and we cannot prove it is disjoint from a path we cannot resolve.
    return 'unknown';
  }
  try {
    b = await realpath(newDir);
  } catch {
    return 'unknown';
  }
  return compareResolvedDirs(a, b, caseInsensitive);
}

/**
 * Add a root to the remembered list, deduplicated by RESOLVED path.
 *
 * Without resolution-based dedup, a user toggling between two spellings of one
 * folder (`~/Backups`, `/Users/x/Backups`, a symlink) accumulates a phantom
 * entry per toggle, each of which would later be reported as stranded.
 *
 * Pure over an already-resolved list so the ordering and cap rules are testable.
 * Newest first, because that is the one a user is most likely to act on.
 */
export const MAX_REMEMBERED_BACKUP_DIRS = 10;

export function rememberPreviousDir(
  existing: readonly string[],
  resolvedOldDir: string,
  resolvedCurrentDir: string,
  max: number = MAX_REMEMBERED_BACKUP_DIRS,
): string[] {
  if (resolvedOldDir === '' || resolvedOldDir === resolvedCurrentDir) return [...existing];
  const withoutDupes = existing.filter(p => p !== resolvedOldDir && p !== resolvedCurrentDir);
  return [resolvedOldDir, ...withoutDupes].slice(0, max);
}
