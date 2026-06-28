import { destroyTerminal, getCommandSuggestions, updateFileSettings } from '../api/index.js';
import { confirmDialog } from './confirm.js';
import { byIdOrNull, toElement } from './dom.js';
import { delegate } from './reactive.js';
import { loadScopedList, saveScopedList, scopeListHintElement } from './settingsScopeList.js';
import { getActiveProject } from './state.js';
import type { TerminalTabConfig } from './terminal.js';
import { getProjectDefault } from './terminalAppearance.js';
import { clampFontSize, DEFAULT_FONT_SIZE, MAX_FONT_SIZE, MIN_FONT_SIZE, TERMINAL_FONTS } from './terminalFonts.js';
import { DEFAULT_THEME_ID, TERMINAL_THEMES } from './terminalThemes.js';
import { BLUR_DEBOUNCE_MS } from './uiTimings.js';

/**
 * Settings UI for the per-project list of default terminals
 * (docs/22-terminal.md §22.10). Each row is editable (name, command, cwd,
 * lazy flag) and reorderable via drag. The list is persisted to
 * `.hotsheet/settings.json` under the `terminals` key.
 *
 * HS-8614 — the index-capturing per-row handlers (edit / delete button
 * clicks + the row drag `dragstart`/`dragend`/`dragover`/`drop`) are now
 * delegated ONCE at the stable `#settings-terminals-list` container
 * (`ensureRowDelegationBound`), reading the row index from each row's
 * `data-index` attribute instead of closing over the render-time `index`.
 * Pre-fix every row re-attached ~7 closure-captured-index listeners on every
 * add / delete / reorder.
 *
 * The ONE per-row listener that survives is the stateless button `mousedown`
 * stop-propagation "swallow": the row is `draggable=true`, and in WebKit (and
 * thus Tauri's WKWebView) a `mousedown` on a button inside a draggable row can
 * start a drag and cancel the click. The swallow must run AT the button,
 * BEFORE the event reaches the draggable row, to keep the click alive — which
 * container-level delegation (bubble phase, fires after the row) can't
 * reproduce. It captures no index, so it carries no stale-closure risk and
 * doesn't block a future `morph()` migration.
 */

interface EditableTerminalConfig extends TerminalTabConfig {
  id: string;
}

/**
 * HS-7895 — placeholder for the Edit Terminal Command input. The pre-fix
 * placeholder was the literal sentinel `{{claudeCommand}}`, which (a) shows
 * an unresolved template tag in the empty state and (b) nudges users toward
 * Claude even when they wanted a different shell. The hint text below the
 * field still teaches the sentinel; the placeholder no longer doubles as a
 * tutorial.
 */
export const COMMAND_INPUT_PLACEHOLDER = 'Pick a command…';

let terminals: EditableTerminalConfig[] = [];
// HS-9015 — scope-aware editing: the committed shared array + the active mode.
let terminalsShared: EditableTerminalConfig[] = [];
let terminalsMode: 'shared' | 'local' | 'resolved' = 'resolved';
/** Stable identity for a terminal config (matches the file-settings idOf). */
const termIdOf = (t: EditableTerminalConfig): string => (typeof t.id === 'string' ? t.id : '');
let saveTimeout: ReturnType<typeof setTimeout> | null = null;
let dragFromIndex: number | null = null;

/** Test-only — read the current in-memory terminals array. Used by the
 *  HS-7958 unit test to assert that add-then-cancel doesn't leak a stub
 *  entry into the configured list. */
export function _getTerminalsForTests(): readonly EditableTerminalConfig[] {
  return terminals;
}

/** Test-only — reset the module-level state so each test starts clean. */
export function _resetTerminalsForTests(): void {
  terminals = [];
  if (saveTimeout !== null) clearTimeout(saveTimeout);
  saveTimeout = null;
  dragFromIndex = null;
  // HS-8614 — drop the delegated row listeners + binding marker so the next
  // render re-binds against the test's fresh `#settings-terminals-list`.
  for (const dispose of rowDelegateDisposers) dispose();
  rowDelegateDisposers = [];
  delegatedList = null;
}

/**
 * Module-level cache of the Edit Terminal command-combobox suggestions
 * (HS-7791). Populated lazily on first dialog open via
 * `GET /api/terminal/command-suggestions`. We never invalidate — the
 * suggestions only depend on the user's environment (default shell +
 * `/etc/shells`) which doesn't change while Hot Sheet is running.
 */
