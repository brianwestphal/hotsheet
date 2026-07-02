import type { GitStatusFiles, GitStatusWithFiles, PendingCommit } from '../api/git.js';
import { getGitStatusWithFiles, getGlassboxStatus, getPendingCommits, gitReveal, reviewInGlassbox } from '../api/index.js';
import { toElement } from './dom.js';
import { showToast } from './toast.js';
import { openWorktreesPanel } from './worktreesPanel.js';

/**
 * HS-7956 — Phase 3 expanded popover for the sidebar git status chip.
 * Anchored below the chip; non-modal (per the §12.10 popup pattern —
 * outside clicks DO NOT auto-close, only an explicit X / chip-click
 * dismisses).
 *
 * Sections:
 *   - Branch line: `main → origin/main` / `main (no upstream)` / `(detached: <SHA>)`
 *   - Ahead/behind line (only when upstream): `3 ahead • 1 behind`
 *   - Working-tree section: bucket counters (clickable to expand into a
 *     file list — fetched on demand via `?files=true`)
 *
 * File-row interactions:
 *   - Click → HS-9205: open the file's diff in Glassbox (`glassbox --files <path>`
 *     via `POST /api/glassbox/review` mode `files`) when Glassbox is installed;
 *     otherwise reveal in the file manager via `POST /api/git/reveal`.
 *   - Right-click → context menu with "Reveal in Finder" + "Copy path"
 *
 * See docs/48-git-status-tracker.md §48.4.2.
 */

// HS-8522 — `GitStatusFiles` + `GitStatusWithFiles` are the shared types from
// `src/api/git.ts` (single source of truth). They replace the local
// `GitStatusFiles` + `GitStatusJson` duplicates this file used to declare.
const CLOSE_ICON = <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>;
// HS-9068 — lucide `git-branch` glyph for the "Manage worktrees" header button.
const WORKTREE_ICON = <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>;

let activePopover: HTMLElement | null = null;
let activeAnchor: HTMLElement | null = null;

/** Toggle the popover anchored under `anchor`. If the popover is already
 *  open, closes it. Idempotent on repeated calls — the chip's click
 *  handler can call this on every click without bookkeeping. */
export function toggleGitStatusPopover(anchor: HTMLElement): void {
  if (activePopover !== null) {
    closePopover();
    return;
  }
  void openPopover(anchor);
}

function closePopover(): void {
  if (activePopover !== null) {
    activePopover.remove();
    activePopover = null;
  }
  activeAnchor = null;
}

async function openPopover(anchor: HTMLElement): Promise<void> {
  activeAnchor = anchor;

  // Immediately mount a "Loading…" overlay so the click feels responsive.
  const popover = toElement(
    <div className="git-popover" role="dialog" aria-label="Git status">
      <div className="git-popover-header">
        <span className="git-popover-title">Loading…</span>
        {/* HS-9068 — "Manage worktrees" moved out of the body into the header
            line as an iconic button, sitting just before the close button.
            Worktree management is independent of the loaded git status, so it
            lives in the always-present header (no wait for the fetch). */}
        <div className="git-popover-header-actions">
          <button className="git-popover-worktrees-btn" type="button" title="Manage worktrees">{WORKTREE_ICON}</button>
          <button className="git-popover-close" type="button" title="Close">{CLOSE_ICON}</button>
        </div>
      </div>
      <div className="git-popover-body"></div>
    </div>
  );
  popover.querySelector('.git-popover-close')!.addEventListener('click', closePopover);
  popover.querySelector('.git-popover-worktrees-btn')!.addEventListener('click', () => { openWorktreesPanel(); });
  document.body.appendChild(popover);
  activePopover = popover;
  positionPopover(popover, anchor);

  // Fetch with files=true so we can populate the bucket file lists when
  // the user expands them. Single round-trip.
  let data: GitStatusWithFiles | null = null;
  try {
    data = await getGitStatusWithFiles();
  } catch {
    /* network error — bail to a friendly message below */
  }
  if (activePopover !== popover) return; // user already dismissed during the fetch
  if (data === null) {
    popover.querySelector('.git-popover-title')!.textContent = 'Git unavailable';
    popover.querySelector<HTMLElement>('.git-popover-body')!.replaceChildren(toElement(
      <div className="git-popover-empty">Couldn't read the git state for this project.</div>
    ));
    return;
  }
  paintPopover(popover, data);
}

