import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { confirmDialog } from './confirm.js';
import { toElement } from './dom.js';
import type { TerminalTabConfig } from './terminal.js';

/**
 * Settings UI for the per-project list of default terminals
 * (docs/22-terminal.md §22.10). Each row is editable (name, command, cwd,
 * lazy flag) and reorderable via drag. The list is persisted to
 * `.hotsheet/settings.json` under the `terminals` key.
 *
 * Click handlers are attached per row rather than via delegation — mirrors
 * the commandEditor.tsx pattern which has shipped without issue. The row is
 * draggable, so each button stops both `click` and `mousedown` propagation
 * to keep the native drag gesture from swallowing the click in WebKit.
 */

interface EditableTerminalConfig extends TerminalTabConfig {
  id: string;
}

let terminals: EditableTerminalConfig[] = [];
let saveTimeout: ReturnType<typeof setTimeout> | null = null;
let dragFromIndex: number | null = null;

const TRASH_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';
const PENCIL_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';

/** Load terminals from file-settings and render. Exported so the dialog can call on open. */
export async function loadAndRenderTerminalsSettings(): Promise<void> {
  try {
    const fs = await api<{ terminals?: string | unknown[] }>('/file-settings');
    terminals = parseTerminals(fs.terminals);
  } catch {
    terminals = [];
  }
  renderList();
}

function parseTerminals(raw: string | unknown[] | undefined): EditableTerminalConfig[] {
  if (raw === undefined || raw === '') return [];
  let parsed: unknown[];
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw) as unknown[]; } catch { return []; }
  } else {
    parsed = raw;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return [];
  return parsed
    .map((item, index) => normalizeEntry(item, index))
    .filter((c): c is EditableTerminalConfig => c !== null);
}

function normalizeEntry(item: unknown, index: number): EditableTerminalConfig | null {
  if (typeof item !== 'object' || item === null) return null;
  const raw = item as Partial<EditableTerminalConfig>;
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : `default-${index}`;
  const command = typeof raw.command === 'string' && raw.command !== '' ? raw.command : '{{claudeCommand}}';
  const out: EditableTerminalConfig = { id, command };
  if (typeof raw.name === 'string') out.name = raw.name;
  if (typeof raw.cwd === 'string' && raw.cwd !== '') out.cwd = raw.cwd;
  if (typeof raw.lazy === 'boolean') out.lazy = raw.lazy;
  return out;
}

async function handleDelete(index: number): Promise<void> {
  const entry = terminals[index];
  const displayName = entry.name !== undefined && entry.name !== '' ? entry.name : '(unnamed)';

  // Reveal the target terminal in the drawer and get the settings dialog out
  // of the way so the user can see what they're about to remove.
  const settingsOverlay = document.getElementById('settings-overlay');
  const prevOverlayDisplay = settingsOverlay?.style.display ?? '';
  if (settingsOverlay) settingsOverlay.style.display = 'none';
  let restoreDrawer: (() => void) | null = null;
  try {
    const mod = await import('./commandLog.js');
    restoreDrawer = mod.previewDrawerTab(`terminal:${entry.id}`);
  } catch { /* drawer preview is best-effort */ }

  const confirmed = await confirmDialog({
    title: 'Remove terminal?',
    message: `Remove terminal "${displayName}"? Its running process (if any) will be stopped.`,
    confirmLabel: 'Remove',
    danger: true,
  });

  if (settingsOverlay) settingsOverlay.style.display = prevOverlayDisplay;
  restoreDrawer?.();

  if (!confirmed) return;

  // Stop the PTY cleanly so it doesn't linger as an orphan.
  try {
    await api('/terminal/destroy', { method: 'POST', body: { terminalId: entry.id } });
  } catch { /* if the PTY was never spawned, destroy is a no-op server-side */ }

  terminals.splice(index, 1);
  renderList();
  void scheduleSave();
}

function renderList(): void {
  const list = document.getElementById('settings-terminals-list');
  if (!list) return;
  list.innerHTML = '';
  if (terminals.length === 0) {
    list.appendChild(toElement(<div className="settings-terminals-empty">No terminals configured.</div>));
    return;
  }
  for (let i = 0; i < terminals.length; i++) {
    list.appendChild(renderRow(i));
  }
}

