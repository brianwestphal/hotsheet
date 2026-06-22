// HS-8938 — git worktree management panel (docs/89-git-worktrees.md Phase B UI).
//
// A small overlay to list / create / remove the active project's git worktrees,
// driven by the typed worktree API (HS-8935). Opened from the sidebar git
// popover ("Manage worktrees…"). Created worktrees become followers of this
// project (the server writes the HS-8934 pointer), so their AI terminals share
// the one ticket DB.
import { createWorktree, listWorktrees, removeWorktree, type WorktreeInfo } from '../api/index.js';
import { getErrorMessage } from '../utils/errorMessage.js';
import { confirmDialog } from './confirm.js';
import { toElement } from './dom.js';
import { showToast } from './toast.js';

let activeOverlay: HTMLElement | null = null;

export function closeWorktreesPanel(): void {
  if (activeOverlay !== null) {
    activeOverlay.remove();
    activeOverlay = null;
    document.removeEventListener('keydown', onKeydown, true);
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.preventDefault(); closeWorktreesPanel(); }
}

/** Build one worktree row. `onRemove` is omitted for the main worktree (which
 *  can't be removed). Exported for unit tests. */
export function renderWorktreeRow(wt: WorktreeInfo, onRemove?: (wt: WorktreeInfo) => void): HTMLElement {
  const branchLabel = wt.branch ?? '(detached)';
  const row = toElement(
    <div className="worktree-row" data-path={wt.path}>
      <div className="worktree-row-main">
        <span className="worktree-branch">{branchLabel}</span>
        {wt.isMain ? <span className="worktree-badge">main</span> : null}
        {!wt.isMain && wt.authoritativeDataDir !== null ? <span className="worktree-badge worktree-badge-follower">follower</span> : null}
      </div>
      <div className="worktree-path" title={wt.path}>{wt.path}</div>
      {!wt.isMain && onRemove !== undefined
        ? <button type="button" className="btn btn-sm btn-danger worktree-remove-btn">Remove</button>
        : null}
    </div>
  );
  if (!wt.isMain && onRemove !== undefined) {
    row.querySelector('.worktree-remove-btn')?.addEventListener('click', () => onRemove(wt));
  }
  return row;
}

/** Fetch + render the worktree list into `bodyEl`. Exported for tests. */
export async function refreshWorktreeList(bodyEl: HTMLElement): Promise<void> {
  bodyEl.replaceChildren(toElement(<div className="worktrees-loading">Loading…</div>));
  let list: WorktreeInfo[];
  try {
    list = await listWorktrees();
  } catch (e) {
    bodyEl.replaceChildren(toElement(<div className="worktrees-error">Couldn't list worktrees: {getErrorMessage(e)}</div>));
    return;
  }
  if (list.length === 0) {
    bodyEl.replaceChildren(toElement(<div className="worktrees-empty">No worktrees.</div>));
    return;
  }
  const rows = list.map(wt => renderWorktreeRow(wt, wt.isMain ? undefined : (w) => void handleRemove(w, bodyEl)));
  bodyEl.replaceChildren(...rows);
}

async function handleRemove(wt: WorktreeInfo, bodyEl: HTMLElement): Promise<void> {
  const ok = await confirmDialog({
    title: 'Remove worktree',
    message: `Remove the worktree for "${wt.branch ?? wt.path}"?\n\nThis runs git worktree remove --force (the branch is kept).`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  try {
    await removeWorktree({ path: wt.path, force: true });
    showToast('Worktree removed');
    await refreshWorktreeList(bodyEl);
  } catch (e) {
    showToast(`Remove failed: ${getErrorMessage(e)}`);
  }
}

async function handleCreate(branch: string, newBranch: boolean, bodyEl: HTMLElement): Promise<void> {
  if (branch.trim() === '') return;
  try {
    await createWorktree({ branch: branch.trim(), newBranch });
    showToast('Worktree created');
    await refreshWorktreeList(bodyEl);
  } catch (e) {
    showToast(`Create failed: ${getErrorMessage(e)}`);
  }
}

/** Open the worktree management overlay (singleton). */
export function openWorktreesPanel(): void {
  closeWorktreesPanel();
  const overlay = toElement(
    <div className="worktrees-overlay">
      <div className="worktrees-dialog" role="dialog" aria-label="Git worktrees">
        <div className="worktrees-header">
          <span className="worktrees-title">Git Worktrees</span>
          <button type="button" className="worktrees-close" title="Close">{'×'}</button>
        </div>
        <div className="worktrees-body"></div>
        <form className="worktrees-create">
          <input type="text" className="worktrees-branch-input" placeholder="Branch name" spellCheck={false} />
          <label className="worktrees-newbranch"><input type="checkbox" className="worktrees-newbranch-cb" /> New branch</label>
          <button type="submit" className="btn btn-sm worktrees-create-btn">Create</button>
        </form>
      </div>
    </div>,
  );

  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeWorktreesPanel(); });
  overlay.querySelector('.worktrees-close')?.addEventListener('click', closeWorktreesPanel);
  document.addEventListener('keydown', onKeydown, true);

  const bodyEl = overlay.querySelector<HTMLElement>('.worktrees-body')!;
  const form = overlay.querySelector<HTMLFormElement>('.worktrees-create')!;
  const input = overlay.querySelector<HTMLInputElement>('.worktrees-branch-input')!;
  const newBranchCb = overlay.querySelector<HTMLInputElement>('.worktrees-newbranch-cb')!;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void handleCreate(input.value, newBranchCb.checked, bodyEl).then(() => { input.value = ''; });
  });

  document.body.appendChild(overlay);
  activeOverlay = overlay;
  void refreshWorktreeList(bodyEl);
}
