// HS-9392 (docs/122, the HS-9389 proposal phase 1) — ticket-commit discovery +
// linear grouping for the detail panel's "Code Review" aggregate button.
//
// Discovery matches the ticket ref in the commit SUBJECT line only (word-boundary):
// the HS-9389 investigation showed body mentions are routinely cross-references
// ("Follow-up from HS-9384") whose diffs are UNRELATED — a subject `HS-NNNN:` is
// the repo's authorship convention. Groups are runs of commits CONSECUTIVE in
// history (positions in the rev list): one linear group reviews as a single
// `--range oldest^..newest`; interleaved groups feed the client chooser, alongside
// the overall earliest→latest span with its unrelated-commit count.
//
// Git is shelled via the injectable `GitRunner` from `git/runner.ts` (async
// spawn — load-resilience P1); the pure matching + grouping logic is exported
// for direct unit tests.

import { defaultGit, type GitRunner } from '../git/runner.js';
import { pushAll } from '../utils/largeArray.js';

/** One commit as discovered from `git log` (order: as emitted, newest first). */
export interface CommitEntry {
  sha: string;
  subject: string;
  /** Committer date, ISO (`%cI`). */
  date: string;
}

/** A run of ticket commits consecutive in history — reviewable as one range. */
export interface CommitGroup {
  /** Range base (`<oldest>^`); review shows `from..to`. */
  from: string;
  /** Newest commit of the group. */
  to: string;
  count: number;
  /** Subjects, newest first (bounded by the caller's log window). */
  subjects: string[];
  earliestDate: string;
  latestDate: string;
  /** Ref the group was found on — absent for HEAD, else the integration branch. */
  ref?: string;
}

export interface TicketCommitsResult {
  /** Linear groups, newest first. Empty when no commits reference the ticket. */
  groups: CommitGroup[];
  /** The earliest→latest span across ALL HEAD groups (null when 0 or 1 group).
   *  `unrelatedCount` = non-ticket commits inside the span. */
  span: { from: string; to: string; unrelatedCount: number } | null;
  /** Working tree has uncommitted changes (for the started-ticket fallback). */
  dirty: boolean;
}

/** Word-boundary ticket-ref matcher (mirrors `prNotesReader`'s: `HS-938` must not
 *  match `HS-9384`, nor `XHS-9384`). */
function ticketRefRegExp(ticketNumber: string): RegExp {
  const escaped = ticketNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, 'i');
}

/** Pure: the entries whose SUBJECT references the ticket (word-boundary). */
export function matchTicketCommits(entries: readonly CommitEntry[], ticketNumber: string): CommitEntry[] {
  const re = ticketRefRegExp(ticketNumber);
  return entries.filter(e => re.test(e.subject));
}

/**
 * Pure: cluster matched commits into linear groups. `entries` is the FULL bounded
 * log (newest first — its indexes are the history positions); `matched` must be a
 * subset. Commits at consecutive positions form one group. Returns groups newest
 * first. A group whose oldest commit is the last entry of the log window still
 * uses `<sha>^` as the base — only the (practically irrelevant) repo-root commit
 * lacks a parent, and the client falls back to `--commit` for single-commit groups.
 */
export function groupLinearCommits(entries: readonly CommitEntry[], matched: readonly CommitEntry[], ref?: string): CommitGroup[] {
  const position = new Map<string, number>();
  entries.forEach((e, i) => position.set(e.sha, i));
  const sorted = [...matched]
    .filter(m => position.has(m.sha))
    .sort((a, b) => position.get(a.sha)! - position.get(b.sha)!); // newest first
  const groups: CommitGroup[] = [];
  let current: CommitEntry[] = [];
  let prevPos = -2;
  const flush = (): void => {
    if (current.length === 0) return;
    const newest = current[0];
    const oldest = current[current.length - 1];
    groups.push({
      from: `${oldest.sha}^`,
      to: newest.sha,
      count: current.length,
      subjects: current.map(c => c.subject),
      earliestDate: oldest.date,
      latestDate: newest.date,
      ...(ref !== undefined ? { ref } : {}),
    });
    current = [];
  };
  for (const m of sorted) {
    const pos = position.get(m.sha)!;
    if (pos !== prevPos + 1) flush();
    current.push(m);
    prevPos = pos;
  }
  flush();
  return groups;
}

/** Pure: the overall earliest→latest span + its unrelated-commit count. Null when
 *  fewer than two groups (a single group needs no span option). */