/** Pure: build the branch-line text. Exported for tests. */
export function buildBranchLine(status: GitStatusWithFiles): string {
  if (status.detached) return `(detached: ${status.branch})`;
  if (status.upstream === null) return `${status.branch} (no upstream)`;
  return `${status.branch} → ${status.upstream}`;
}

/** Pure: build the ahead/behind line, or null when no upstream OR both are
 *  zero (in which case the popover hides the line entirely). Exported for
 *  tests. */
export function buildAheadBehindLine(status: GitStatusWithFiles): string | null {
  if (status.upstream === null) return null;
  if (status.ahead === 0 && status.behind === 0) return 'up to date';
  const parts: string[] = [];
  if (status.ahead > 0) parts.push(`${status.ahead} ahead`);
  if (status.behind > 0) parts.push(`${status.behind} behind`);
  return parts.join(' • ');
}

export function paintPopover(popover: HTMLElement, data: GitStatusWithFiles): void {
  const titleEl = popover.querySelector<HTMLElement>('.git-popover-title');
  const bodyEl = popover.querySelector<HTMLElement>('.git-popover-body');
  if (titleEl === null || bodyEl === null) return;
  titleEl.textContent = buildBranchLine(data);

  // HS-9205 — a file-row click opens that file's diff in Glassbox when it's
  // installed, else reveals it in the file manager. Resolve availability once, up
  // front; the fetch settles well before any click (fall back to reveal until it does).
  let glassboxAvailable = false;
  void getGlassboxStatus().then(s => { glassboxAvailable = s.available; }).catch(() => { /* treat as unavailable */ });

  const ab = buildAheadBehindLine(data);

  // HS-7974 — fetch row removed (last-fetched-at line + "Fetch now" button).
  // The user explicitly asked for it gone; the chip stays read-only.
  bodyEl.replaceChildren();
  if (ab !== null) bodyEl.appendChild(toElement(<div className="git-popover-ab">{ab}</div>));

  // HS-8472 — pending (unpushed) commits. Placeholder mounted in order (after
  // ahead/behind, before the working-tree buckets); filled async since the
  // commit list + Glassbox availability are separate fetches.
  if (data.upstream !== null && data.ahead > 0) {
    const commitsEl = toElement(<div className="git-popover-commits"></div>);
    bodyEl.appendChild(commitsEl);
    void mountPendingCommits(commitsEl, data.upstream);
  }

  const bucketsEl = toElement(<div className="git-popover-buckets"></div>);
  for (const row of [
    bucketRow('staged', 'Staged', data.staged, data.files),
    bucketRow('unstaged', 'Unstaged', data.unstaged, data.files),
    bucketRow('untracked', 'Untracked', data.untracked, data.files),
    bucketRow('conflicted', 'Conflicted', data.conflicted, data.files),
  ]) {
    if (row !== null) bucketsEl.appendChild(row);
  }
  // HS-7975 follow-up — only mount the buckets element when there's at least
  // one bucket to show. Pre-fix the buckets div's `border-top` rendered as a
  // bare horizontal separator in the popover whenever the working tree was
  // clean (e.g. just "1 ahead" with no staged / unstaged / untracked /
  // conflicted files), which the user flagged as visual noise.
  if (bucketsEl.children.length > 0) bodyEl.appendChild(bucketsEl);

  // Wire bucket-row expand/collapse toggles.
  bodyEl.querySelectorAll<HTMLElement>('.git-popover-bucket-header').forEach(header => {
    header.addEventListener('click', () => {
      const bucket = header.closest<HTMLElement>('.git-popover-bucket');
      if (bucket === null) return;
      bucket.classList.toggle('is-expanded');
    });
  });

  // Wire file-row clicks — HS-9205: open the file's diff in Glassbox when it's
  // installed, else reveal in the file manager. Right-click always offers both
  // "Reveal in Finder" and "Copy Path".
  bodyEl.querySelectorAll<HTMLElement>('.git-popover-file').forEach(row => {
    row.addEventListener('click', () => {
      const path = row.dataset.path;
      if (path === undefined) return;
      if (glassboxAvailable) {
        void launchGlassboxReview({ mode: 'files', patterns: [path] });
      } else {
        void gitReveal({ path }).catch(() => { /* ignore */ });
      }
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showFileContextMenu(row, e);
    });
  });

  // HS-9068 — the "Manage worktrees" entry moved to the header (built in
  // `openPopover`); the "Worker pool" + "In-flight work" entries moved out of
  // this popover entirely onto the sidebar (`#sidebar-worker-actions`, wired in
  // `app.tsx`), so the popover body now ends at the working-tree buckets.
}