function renderRow(index: number): HTMLElement {
  const entry = terminals[index];
  const displayName = entry.name !== undefined && entry.name !== '' ? entry.name : '(unnamed)';
  const row = toElement(
    <div className="cmd-outline-row settings-terminal-row" draggable="true" data-index={String(index)}>
      <span className="command-drag-handle" title="Drag to reorder">{'☰'}</span>
      <span className="cmd-outline-name">{displayName}</span>
      <span className="settings-terminal-command">{entry.command}</span>
      <button type="button" className="cmd-outline-edit-btn" title="Edit">{raw(PENCIL_ICON)}</button>
      <button type="button" className="cmd-outline-delete-btn" title="Delete">{raw(TRASH_ICON)}</button>
    </div>
  );

  const editBtn = row.querySelector('.cmd-outline-edit-btn') as HTMLButtonElement;
  const deleteBtn = row.querySelector('.cmd-outline-delete-btn') as HTMLButtonElement;

  // Block drag initiation from the buttons — in WebKit (and thus Tauri WKWebView),
  // a mousedown on a button inside a draggable="true" row can trigger a drag, and
  // the browser then cancels the click. Stopping mousedown propagation keeps the
  // drag gesture constrained to the row background / drag handle.
  const swallow = (e: Event) => { e.stopPropagation(); };
  editBtn.addEventListener('mousedown', swallow);
  deleteBtn.addEventListener('mousedown', swallow);
  editBtn.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation(); });
  deleteBtn.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation(); });

  editBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openEditor(index);
  });
  deleteBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void handleDelete(index);
  });

  // Drag-to-reorder lives on the row itself.
  row.addEventListener('dragstart', (e) => {
    dragFromIndex = index;
    e.dataTransfer?.setData('text/plain', String(index));
    if (e.dataTransfer !== null) e.dataTransfer.effectAllowed = 'move';
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => {
    dragFromIndex = null;
    row.classList.remove('dragging');
  });
  row.addEventListener('dragover', (e) => { e.preventDefault(); });
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    if (dragFromIndex === null || dragFromIndex === index) {
      dragFromIndex = null;
      return;
    }
    const [moved] = terminals.splice(dragFromIndex, 1);
    terminals.splice(index, 0, moved);
    dragFromIndex = null;
    renderList();
    void scheduleSave();
  });

  return row;
}

function openEditor(index: number): void {
  document.querySelectorAll('.cmd-editor-overlay').forEach(el => el.remove());
  const entry = terminals[index];

  const overlay = toElement(
    <div className="cmd-editor-overlay">
      <div className="cmd-editor-dialog">
        <div className="cmd-editor-dialog-header">
          <span>Edit Terminal</span>
          <button className="cmd-editor-close-btn" title="Close">{'×'}</button>
        </div>
        <div className="cmd-editor-dialog-body">
          <div className="settings-field">
            <label>Name (tab label)</label>
            <input type="text" className="term-edit-name" value={entry.name ?? ''} placeholder="Terminal" />
          </div>
          <div className="settings-field">
            <label>Command</label>
            <input type="text" className="term-edit-command" value={entry.command} placeholder="{{claudeCommand}}" />
            <span className="settings-hint">{'Use {{claudeCommand}} to resolve to claude. Any shell-valid command works.'}</span>
          </div>
          <div className="settings-field">
            <label>Working directory</label>
            <input type="text" className="term-edit-cwd" value={entry.cwd ?? ''} placeholder="(project root)" />
            <span className="settings-hint">Leave blank to use the project root.</span>
          </div>
          <div className="settings-field settings-field-checkbox">
            <label>
              <input type="checkbox" className="term-edit-lazy" checked={entry.lazy !== false} />
              Lazy launch (spawn only on first tab activation)
            </label>
            <span className="settings-hint">Uncheck to spawn the PTY as soon as the project has loaded.</span>
          </div>
        </div>
        <div className="cmd-editor-dialog-footer">
          <button className="btn btn-sm cmd-editor-done-btn">Done</button>
        </div>
      </div>
    </div>
  );

  const close = async () => {
    const name = (overlay.querySelector('.term-edit-name') as HTMLInputElement).value;
    const command = (overlay.querySelector('.term-edit-command') as HTMLInputElement).value;
    const cwd = (overlay.querySelector('.term-edit-cwd') as HTMLInputElement).value.trim();
    const lazy = (overlay.querySelector('.term-edit-lazy') as HTMLInputElement).checked;
    const updated: EditableTerminalConfig = { ...entry, command: command !== '' ? command : '{{claudeCommand}}', lazy };
    if (name !== '') updated.name = name; else delete updated.name;
    if (cwd !== '') updated.cwd = cwd; else delete updated.cwd;
    terminals[index] = updated;
    overlay.remove();
    renderList();
    await scheduleSave();
  };
  overlay.querySelector('.cmd-editor-close-btn')?.addEventListener('click', () => { void close(); });
  overlay.querySelector('.cmd-editor-done-btn')?.addEventListener('click', () => { void close(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) void close(); });
  document.body.appendChild(overlay);
  (overlay.querySelector('.term-edit-name') as HTMLInputElement).focus();
}

/** Debounced save of the full terminals array. */
function scheduleSave(): Promise<void> {
  if (saveTimeout) clearTimeout(saveTimeout);
  return new Promise((resolve) => {
    saveTimeout = setTimeout(async () => {
      saveTimeout = null;
      await api('/file-settings', { method: 'PATCH', body: { terminals } });
      try {
        const mod = await import('./terminal.js');
        await mod.refreshTerminalsAfterSettingsChange();
      } catch { /* ignore */ }
      resolve();
    }, 400);
  });
}

/** Add a blank new terminal to the end and open the editor on it. */
export function addTerminalEntry(): void {
  const id = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  terminals.push({ id, name: 'Terminal', command: '{{claudeCommand}}' });
  renderList();
  openEditor(terminals.length - 1);
}
