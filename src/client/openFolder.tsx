import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { toElement } from './dom.js';
import { refreshProjectTabs, switchProject } from './projectTabs.js';
import type { ProjectInfo } from './state.js';
import { getTauriInvoke } from './tauriIntegration.js';

interface BrowseResult {
  path: string;
  parent: string | null;
  entries: { name: string; path: string; hasHotsheet: boolean }[];
  hasHotsheet: boolean;
}

let currentPath = '';

function renderBreadcrumb(path: string) {
  const container = document.getElementById('open-folder-breadcrumb')!;
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
    const result = await api<BrowseResult>(`/browse?path=${encodeURIComponent(path)}`);
    currentPath = result.path;
    renderBreadcrumb(result.path);
    renderEntries(result);
    updateFooter(result);
  } catch { /* stay where we are */ }
}

function renderEntries(result: BrowseResult) {
  const list = document.getElementById('open-folder-list')!;
  list.innerHTML = '';

  if (result.entries.length === 0) {
    list.appendChild(toElement(<div className="open-folder-empty">No subfolders</div>));
    return;
  }

  for (const entry of result.entries) {
    const FOLDER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
    const row = toElement(
      <div className={`open-folder-entry${entry.hasHotsheet ? ' has-hotsheet' : ''}`}>
        <span className="open-folder-entry-icon">{raw(FOLDER_SVG)}</span>
        <span className="open-folder-entry-name">{entry.name}</span>
        {entry.hasHotsheet ? <span className="open-folder-entry-badge">Hot Sheet</span> : ''}
      </div>
    );
    row.addEventListener('dblclick', () => void navigateTo(entry.path));
    row.addEventListener('click', () => {
      list.querySelectorAll('.open-folder-entry').forEach(e => e.classList.remove('selected'));
      row.classList.add('selected');
      const selectBtn = document.getElementById('open-folder-select-btn') as HTMLButtonElement;
      selectBtn.dataset.selectedPath = entry.path;
      document.getElementById('open-folder-path')!.textContent = entry.path;
    });
    list.appendChild(row);
  }
}

function updateFooter(result: BrowseResult) {
  document.getElementById('open-folder-path')!.textContent = result.path;
  (document.getElementById('open-folder-select-btn') as HTMLButtonElement).dataset.selectedPath = result.path;
}

async function openSelectedFolder(path: string) {
  const hotsheetPath = path.endsWith('.hotsheet') ? path : path + '/.hotsheet';
  try {
    const res = await fetch('/api/projects/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataDir: hotsheetPath }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      alert(body.error ?? 'Failed to open folder');
      return;
    }
    const project = await res.json() as ProjectInfo;
    document.getElementById('open-folder-overlay')!.style.display = 'none';
    await refreshProjectTabs();
    await switchProject(project);
  } catch (err) {
    console.error('Failed to open folder:', err);
  }
}

/** Open a folder using native Tauri dialog, or fall back to the browser directory browser. */
export function showOpenFolderDialog() {
  const invoke = getTauriInvoke();
  if (invoke) {
    void (async () => {
      try {
        const selected = (await invoke('pick_folder')) as string | null;
        if (selected) {
          await openSelectedFolder(selected);
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
  const overlay = document.getElementById('open-folder-overlay')!;
  overlay.style.display = 'flex';
  void navigateTo('');
}

export function bindOpenFolder() {
  // Dialog close
  document.getElementById('open-folder-close')?.addEventListener('click', () => {
    document.getElementById('open-folder-overlay')!.style.display = 'none';
  });
  document.getElementById('open-folder-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) (e.currentTarget as HTMLElement).style.display = 'none';
  });

  // Select button
  document.getElementById('open-folder-select-btn')?.addEventListener('click', () => {
    const path = (document.getElementById('open-folder-select-btn') as HTMLButtonElement).dataset.selectedPath;
    if (path) void openSelectedFolder(path);
  });

  // Listen for Tauri menu event
  window.addEventListener('app:open-folder', () => showOpenFolderDialog());

  // Right-click context menu on toolbar and tab area
  const FOLDER_OPEN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>';
  document.querySelector('.app-header')?.addEventListener('contextmenu', (e) => {
    // Don't show toolbar context menu if the target is inside a tab (tab has its own menu)
    if ((e.target as HTMLElement).closest('.project-tab')) return;
    e.preventDefault();
    document.getElementById('toolbar-context-menu')?.remove();

    const menu = toElement(
      <div className="tab-context-menu" id="toolbar-context-menu">
        <div className="tab-context-item">{raw(FOLDER_OPEN_SVG)} Open Folder</div>
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