/** Opaque `isConnected` read so TS can't narrow it across an `await`. */
function stillMounted(el: HTMLElement): boolean {
  return el.isConnected;
}

/** Pure: the first up-to-3 non-blank lines of a commit body, joined with `\n`.
 *  Empty string when the body has no content beyond the subject. Exported for
 *  tests (HS-8472). */
export function commitBodyPreview(body: string): string {
  return body.split('\n').map(l => l.trimEnd()).filter(l => l.trim() !== '').slice(0, 3).join('\n');
}

/**
 * HS-8472 — fill the pending-commits placeholder: list each unpushed commit
 * (short hash + subject + up to 3 body lines) and, when Glassbox is installed,
 * a per-commit "Review" link plus an "Open all pending changes in Glassbox"
 * link that reviews the whole `<upstream>..HEAD` range in one session.
 */
async function mountPendingCommits(container: HTMLElement, upstream: string): Promise<void> {
  let commits: PendingCommit[];
  let truncated = false;
  try {
    const res = await getPendingCommits();
    commits = res.commits;
    truncated = res.truncated;
  } catch {
    return; // best-effort — leave the section empty on a fetch failure
  }
  // `stillMounted` reads `isConnected` opaquely so TS doesn't narrow it to a
  // constant across the `await` below — the popover can be dismissed mid-fetch,
  // and the post-await re-check is the whole point.
  if (!stillMounted(container) || commits.length === 0) return;

  let glassboxAvailable = false;
  try { glassboxAvailable = (await getGlassboxStatus()).available; } catch { /* treat as unavailable */ }
  if (!stillMounted(container)) return;

  const section = toElement(
    <div className="git-popover-commits-inner">
      <div className="git-popover-commits-header">Pending commits</div>
    </div>
  );
  for (const c of commits) section.appendChild(commitRow(c, glassboxAvailable));
  if (truncated) {
    section.appendChild(toElement(<div className="git-popover-commits-more">…and more not shown</div>));
  }
  if (glassboxAvailable) {
    const allBtn = toElement(
      <button className="git-popover-commits-review-all" type="button">Open all pending changes in Glassbox</button>
    );
    allBtn.addEventListener('click', () => {
      void launchGlassboxReview({ mode: 'range', from: upstream, to: 'HEAD' });
    });
    section.appendChild(allBtn);
  }
  container.replaceChildren(section);
}

function commitRow(c: PendingCommit, glassboxAvailable: boolean): HTMLElement {
  const bodyPreview = commitBodyPreview(c.body);
  const row = toElement(
    <div className="git-popover-commit">
      <div className="git-popover-commit-main">
        <code className="git-popover-commit-hash" title={c.hash}>{c.shortHash}</code>
        <span className="git-popover-commit-subject" title={c.subject}>{c.subject}</span>
        {glassboxAvailable
          ? <button className="git-popover-commit-review" type="button" title="Review this commit in Glassbox">Review</button>
          : null}
      </div>
      {bodyPreview !== '' ? <div className="git-popover-commit-body">{bodyPreview}</div> : null}
    </div>
  );
  if (glassboxAvailable) {
    row.querySelector<HTMLButtonElement>('.git-popover-commit-review')!.addEventListener('click', () => {
      void launchGlassboxReview({ mode: 'commit', sha: c.hash });
    });
  }
  return row;
}