let commandSuggestionsCache: string[] | null = null;
let commandSuggestionsPromise: Promise<string[]> | null = null;

async function loadCommandSuggestions(): Promise<string[]> {
  if (commandSuggestionsCache !== null) return commandSuggestionsCache;
  if (commandSuggestionsPromise === null) {
    commandSuggestionsPromise = (async () => {
      try {
        const list = await getCommandSuggestions();
        commandSuggestionsCache = list;
        return list;
      } catch {
        // Network error — surface the sentinel alone so the dropdown still has
        // at least one entry. Don't cache the failure; allow a retry on the
        // next open.
        commandSuggestionsPromise = null;
        return ['{{claudeCommand}}'];
      }
    })();
  }
  return commandSuggestionsPromise;
}

const TRASH_ICON = <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>;
const PENCIL_ICON = <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>;

/** Load terminals from file-settings and render. Exported so the dialog can call on open. */
let scopeListenerBound = false;
/** HS-9015 — reload the terminals list for the new layer when the scope mode
 *  changes. Bound once (idempotent). */
function ensureScopeListener(): void {
  if (scopeListenerBound) return;
  scopeListenerBound = true;
  document.addEventListener('hotsheet:scope-mode-changed', () => { void loadAndRenderTerminalsSettings(); });
}