export function spanForGroups(entries: readonly CommitEntry[], matched: readonly CommitEntry[]): TicketCommitsResult['span'] {
  if (matched.length === 0) return null;
  const position = new Map<string, number>();
  entries.forEach((e, i) => position.set(e.sha, i));
  const positions = matched.map(m => position.get(m.sha)).filter((p): p is number => p !== undefined).sort((a, b) => a - b);
  if (positions.length < 2) return null;
  const newestPos = positions[0];
  const oldestPos = positions[positions.length - 1];
  const spanSize = oldestPos - newestPos + 1;
  if (spanSize === positions.length) return null; // contiguous — it IS one group
  return {
    from: `${entries[oldestPos].sha}^`,
    to: entries[newestPos].sha,
    unrelatedCount: spanSize - positions.length,
  };
}

/** Log window bound — discovery never walks unbounded history. Tickets older than
 *  this many commits fall back to the notes-files aggregate (documented). */
const LOG_WINDOW = 2000;

const FIELD_SEP = '\x1f';

/** Parse `git log --format=%H%x1f%s%x1f%cI` output. Tolerates blank lines. */
export function parseLogOutput(out: string): CommitEntry[] {
  const entries: CommitEntry[] = [];
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue;
    const parts = line.split(FIELD_SEP);
    if (parts.length < 2) continue; // not a formatted log line (e.g. stray output)
    entries.push({ sha: parts[0], subject: parts[1], date: parts.length >= 3 ? parts[2] : '' });
  }
  return entries;
}

/** Small bounded cache — discovery re-runs only when a tip moved. */
interface CacheEntry { headTip: string; branchTip: string | null; result: TicketCommitsResult }
const cache = new Map<string, CacheEntry>();
const CACHE_MAX = 100;

/** Test hook. */
export function _resetTicketCommitsCacheForTesting(): void { cache.clear(); }

/**
 * Discover + group a ticket's commits. `integrationBranch` (a pending-integration
 * worker ticket's branch) contributes additional groups labeled with the ref for
 * commits not on HEAD. Never throws — a non-repo / git failure returns the empty
 * result (the section simply won't offer commit review).
 */
export async function discoverTicketCommits(
  repoRoot: string,
  ticketNumber: string,
  opts: { integrationBranch?: string | null; git?: GitRunner } = {},
): Promise<TicketCommitsResult> {
  const git = opts.git ?? defaultGit;
  const empty: TicketCommitsResult = { groups: [], span: null, dirty: false };
  try {
    const headTip = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();
    let branchTip: string | null = null;
    const branch = opts.integrationBranch ?? null;
    if (branch !== null && branch !== '') {
      branchTip = (await git(repoRoot, ['rev-parse', '--verify', '--quiet', branch]).catch(() => '')).trim() || null;
    }
    const key = `${repoRoot}\0${ticketNumber}`;
    const cached = cache.get(key);
    if (cached !== undefined && cached.headTip === headTip && cached.branchTip === branchTip) {
      // Tips unmoved — only re-probe dirtiness (cheap, and it changes without commits).
      return { ...cached.result, dirty: await isDirty(repoRoot, git) };
    }

    const headEntries = parseLogOutput(await git(repoRoot, ['log', '-n', String(LOG_WINDOW), `--format=%H${FIELD_SEP}%s${FIELD_SEP}%cI`, 'HEAD']));
    const headMatched = matchTicketCommits(headEntries, ticketNumber);
    const groups = groupLinearCommits(headEntries, headMatched);
    const span = spanForGroups(headEntries, headMatched);

    if (branchTip !== null) {
      const branchEntries = parseLogOutput(await git(repoRoot, ['log', '-n', String(LOG_WINDOW), `--format=%H${FIELD_SEP}%s${FIELD_SEP}%cI`, branchTip]));
      const headShas = new Set(headEntries.map(e => e.sha));
      const branchOnly = matchTicketCommits(branchEntries, ticketNumber).filter(e => !headShas.has(e.sha));
      pushAll(groups, groupLinearCommits(branchEntries, branchOnly, opts.integrationBranch ?? undefined));
    }

    const result: TicketCommitsResult = { groups, span, dirty: await isDirty(repoRoot, git) };
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { headTip, branchTip, result });
    return result;
  } catch {
    return empty;
  }
}

async function isDirty(repoRoot: string, git: GitRunner): Promise<boolean> {
  try {
    const out = await git(repoRoot, ['status', '--porcelain', '-uno', '--no-renames']);
    return out.trim() !== '';
  } catch {
    return false;
  }
}