/** Fire a Glassbox review request, surfacing the same friendly failure toast as
 *  the toolbar Glassbox button. */
async function launchGlassboxReview(req: Parameters<typeof reviewInGlassbox>[0]): Promise<void> {
  try {
    await reviewInGlassbox(req);
  } catch {
    showToast('Could not open Glassbox. Make sure the Glassbox CLI is installed.', { variant: 'warning' });
  }
}

function bucketRow(kind: 'staged' | 'unstaged' | 'untracked' | 'conflicted', label: string, count: number, files: GitStatusFiles | undefined): HTMLElement | null {
  if (count === 0) return null;
  const list = files !== undefined ? files[kind] : [];
  const truncated = files !== undefined ? files.truncated[kind] : false;
  const moreCount = truncated ? count - list.length : 0;
  const root = toElement(
    <div className={`git-popover-bucket git-popover-bucket-${kind}`}>
      <button className="git-popover-bucket-header" type="button">
        <span className="git-popover-bucket-chevron">▶</span>
        <span className="git-popover-bucket-count">{String(count)}</span>
        <span className="git-popover-bucket-label">{label}</span>
      </button>
      <div className="git-popover-bucket-files"></div>
    </div>
  );
  const filesEl = root.querySelector('.git-popover-bucket-files');
  if (filesEl !== null) {
    for (const path of list) {
      filesEl.appendChild(toElement(
        <div className="git-popover-file" data-path={path} title={path}>{path}</div>
      ));
    }
    if (moreCount > 0) {
      filesEl.appendChild(toElement(
        <div className="git-popover-file-more">{`…and ${moreCount} more`}</div>
      ));
    }
  }
  return root;
}

function showFileContextMenu(row: HTMLElement, e: MouseEvent): void {
  document.querySelectorAll('.git-popover-file-menu').forEach(m => m.remove());
  const path = row.dataset.path ?? '';
  const menu = toElement(
    <div className="git-popover-file-menu" style={`left:${e.clientX}px;top:${e.clientY}px`}>
      <button className="git-popover-file-menu-item" type="button" data-action="reveal">Reveal in Finder</button>
      <button className="git-popover-file-menu-item" type="button" data-action="copy">Copy Path</button>
    </div>
  );
  // HS-9205 — keep Finder-reveal reachable via right-click now that a plain click
  // opens the Glassbox diff (when Glassbox is installed).
  menu.querySelector<HTMLButtonElement>('[data-action="reveal"]')!.addEventListener('click', () => {
    void gitReveal({ path }).catch(() => { /* ignore */ });
    menu.remove();
  });
  menu.querySelector<HTMLButtonElement>('[data-action="copy"]')!.addEventListener('click', () => {
    void navigator.clipboard.writeText(path);
    menu.remove();
  });
  document.body.appendChild(menu);
  // Auto-dismiss on outside click.
  setTimeout(() => {
    const handler = (event: MouseEvent): void => {
      if (!menu.contains(event.target as Node)) {
        menu.remove();
        document.removeEventListener('click', handler, true);
      }
    };
    document.addEventListener('click', handler, true);
  }, 0);
}

function positionPopover(popover: HTMLElement, anchor: HTMLElement): void {
  const anchorRect = anchor.getBoundingClientRect();
  const top = anchorRect.bottom + 6;
  const left = Math.max(8, Math.min(window.innerWidth - 332, anchorRect.left));
  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;
}

/** Helper: re-position the popover when the anchor's position shifts (e.g.
 *  on window resize). Caller wires `window.addEventListener('resize', ...)`. */
export function repositionGitStatusPopover(): void {
  if (activePopover !== null && activeAnchor !== null) {
    positionPopover(activePopover, activeAnchor);
  }
}
