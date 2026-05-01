import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { confirmDialog } from './confirm.js';
import { toElement } from './dom.js';
import { parseJsonArrayOr } from './json.js';
import type { TerminalTabConfig } from './terminal.js';
import { getProjectDefault } from './terminalAppearance.js';
import { clampFontSize, DEFAULT_FONT_SIZE, MAX_FONT_SIZE, MIN_FONT_SIZE, TERMINAL_FONTS } from './terminalFonts.js';
import { DEFAULT_THEME_ID, TERMINAL_THEMES } from './terminalThemes.js';

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
        const res = await api<{ suggestions?: string[] }>('/terminal/command-suggestions');
        const list = Array.isArray(res.suggestions) ? res.suggestions : ['{{claudeCommand}}'];
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
  // HS-8090 — `parseJsonArrayOr` for the string path. The non-string
  // path (`raw` is already an array — set when settings are populated
  // from the live in-memory state) skips parsing and validates
  // element-by-element below.
  const parsed = typeof raw === 'string'
    ? parseJsonArrayOr(raw, []) as unknown[]
    : raw;
  if (parsed.length === 0) return [];
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
    openEditor(terminals[index], { mode: 'edit' });
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

/**
 * Open the terminal-edit dialog.
 *
 * `mode: 'edit'` (default) — operates on an existing entry already in the
 * `terminals[]` array. The Done / Cancel-by-X actions both commit the
 * dialog state back into the entry (preserving the long-standing edit
 * behaviour where dragging the X is "save and close").
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
  const projectDefault = getProjectDefault();
  const initialTheme = entry.theme ?? projectDefault.theme ?? DEFAULT_THEME_ID;
  const initialFontFamily = entry.fontFamily ?? projectDefault.fontFamily ?? 'system';
  const initialFontSize = clampFontSize(entry.fontSize ?? projectDefault.fontSize ?? DEFAULT_FONT_SIZE);
  const appearanceOpenByDefault = entry.theme !== undefined
    || entry.fontFamily !== undefined
    || entry.fontSize !== undefined;

  const themeOptions = TERMINAL_THEMES
    .map(t => `<option value="${t.id}"${t.id === initialTheme ? ' selected' : ''}>${escapeHtml(t.name)}</option>`)
    .join('');
  const fontOptions = TERMINAL_FONTS
    .map(f => `<option value="${f.id}"${f.id === initialFontFamily ? ' selected' : ''}>${escapeHtml(f.name)}</option>`)
    .join('');

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
              {raw(`<select id="term-edit-theme-${fieldIdSuffix}" class="term-edit-theme">${themeOptions}</select>`)}
              <span className="settings-hint">Default selected = current project default. Pick a different theme to override for this terminal only.</span>
            </div>
            <div className="settings-field">
              <label htmlFor={`term-edit-font-${fieldIdSuffix}`}>Font</label>
              {raw(`<select id="term-edit-font-${fieldIdSuffix}" class="term-edit-font">${fontOptions}</select>`)}
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
   *  edit-mode it preserves the long-standing "X = save and close" behaviour
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

/** HS-7791 follow-up — render + behaviour for the per-input command combobox.
 *  Lives next to the input and is fully styled via app tokens (the native
 *  datalist popup didn't honour our colour-scheme in Tauri's WKWebView and
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
    setTimeout(() => { popover.hidden = true; }, 150);
  });
  input.addEventListener('keydown', (e) => {
    if (popover.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
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
    } else if (e.key === 'Escape' && !popover.hidden) {
      popover.hidden = true;
      activeIndex = -1;
    }
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