export async function loadAndRenderTerminalsSettings(): Promise<void> {
  ensureScopeListener();
  try {
    // HS-9015 — read the layer for the active scope mode (Shared shows the
    // committed array; Local/Resolved show the effective list).
    const data = await loadScopedList<unknown>('terminals');
    terminalsMode = data.mode;
    terminalsShared = data.shared.map((item, i) => normalizeEntry(item, i)).filter((t): t is EditableTerminalConfig => t !== null);
    terminals = data.items.map((item, i) => normalizeEntry(item, i)).filter((t): t is EditableTerminalConfig => t !== null);
  } catch {
    terminals = [];
    terminalsShared = [];
  }
  renderList();
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

/**
 * HS-9128 — classify a terminal against the committed shared array for the
 * Local-mode origin tag: `local` (not in shared), `shared` (in shared,
 * unchanged), or `overridden` (in shared but edited locally).
 */
function termOrigin(entry: EditableTerminalConfig): 'local' | 'shared' | 'overridden' {
  const sharedMatch = terminalsShared.find(s => termIdOf(s) === termIdOf(entry));
  if (sharedMatch === undefined) return 'local';
  return JSON.stringify(sharedMatch) === JSON.stringify(entry) ? 'shared' : 'overridden';
}

/** HS-9128 — drop a local override, restoring the shared terminal config. */
function resetTerminalToShared(index: number): void {
  const entry = terminals[index];
  const sharedMatch = terminalsShared.find(s => termIdOf(s) === termIdOf(entry));
  if (sharedMatch === undefined) return;
  terminals[index] = { ...sharedMatch };
  renderList();
  void scheduleSave();
  document.dispatchEvent(new CustomEvent('hotsheet:terminal-config-changed', { detail: { terminalId: entry.id } }));
}

/** HS-9125 — re-enable a shared terminal hidden by the local layer. */
function reenableTerminal(id: string): void {
  if (terminals.some(t => termIdOf(t) === id)) return;
  const sharedMatch = terminalsShared.find(s => termIdOf(s) === id);
  if (sharedMatch === undefined) return;
  terminals.push({ ...sharedMatch });
  renderList();
  void scheduleSave();
}

async function handleDelete(index: number): Promise<void> {
  const entry = terminals[index];
  const displayName = entry.name !== undefined && entry.name !== '' ? entry.name : '(unnamed)';
  // HS-9125 — in Local mode a shared terminal can't be truly deleted (it lives in
  // the committed array); deleting it here HIDES it on this machine (a local
  // `hidden` delta), restorable via Re-enable.
  const hidingShared = terminalsMode === 'local' && termOrigin(entry) !== 'local';

  // Reveal the target terminal in the drawer and get the settings dialog out
  // of the way so the user can see what they're about to remove.
  const settingsOverlay = byIdOrNull('settings-overlay');
  const prevOverlayDisplay = settingsOverlay?.style.display ?? '';
  if (settingsOverlay) settingsOverlay.style.display = 'none';
  let restoreDrawer: (() => void) | null = null;
  try {
    const mod = await import('./commandLog.js');
    restoreDrawer = mod.previewDrawerTab(`terminal:${entry.id}`);
  } catch { /* drawer preview is best-effort */ }

  const confirmed = await confirmDialog({
    title: hidingShared ? 'Hide Terminal?' : 'Remove Terminal?',
    message: hidingShared
      ? `Hide terminal "${displayName}" on this machine? It won't appear here — you can re-enable it later. Its running process (if any) will be stopped.`
      : `Remove terminal "${displayName}"? Its running process (if any) will be stopped.`,
    confirmLabel: hidingShared ? 'Hide' : 'Remove',
    danger: true,
  });

  if (settingsOverlay) settingsOverlay.style.display = prevOverlayDisplay;
  restoreDrawer?.();

  if (!confirmed) return;

  // Stop the PTY cleanly so it doesn't linger as an orphan.
  try {
    await destroyTerminal(entry.id);
  } catch { /* if the PTY was never spawned, destroy is a no-op server-side */ }

  terminals.splice(index, 1);
  renderList();
  void scheduleSave();
}

function renderList(): void {
  const list = byIdOrNull('settings-terminals-list');
  if (!list) return;
  ensureRowDelegationBound(list);
  // HS-8365 — `replaceChildren(...rows)` instead of the prior
  // `innerHTML = '' + append-each` pattern. HS-8614 — the per-row
  // index-capturing listeners moved to one delegated set on the container
  // (see `ensureRowDelegationBound`), so rows are now near-pure markup
  // (only the stateless WebKit mousedown swallow stays per-button).
  // HS-9015 — per-mode scope hint (null in Resolved).
  const hint = scopeListHintElement(terminalsMode);
  const lead: HTMLElement[] = hint !== null ? [hint] : [];
  // HS-9127 — Resolved is the read-only effective view: no add/edit/delete/drag.
  const readonly = terminalsMode === 'resolved';
  const addBtn = byIdOrNull('settings-terminals-add-btn');
  if (addBtn !== null) addBtn.style.display = readonly ? 'none' : '';
  // HS-9125 — in Local mode, shared terminals the local layer hides still get a
  // disabled row with a Re-enable button so they can be restored.
  const hiddenShared = terminalsMode === 'local'
    ? terminalsShared.filter(s => !terminals.some(t => termIdOf(t) === termIdOf(s)))
    : [];
  if (terminals.length === 0 && hiddenShared.length === 0) {
    list.replaceChildren(...lead, toElement(<div className="settings-terminals-empty">No terminals configured.</div>));
    return;
  }
  const rows = terminals.map((_, i) => renderRow(i));
  const hiddenRows = hiddenShared.map(s => renderHiddenRow(s));
  list.replaceChildren(...lead, ...rows, ...hiddenRows);
}

/** HS-9125 — a dimmed row for a shared terminal hidden by the local layer. */
function renderHiddenRow(entry: EditableTerminalConfig): HTMLElement {
  const displayName = entry.name !== undefined && entry.name !== '' ? entry.name : '(unnamed)';
  return toElement(
    <div className="cmd-outline-row settings-terminal-row settings-terminal-row-hidden" data-term-id={termIdOf(entry)}>
      <span className="cmd-outline-name">{displayName}</span>
      <span className="settings-terminal-command">{entry.command}</span>
      <span className="scope-tag scope-tag-local"><span className="scope-tag-dot" />Locally hidden</span>
      <button type="button" className="scope-link term-reenable-btn">Re-enable</button>
    </div>
  );
}

/** Read the row index a delegated handler should act on from the row's
 *  `data-index`. `renderRow` stamps it on every render, so it always reflects
 *  the current position (renderList re-runs after every add / delete /
 *  reorder). Returns -1 when the element isn't inside a row. */
function rowIndexOf(el: Element): number {
  const raw = el.closest('.settings-terminal-row')?.getAttribute('data-index');
  return raw === null || raw === undefined ? -1 : Number(raw);
}

/** Track the element the delegated handlers are bound to + their disposers.
 *  In production the list is page-lifetime (server-rendered, always present),
 *  so this binds exactly once. In unit tests the DOM is rebuilt per test; when
 *  the element identity changes we dispose the prior listeners and re-bind, so
 *  reusing the same element across tests never stacks duplicate handlers. */
let delegatedList: HTMLElement | null = null;
let rowDelegateDisposers: (() => void)[] = [];

function ensureRowDelegationBound(list: HTMLElement): void {
  if (delegatedList === list) return;
  for (const dispose of rowDelegateDisposers) dispose();
  rowDelegateDisposers = [];
  delegatedList = list;

  // Edit / delete button clicks. `preventDefault` + `stopPropagation` mirror
  // the pre-fix per-button handlers (keep the click from bubbling to the row).
  rowDelegateDisposers.push(delegate<HTMLElement>(list, 'click', '.cmd-outline-edit-btn', (e, btn) => {
    e.preventDefault();
    e.stopPropagation();
    const i = rowIndexOf(btn);
    if (i >= 0) openEditor(terminals[i], { mode: 'edit' });
  }));
  rowDelegateDisposers.push(delegate<HTMLElement>(list, 'click', '.cmd-outline-delete-btn', (e, btn) => {
    e.preventDefault();
    e.stopPropagation();
    const i = rowIndexOf(btn);
    if (i >= 0) void handleDelete(i);
  }));
  // HS-9128 — Reset a locally overridden shared terminal back to the shared value.
  rowDelegateDisposers.push(delegate<HTMLElement>(list, 'click', '.term-reset-btn', (e, btn) => {
    e.preventDefault();
    e.stopPropagation();
    const i = rowIndexOf(btn);
    if (i >= 0) resetTerminalToShared(i);
  }));
  // HS-9125 — Re-enable a locally-hidden shared terminal (the hidden row carries
  // its id in `data-term-id`, not a `terminals[]` index).
  rowDelegateDisposers.push(delegate<HTMLElement>(list, 'click', '.term-reenable-btn', (e, btn) => {
    e.preventDefault();
    e.stopPropagation();
    const id = btn.closest('.settings-terminal-row-hidden')?.getAttribute('data-term-id');
    if (id !== null && id !== undefined && id !== '') reenableTerminal(id);
  }));

  // Drag-to-reorder. The drag events bubble (or are capture-promoted by
  // `delegate`), so one listener per type at the container handles every row.
  rowDelegateDisposers.push(delegate<HTMLElement>(list, 'dragstart', '.settings-terminal-row', (e, row) => {
    const i = rowIndexOf(row);
    if (i < 0) return;
    dragFromIndex = i;
    const dt = (e as DragEvent).dataTransfer;
    dt?.setData('text/plain', String(i));
    if (dt !== null) dt.effectAllowed = 'move';
    row.classList.add('dragging');
  }));
  rowDelegateDisposers.push(delegate<HTMLElement>(list, 'dragend', '.settings-terminal-row', (_e, row) => {
    dragFromIndex = null;
    row.classList.remove('dragging');
  }));
  rowDelegateDisposers.push(delegate<HTMLElement>(list, 'dragover', '.settings-terminal-row', (e) => { e.preventDefault(); }));
  rowDelegateDisposers.push(delegate<HTMLElement>(list, 'drop', '.settings-terminal-row', (e, row) => {
    e.preventDefault();
    const index = rowIndexOf(row);
    if (dragFromIndex === null || index < 0 || dragFromIndex === index) {
      dragFromIndex = null;
      return;
    }
    const [moved] = terminals.splice(dragFromIndex, 1);
    terminals.splice(index, 0, moved);
    dragFromIndex = null;
    renderList();
    void scheduleSave();
  }));
}

function renderRow(index: number): HTMLElement {
  const entry = terminals[index];
  const displayName = entry.name !== undefined && entry.name !== '' ? entry.name : '(unnamed)';
  // HS-9128 — origin tag in non-Resolved modes; Reset-to-shared for a locally
  // overridden shared terminal. HS-9125 — in Local mode the delete of a shared
  // terminal hides it locally (relabel the button accordingly).
  const origin = termOrigin(entry);
  const showTag = terminalsMode !== 'resolved';
  const isSharedHere = terminalsMode === 'local' && origin !== 'local';
  // HS-9127 — Resolved is the read-only effective view: no drag/edit/delete/reset.
  const readonly = terminalsMode === 'resolved';
  const row = toElement(
    <div className="cmd-outline-row settings-terminal-row" draggable={readonly ? 'false' : 'true'} data-index={String(index)}>
      {readonly ? '' : <span className="command-drag-handle" title="Drag to reorder">{'☰'}</span>}
      <span className="cmd-outline-name">{displayName}</span>
      <span className="settings-terminal-command">{entry.command}</span>
      {showTag ? <span className={`scope-tag ${origin === 'shared' ? 'scope-tag-shared' : 'scope-tag-local'}`}><span className="scope-tag-dot" />{origin}</span> : null}
      {terminalsMode === 'local' && origin === 'overridden' ? <button type="button" className="scope-link term-reset-btn" title="Discard the local override">Reset to shared</button> : null}
      {readonly ? '' : <button type="button" className="cmd-outline-edit-btn" title="Edit">{PENCIL_ICON}</button>}
      {readonly ? '' : <button type="button" className="cmd-outline-delete-btn" title={isSharedHere ? 'Hide on this machine' : 'Delete'}>{TRASH_ICON}</button>}
    </div>
  );

  // The one per-row listener that can't move to the container: the WebKit
  // mousedown swallow (see the module JSDoc). It must run at the button before
  // the draggable row, so the click survives in WKWebView. Stateless — no
  // index captured, no stale-closure risk. The button `dragstart` listeners
  // the pre-fix code attached were dead (a `<button>` isn't draggable, so the
  // drag always starts on the row, never the button) and are dropped.
  const swallow = (e: Event) => { e.stopPropagation(); };
  row.querySelector('.cmd-outline-edit-btn')?.addEventListener('mousedown', swallow);
  row.querySelector('.cmd-outline-delete-btn')?.addEventListener('mousedown', swallow);
  row.querySelector('.term-reset-btn')?.addEventListener('mousedown', swallow);

  return row;
}

/**
 * Open the terminal-edit dialog.
 *
 * `mode: 'edit'` (default) — operates on an existing entry already in the
 * `terminals[]` array. The Done / Cancel-by-X actions both commit the
 * dialog state back into the entry (preserving the long-standing edit
 * behavior where dragging the X is "save and close").
 *
 * `mode: 'add'` (HS-7958) — operates on a fresh entry NOT yet in
 * `terminals[]`. The dialog only commits the entry on the final
 * "Add Terminal" button click; clicking X or the backdrop discards the
 * entry entirely so the user can abandon a half-typed new terminal
 * without leaving a stub row in the list. The footer button text and
 * the dialog header swap for the add case.
 */
function openEditor(
  entry: EditableTerminalConfig,
  options: { focusField?: 'name' | 'command'; mode?: 'edit' | 'add' } = {},
): void {
  document.querySelectorAll('.cmd-editor-overlay').forEach(el => el.remove());
  const focusField = options.focusField ?? 'name';
  const mode = options.mode ?? 'edit';
  const isAdd = mode === 'add';

  // HS-7562 — pre-resolve the appearance defaults the dialog will display.
  // Per the user's clarifying answer (4/25/2026): no separate sentinel
  // option; just show the theme / font lists with the project default
  // pre-selected. Whatever the user picks gets saved verbatim.
  // HS-8283 — settings UI is for the active project; per-project default
  // cache is keyed by secret.
  const projectDefault = getProjectDefault(getActiveProject()?.secret ?? '');
  const initialTheme = entry.theme ?? projectDefault.theme ?? DEFAULT_THEME_ID;
  const initialFontFamily = entry.fontFamily ?? projectDefault.fontFamily ?? 'system';
  const initialFontSize = clampFontSize(entry.fontSize ?? projectDefault.fontSize ?? DEFAULT_FONT_SIZE);
  const appearanceOpenByDefault = entry.theme !== undefined
    || entry.fontFamily !== undefined
    || entry.fontSize !== undefined;

  const themeOptions = TERMINAL_THEMES.map(t => (
    <option value={t.id} selected={t.id === initialTheme}>{t.name}</option>
  ));
  const fontOptions = TERMINAL_FONTS.map(f => (
    <option value={f.id} selected={f.id === initialFontFamily}>{f.name}</option>
  ));

  // HS-7958 — the dialog field ids previously included the array index, but
  // in add-mode the entry isn't in the array yet. Use the entry's own id so
  // labels stay correctly wired in both modes (and so multiple add-flows
  // wouldn't ever collide if we ever stack them).
  const fieldIdSuffix = entry.id;

  const overlay = toElement(
    <div className="cmd-editor-overlay">
      <div className="cmd-editor-dialog">
        <div className="cmd-editor-dialog-header">
          <span>{isAdd ? 'New Terminal' : 'Edit Terminal'}</span>
          <button className="cmd-editor-close-btn" title={isAdd ? 'Cancel' : 'Close'}>{'×'}</button>
        </div>
        <div className="cmd-editor-dialog-body">
          <div className="settings-field">
            <label>Name (tab label)</label>
            <input type="text" className="term-edit-name" value={entry.name ?? ''} placeholder="Terminal" />
          </div>
          <div className="settings-field">
            <label>Command</label>
            {/* HS-7791 — custom combobox (we used to delegate to the native
                <input list> + <datalist> pair, but the system-rendered popup
                in Tauri's WKWebView ignored our `color-scheme: light` and
                rendered options as white-on-white per the HS-7791 follow-up).
                The popover below is fully styled via the app's tokens so
                contrast is guaranteed and the look matches the rest of the
                app. The input stays freely editable so any shell-valid
                command can be typed. */}
            <div className="cmd-combobox">
              <input
                type="text"
                className="term-edit-command"
                value={entry.command}
                placeholder={COMMAND_INPUT_PLACEHOLDER}
                autocomplete="off"
                spellcheck="false"
              />
              <div className="cmd-combobox-popover" hidden></div>
            </div>
            <span className="settings-hint">{'Pick a common command from the dropdown or type your own. Use {{claudeCommand}} to resolve to claude.'}</span>
          </div>
          <div className="settings-field">
            <label>Working directory</label>
            <input type="text" className="term-edit-cwd" value={entry.cwd ?? ''} placeholder="(project root)" />
            <span className="settings-hint">{'Leave blank for the project root. Relative paths (e.g. sub-folder or ./scratch) resolve against the project root. Use {{projectDir}} to compose paths explicitly. Absolute paths (/abs/path) are used verbatim.'}</span>
          </div>
          <div className="settings-field settings-field-checkbox">
            <label>
              <input type="checkbox" className="term-edit-lazy" checked={entry.lazy !== false} />
              Lazy launch (spawn only on first tab activation)
            </label>
            <span className="settings-hint">Uncheck to spawn the PTY as soon as the project has loaded.</span>
          </div>
          {/* HS-7562 — Appearance overrides per terminal. Collapsed by default
              unless the entry already has any of theme/fontFamily/fontSize set,
              in which case it auto-opens so the user sees the live values. */}
          <details className="term-edit-appearance" open={appearanceOpenByDefault}>
            <summary>Appearance</summary>
            <div className="settings-field">
              <label htmlFor={`term-edit-theme-${fieldIdSuffix}`}>Theme</label>
              <select id={`term-edit-theme-${fieldIdSuffix}`} className="term-edit-theme">{themeOptions}</select>
              <span className="settings-hint">Default selected = current project default. Pick a different theme to override for this terminal only.</span>
            </div>
            <div className="settings-field">
              <label htmlFor={`term-edit-font-${fieldIdSuffix}`}>Font</label>
              <select id={`term-edit-font-${fieldIdSuffix}`} className="term-edit-font">{fontOptions}</select>
            </div>
            <div className="settings-field">
              <label htmlFor={`term-edit-font-size-${fieldIdSuffix}`}>Font size</label>
              <input
                type="number"
                id={`term-edit-font-size-${fieldIdSuffix}`}
                className="term-edit-font-size"
                min={String(MIN_FONT_SIZE)}
                max={String(MAX_FONT_SIZE)}
                step="1"
                value={String(initialFontSize)}
              />
            </div>
          </details>
        </div>
        <div className="cmd-editor-dialog-footer">
          <button className="btn btn-sm cmd-editor-done-btn">{isAdd ? 'Add Terminal' : 'Done'}</button>
        </div>
      </div>
    </div>
  );

  /** Read the dialog state and produce the resulting EditableTerminalConfig
   *  with the same fall-through-to-`{{claudeCommand}}` rule the long-standing
   *  edit flow uses. Pure of side effects so the add-mode commit path can
   *  call it once and discard the dialog without committing. */
  const collectUpdated = (): EditableTerminalConfig => {
    const name = (overlay.querySelector('.term-edit-name') as HTMLInputElement).value;
    const command = (overlay.querySelector('.term-edit-command') as HTMLInputElement).value;
    const cwd = (overlay.querySelector('.term-edit-cwd') as HTMLInputElement).value.trim();
    const lazy = (overlay.querySelector('.term-edit-lazy') as HTMLInputElement).checked;
    const themeSel = overlay.querySelector<HTMLSelectElement>('.term-edit-theme');
    const fontSel = overlay.querySelector<HTMLSelectElement>('.term-edit-font');
    const sizeInput = overlay.querySelector<HTMLInputElement>('.term-edit-font-size');
    const updated: EditableTerminalConfig = { ...entry, command: command !== '' ? command : '{{claudeCommand}}', lazy };
    if (name !== '') updated.name = name; else delete updated.name;
    if (cwd !== '') updated.cwd = cwd; else delete updated.cwd;
    // HS-7562 — save the explicit theme / font / size verbatim. The pre-
    // selected value reflected the project default at dialog-open time, so a
    // user who didn't touch the controls still ends up with their per-terminal
    // value matching the project default's CURRENT value (decoupling future
    // project-default changes from this terminal). If the user wants the
    // terminal to track the project default, they can clear the override
    // by deleting the entry's theme/fontFamily/fontSize keys directly in
    // settings.json — adding an explicit "Reset" affordance is a deliberate
    // future enhancement.
    if (themeSel !== null) updated.theme = themeSel.value;
    if (fontSel !== null) updated.fontFamily = fontSel.value;
    if (sizeInput !== null) {
      const parsed = Number.parseFloat(sizeInput.value);
      if (Number.isFinite(parsed)) updated.fontSize = clampFontSize(parsed);
    }
    return updated;
  };

  /** Persist the dialog result into the `terminals[]` array, save, and
   *  notify any mounted xterm. The branch on add vs edit determines whether
   *  we push a new entry or replace an existing one. */
  const commit = async (): Promise<void> => {
    const updated = collectUpdated();
    if (isAdd) {
      // HS-7958 — only NOW does the terminal join the configured list. The
      // entry's id was generated at addTerminalEntry time and is reused here.
      terminals.push(updated);
    } else {
      const idx = terminals.findIndex(t => t.id === updated.id);
      if (idx === -1) terminals.push(updated);
      else terminals[idx] = updated;
    }
    overlay.remove();
    renderList();
    await scheduleSave();
    // HS-7562 — notify any mounted xterm for this terminal that its config
    // changed so it re-resolves appearance without a page reload. The
    // event payload carries the terminalId so listeners can filter cheaply.
    document.dispatchEvent(new CustomEvent('hotsheet:terminal-config-changed', {
      detail: { terminalId: updated.id },
    }));
  };

  /** Cancel path: in add-mode this discards the entry entirely (HS-7958
   *  requirement — clicking X on a new terminal cancels creation). In
   *  edit-mode it preserves the long-standing "X = save and close" behavior
   *  so existing-terminal edits keep their current commit semantics. */
  const cancel = async (): Promise<void> => {
    if (isAdd) {
      overlay.remove();
      return;
    }
    await commit();
  };

  overlay.querySelector('.cmd-editor-close-btn')?.addEventListener('click', () => { void cancel(); });
  overlay.querySelector('.cmd-editor-done-btn')?.addEventListener('click', () => { void commit(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) void cancel(); });
  document.body.appendChild(overlay);
  const nameInput = overlay.querySelector<HTMLInputElement>('.term-edit-name');
  const cmdInput = overlay.querySelector<HTMLInputElement>('.term-edit-command');
  const cmdPopover = overlay.querySelector<HTMLDivElement>('.cmd-combobox-popover');

  // HS-7858 — for new terminals (added via `addTerminalEntry` with focusField
  // = 'command'), focus the command field so the popover opens immediately
  // and the user can pick. Otherwise focus the name field as before.
  if (focusField === 'command' && cmdInput !== null) {
    cmdInput.focus();
  } else if (nameInput !== null) {
    nameInput.focus();
  }

  // HS-7791 — wire the custom combobox popover. Suggestions come from the
  // cached /api/terminal/command-suggestions response; clicks populate the
  // input; focus shows everything; typing filters by substring (case
  // insensitive) so the user can keep narrowing as they type.
  // HS-7858 — when the user commits a command via click or Enter and the
  // name field is currently empty, auto-derive a sensible default name from
  // the chosen command (see `deriveNameFromCommand`).
  if (cmdInput !== null && cmdPopover !== null) {
    void wireCommandCombobox(cmdInput, cmdPopover, (value) => {
      if (nameInput !== null && nameInput.value.trim() === '') {
        const derived = deriveNameFromCommand(value);
        if (derived !== '') nameInput.value = derived;
      }
    });
  }
}

/** HS-7791 follow-up — render + behavior for the per-input command combobox.
 *  Lives next to the input and is fully styled via app tokens (the native
 *  datalist popup didn't honour our color-scheme in Tauri's WKWebView and
 *  rendered as white-on-white). The optional `onCommit` callback fires after
 *  a value is committed via click or Enter (HS-7858 uses it to auto-populate
 *  the sibling name field when blank). */
async function wireCommandCombobox(
  input: HTMLInputElement,
  popover: HTMLDivElement,
  onCommit?: (value: string) => void,
): Promise<void> {
  const suggestions = await loadCommandSuggestions();
  let activeIndex = -1;
  let visibleMatches: string[] = [];

  const render = () => {
    const filter = input.value.trim().toLowerCase();
    visibleMatches = filter === ''
      ? suggestions.slice()
      : suggestions.filter(s => s.toLowerCase().includes(filter));
    if (visibleMatches.length === 0) {
      popover.hidden = true;
      popover.innerHTML = '';
      return;
    }
    popover.innerHTML = '';
    visibleMatches.forEach((s, i) => {
      const opt = toElement(
        <button type="button" className={`cmd-combobox-option${i === activeIndex ? ' is-active' : ''}`} data-value={s}>
          {s}
        </button>
      );
      // Use mousedown so the input doesn't blur (and dismiss the popover)
      // before the click registers.
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault();
        commit(s);
      });
      popover.appendChild(opt);
    });
    popover.hidden = false;
  };

  const commit = (value: string) => {
    input.value = value;
    popover.hidden = true;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (onCommit !== undefined) onCommit(value);
  };

  input.addEventListener('focus', () => { activeIndex = -1; render(); });
  input.addEventListener('input', () => { activeIndex = -1; render(); });
  input.addEventListener('blur', () => {
    setTimeout(() => { popover.hidden = true; }, BLUR_DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (e) => {
    if (popover.hidden !== false && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      activeIndex = -1; render();
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (visibleMatches.length === 0) return;
      activeIndex = (activeIndex + 1) % visibleMatches.length;
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (visibleMatches.length === 0) return;
      activeIndex = activeIndex <= 0 ? visibleMatches.length - 1 : activeIndex - 1;
      render();
    } else if (e.key === 'Enter' && activeIndex >= 0 && activeIndex < visibleMatches.length) {
      e.preventDefault();
      commit(visibleMatches[activeIndex]);
    } else if (e.key === 'Escape' && popover.hidden === false) {
      popover.hidden = true;
      activeIndex = -1;
    }
  });
}

/** Debounced save of the full terminals array. */
function scheduleSave(): Promise<void> {
  if (saveTimeout) clearTimeout(saveTimeout);
  return new Promise((resolve) => {
    saveTimeout = setTimeout(async () => {
      saveTimeout = null;
      // HS-9015 — Shared → write the array; Local → write the delta vs shared;
      // Resolved → today's default-routed save.
      await saveScopedList('terminals', termIdOf, terminalsShared, terminals,
        () => updateFileSettings({ terminals }));
      try {
        const mod = await import('./terminal.js');
        await mod.refreshTerminalsAfterSettingsChange();
      } catch { /* ignore */ }
      resolve();
    }, 400);
  });
}

/** Open the editor in add-mode for a fresh terminal entry.
 *
 *  HS-7958 — the entry is NOT pushed into `terminals[]` here. The push
 *  happens inside the editor's `commit()` path when the user clicks
 *  "Add Terminal". Clicking X / the backdrop discards the entry entirely
 *  (no stub row left in the list, no debounced save fired). Pre-fix the
 *  blank entry was pushed eagerly + persisted on close regardless of
 *  intent.
 *
 *  HS-7858 — neither name nor command get a default value: the user is
 *  expected to make an explicit choice from the combobox. The name will
 *  auto-populate when they commit a command (see `wireCommandCombobox`),
 *  and `openEditor`'s focusField parameter routes initial focus to the
 *  command field so the popover opens immediately. */
export function addTerminalEntry(): void {
  const id = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const draft: EditableTerminalConfig = { id, command: '' };
  openEditor(draft, { focusField: 'command', mode: 'add' });
}

/** HS-7858 — derive a sensible default tab name from the chosen command.
 *  The sentinel `{{claudeCommand}}` becomes "Claude"; everything else uses
 *  the basename of the path with any trailing `.exe` / `.cmd` / `.ps1` /
 *  `.bat` extension stripped (so `C:\\Windows\\System32\\cmd.exe` →
 *  `cmd`, `/bin/zsh` → `zsh`). Whitespace-only input falls through to an
 *  empty string so callers can decide how to handle it. */
export function deriveNameFromCommand(command: string): string {
  const trimmed = command.trim();
  if (trimmed === '') return '';
  if (trimmed === '{{claudeCommand}}') return 'Claude';
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const base = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  return base.replace(/\.(exe|cmd|ps1|bat)$/i, '');
}
