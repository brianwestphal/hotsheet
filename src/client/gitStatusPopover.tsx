import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { toElement } from './dom.js';

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
 *   - Click → reveal in file manager via `POST /api/git/reveal`
 *   - Right-click → context menu with "Copy path"
 *
 * See docs/48-git-status-tracker.md §48.4.2.
 */

interface GitStatusFiles {
  staged: string[];
  unstaged: string[];
  untracked: string[];
  conflicted: string[];
  truncated: { staged: boolean; unstaged: boolean; untracked: boolean; conflicted: boolean };
}

interface GitStatusJson {
  branch: string;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  lastFetchedAt: number | null;
  files?: GitStatusFiles;
}

const CLOSE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

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
        <button className="git-popover-close" type="button" title="Close">{raw(CLOSE_ICON)}</button>
      </div>
      <div className="git-popover-body"></div>
    </div>
  );
  popover.querySelector('.git-popover-close')!.addEventListener('click', closePopover);
  document.body.appendChild(popover);
  activePopover = popover;
  positionPopover(popover, anchor);

  // Fetch with files=true so we can populate the bucket file lists when
  // the user expands them. Single round-trip.
  let data: GitStatusJson | null = null;
  try {
    data = await api<GitStatusJson | null>('/git/status?files=true');
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
export function buildBranchLine(status: GitStatusJson): string {
  if (status.detached) return `(detached: ${status.branch})`;
  if (status.upstream === null) return `${status.branch} (no upstream)`;
  return `${status.branch} → ${status.upstream}`;
}

/** Pure: build the ahead/behind line, or null when no upstream OR both are
 *  zero (in which case the popover hides the line entirely). Exported for
 *  tests. */
export function buildAheadBehindLine(status: GitStatusJson): string | null {
  if (status.upstream === null) return null;
  if (status.ahead === 0 && status.behind === 0) return 'up to date';
  const parts: string[] = [];
  if (status.ahead > 0) parts.push(`${status.ahead} ahead`);
  if (status.behind > 0) parts.push(`${status.behind} behind`);
  return parts.join(' • ');
}

function paintPopover(popover: HTMLElement, data: GitStatusJson): void {
  const titleEl = popover.querySelector<HTMLElement>('.git-popover-title');
  const bodyEl = popover.querySelector<HTMLElement>('.git-popover-body');
  if (titleEl === null || bodyEl === null) return;
  titleEl.textContent = buildBranchLine(data);

  const ab = buildAheadBehindLine(data);

  // HS-7974 — fetch row removed (last-fetched-at line + "Fetch now" button).
  // The user explicitly asked for it gone; the chip stays read-only.
  bodyEl.replaceChildren();
  if (ab !== null) bodyEl.appendChild(toElement(<div className="git-popover-ab">{ab}</div>));
  const bucketsEl = toElement(<div className="git-popover-buckets"></div>);
  for (const row of [
    bucketRow('staged', 'Staged', data.staged, data.files),
    bucketRow('unstaged', 'Unstaged', data.unstaged, data.files),
    bucketRow('untracked', 'Untracked', data.untracked, data.files),
    bucketRow('conflicted', 'Conflicted', data.conflicted, data.files),
  ]) {
    if (row !== null) bucketsEl.appendChild(row);
  }
  bodyEl.appendChild(bucketsEl);

  // Wire bucket-row expand/collapse toggles.
  bodyEl.querySelectorAll<HTMLElement>('.git-popover-bucket-header').forEach(header => {
    header.addEventListener('click', () => {
      const bucket = header.closest<HTMLElement>('.git-popover-bucket');
      if (bucket === null) return;
      bucket.classList.toggle('is-expanded');
    });
  });

  // Wire file-row clicks (reveal in finder).
  bodyEl.querySelectorAll<HTMLElement>('.git-popover-file').forEach(row => {
    row.addEventListener('click', () => {
      const path = row.dataset.path;
      if (path === undefined) return;
      void api('/git/reveal', { method: 'POST', body: { path } }).catch(() => { /* ignore */ });
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showFileContextMenu(row, e);
    });
  });

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
      <button className="git-popover-file-menu-item" type="button" data-action="copy">Copy path</button>
    </div>
  );
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
