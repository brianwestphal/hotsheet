import { browse, type BrowseResult, type RegisteredProject,registerProject } from '../api/index.js';
import { showErrorPopup } from './api.js';
import { byId, byIdOrNull, toElement } from './dom.js';
import { ICON_FOLDER, ICON_FOLDER_OPEN } from './icons.js';
import { refreshProjectTabs, switchProject } from './projectTabs.js';
import { getTauriInvoke } from './tauriIntegration.js';

/** HS-8663 — optional callback run after a folder is successfully registered
 *  as a project, BEFORE the dialog switches to it. The drop-onto-"+"-button
 *  flow uses this to copy/move the dragged tickets into the new project. Held
 *  at module scope because the browser-overlay path resolves on a later
 *  Select-button click, not inline. Cleared on every dialog open, on cancel,
 *  and after it runs (so a plain "+" click or menu open never re-fires it). */
let pendingOnRegistered: ((project: RegisteredProject) => void | Promise<void>) | null = null;

function renderBreadcrumb(path: string) {
  const container = byId('open-folder-breadcrumb');
  const parts = path.split('/').filter(Boolean);
  container.innerHTML = '';

  const rootBtn = toElement(<button className="breadcrumb-part">/</button>);
  rootBtn.addEventListener('click', () => void navigateTo('/'));
  container.appendChild(rootBtn);

  let accumulated = '';
  for (const part of parts) {
    accumulated += '/' + part;
    const sep = toElement(<span className="breadcrumb-sep">/</span>);
    container.appendChild(sep);
    const pathForClick = accumulated;
    const btn = toElement(<button className="breadcrumb-part">{part}</button>);
    btn.addEventListener('click', () => void navigateTo(pathForClick));
    container.appendChild(btn);
  }
}

async function navigateTo(path: string) {
  try {
    const result = await browse(path);
    renderBreadcrumb(result.path);
    renderEntries(result);
    updateFooter(result);
  } catch { /* stay where we are */ }
}

function renderEntries(result: BrowseResult) {
  const list = byId('open-folder-list');
  list.innerHTML = '';

  if (result.entries.length === 0) {
    list.appendChild(toElement(<div className="open-folder-empty">No subfolders</div>));
    return;
  }

  for (const entry of result.entries) {
    const row = toElement(
      <div className={`open-folder-entry${entry.hasHotsheet ? ' has-hotsheet' : ''}`}>
        <span className="open-folder-entry-icon">{ICON_FOLDER}</span>
        <span className="open-folder-entry-name">{entry.name}</span>
        {entry.hasHotsheet ? <span className="open-folder-entry-badge">Hot Sheet</span> : ''}
      </div>
    );
    row.addEventListener('dblclick', () => void navigateTo(entry.path));
    row.addEventListener('click', () => {
      list.querySelectorAll('.open-folder-entry').forEach(e => e.classList.remove('selected'));
      row.classList.add('selected');
      const selectBtn = byId<HTMLButtonElement>('open-folder-select-btn');
      selectBtn.dataset.selectedPath = entry.path;
      byId('open-folder-path').textContent = entry.path;
    });
    list.appendChild(row);
  }
}

function updateFooter(result: BrowseResult) {
  byId('open-folder-path').textContent = result.path;
  byId<HTMLButtonElement>('open-folder-select-btn').dataset.selectedPath = result.path;
}

async function openSelectedFolder(path: string) {
  const hotsheetPath = path.endsWith('.hotsheet') ? path : path + '/.hotsheet';
  try {
    // HS-8085 — `api()` already throws on non-2xx with a parsed
    // `error` field surfaced through the network-error popup, so the
    // pre-fix manual `if (!res.ok) showErrorPopup(...)` branch
    // collapses into the catch. Behaviour preserved.
    const project = await registerProject(hotsheetPath);
    byId('open-folder-overlay').style.display = 'none';
    await refreshProjectTabs();
    // HS-8663 — run the post-register callback (e.g. transfer dropped tickets
    // into the new project) BEFORE switching, so a "move" deletes from the
    // still-active source project. One-shot: cleared whether it throws or not.
    const cb = pendingOnRegistered;
    pendingOnRegistered = null;
    if (cb !== null) await cb(project);
    await switchProject(project);
  } catch (err) {
    if (err instanceof Error && err.message !== '') {
      showErrorPopup(err.message);
    }
    console.error('Failed to open folder:', err);
  }
}

/**
 * Open a folder using the native Tauri dialog, or fall back to the in-app
 * browser directory browser. `opts.onRegistered` (HS-8663) runs once after a
 * folder is registered as a project and before the dialog switches to it.
 */
export function showOpenFolderDialog(opts: { onRegistered?: (project: RegisteredProject) => void | Promise<void> } = {}) {
  pendingOnRegistered = opts.onRegistered ?? null;
  const invoke = getTauriInvoke();
  if (invoke) {
    void (async () => {
      try {
        const selected = (await invoke('pick_folder')) as string | null;
        if (selected !== null && selected !== '') {
          await openSelectedFolder(selected);
        } else {
          // User canceled the native picker — drop the one-shot callback.
          pendingOnRegistered = null;
        }
      } catch {
        // Fallback to browser dialog
        showBrowserDialog();
      }
    })();
    return;
  }
  showBrowserDialog();
}

function showBrowserDialog() {
  const overlay = byId('open-folder-overlay');
  overlay.style.display = 'flex';
  void navigateTo('');
}

export function bindOpenFolder() {
  // Dialog close — canceling drops any pending HS-8663 transfer callback so a
  // later plain Open Folder can't inherit it.
  byIdOrNull('open-folder-close')?.addEventListener('click', () => {
    pendingOnRegistered = null;
    byId('open-folder-overlay').style.display = 'none';
  });
  byIdOrNull('open-folder-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      pendingOnRegistered = null;
      (e.currentTarget as HTMLElement).style.display = 'none';
    }
  });

  // Select button
  byIdOrNull('open-folder-select-btn')?.addEventListener('click', () => {
    const path = byId<HTMLButtonElement>('open-folder-select-btn').dataset.selectedPath;
    if (path !== undefined && path !== '') void openSelectedFolder(path);
  });

  // Listen for Tauri menu event
  window.addEventListener('app:open-folder', () => showOpenFolderDialog());

  // Right-click context menu on toolbar and tab area
  document.querySelector('.app-header')?.addEventListener('contextmenu', (e) => {
    // Don't show toolbar context menu if the target is inside a tab (tab has its own menu)
    if ((e.target as HTMLElement).closest('.project-tab')) return;
    e.preventDefault();
    byIdOrNull('toolbar-context-menu')?.remove();

    const menu = toElement(
      <div className="tab-context-menu" id="toolbar-context-menu">
        <div className="tab-context-item">{ICON_FOLDER_OPEN} Open Folder</div>
      </div>
    );
      menu.querySelector('.tab-context-item')!.addEventListener('click', () => {
        menu.remove();
        showOpenFolderDialog();
      });
      menu.style.left = `${(e as MouseEvent).clientX}px`;
      menu.style.top = `${(e as MouseEvent).clientY}px`;
      document.body.appendChild(menu);

      const close = (ev: MouseEvent) => {
        if (!menu.contains(ev.target as Node)) {
          menu.remove();
          document.removeEventListener('click', close);
        }
      };
      setTimeout(() => document.addEventListener('click', close), 0);
    });
}
