import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { confirmDialog } from './confirm.js';
import { toElement } from './dom.js';

/**
 * HS-7953 — Settings → Permissions management page + the per-popup
 * "Always allow" overlay shortcut helper.
 *
 * HS-8026 — row layout rewritten to match the cmd-outline / terminal
 * settings rows (pencil-edit / trash-delete buttons, click-row-to-edit),
 * and the inline +Add form replaced by an "Add rule" button that opens the
 * same modal dialog as the pencil-edit. Long patterns are no longer
 * irrecoverably truncated — they ellipsis with a `title` tooltip in the
 * row and show in full inside the editor dialog.
 *
 * Rules live in `<dataDir>/settings.json` under `permission_allow_rules`
 * (file-based, per-project for free; added to `JSON_VALUE_KEYS` in
 * `src/file-settings.ts`). Shape: `{id, tool, pattern, added_at, added_by}[]`.
 *
 * The matcher (`src/permissionAllowRules.ts::findMatchingAllowRule`) is the
 * trust boundary; this module is presentation. The pattern is auto-anchored
 * with `^…$` at match time, so the user can type `git status` and not have
 * to remember to anchor it themselves.
 *
 * See docs/47-richer-permission-overlay.md §47.4.
 */

export interface AllowRule {
  id: string;
  tool: string;
  pattern: string;
  added_at: string;
  added_by?: 'overlay' | 'settings';
}

const TOOLS_FOR_RULE: ReadonlyArray<string> = ['Bash', 'Read', 'NotebookRead', 'Glob', 'WebFetch', 'WebSearch'];

/** HS-8026 — pencil + trash icons matched to the cmd-outline / terminal
 *  settings rows so the surfaces read as siblings. */
const PENCIL_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
const TRASH_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';

/** Pure: ULID-ish id generator. Not a real ULID — just `ar_<base36 ts>_<random>`
 *  which is sortable + unique enough for per-project allow rules. Exported
 *  for tests. */
export function newRuleId(now: number = Date.now(), rand: number = Math.random()): string {
  return `ar_${now.toString(36)}_${Math.floor(rand * 1e8).toString(36)}`;
}

/** Pure: regex-escape an arbitrary string so it can be used inside a regex
 *  source as a literal. Anchoring (`^…$`) is added by the matcher, not
 *  here — the overlay shortcut pre-fills `^<escaped>$` for clarity but the
 *  user can edit either part. Exported for tests. */
export function regexEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Pure: validate a candidate pattern by attempting to compile it (with the
 *  same `^…$` anchoring the matcher applies). Returns null on success;
 *  the error message on failure. Exported for tests. */
export function validatePattern(pattern: string): string | null {
  if (pattern.trim() === '') return 'Pattern is required';
  try {
    new RegExp(`^(?:${pattern})$`);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid regex';
  }
}

// ---------------------------------------------------------------------------
// Settings → Permissions management page
// ---------------------------------------------------------------------------

/** Fetch the rules from `/file-settings`, render the list + the "Add rule"
 *  affordance. Called when the Settings → Permissions tab is shown. */
export async function loadAndRenderAllowList(): Promise<void> {
  const rules = await fetchRules();
  renderRules(rules);
}

async function fetchRules(): Promise<AllowRule[]> {
  try {
    const fs = await api<{ permission_allow_rules?: unknown }>('/file-settings');
    return parseRules(fs.permission_allow_rules);
  } catch {
    return [];
  }
}

/** Pure: tolerantly normalise a settings value into an `AllowRule[]`.
 *  Identical shape to `src/permissionAllowRules.ts::parseAllowRules` — kept
 *  duplicated to avoid pulling server code into the client bundle.
 *  Exported for tests. */
export function parseRules(raw: unknown): AllowRule[] {
  let value: unknown = raw;
  if (typeof value === 'string' && value !== '') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  const out: AllowRule[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Partial<AllowRule>;
    if (typeof obj.id !== 'string' || obj.id === '') continue;
    if (typeof obj.tool !== 'string' || obj.tool === '') continue;
    if (typeof obj.pattern !== 'string') continue;
    const added_at = typeof obj.added_at === 'string' ? obj.added_at : '';
    const added_by = obj.added_by === 'overlay' || obj.added_by === 'settings'
      ? obj.added_by
      : undefined;
    out.push({ id: obj.id, tool: obj.tool, pattern: obj.pattern, added_at, added_by });
  }
  return out;
}

function renderRules(rules: AllowRule[]): void {
  const container = document.getElementById('permission-allow-list');
  if (container === null) return;
  container.replaceChildren();
  if (rules.length === 0) {
    container.appendChild(toElement(
      <div className="permission-allow-empty">No allow rules yet. Click "+ Add rule" below or "Always allow" on a permission popup to create one.</div>
    ));
  } else {
    // Most-recent first.
    const sorted = [...rules].sort((a, b) => b.added_at.localeCompare(a.added_at));
    for (const rule of sorted) {
      container.appendChild(renderRow(rule));
    }
  }
  container.appendChild(renderAddButton());
}

/** HS-8026 — single rule row. Mirrors `cmd-outline-row` shape (tool +
 *  pattern + pencil + trash); the row itself is clickable so a wide click
 *  target opens the editor. Pattern overflow is ellipsis with a `title`
 *  tooltip so long values stay discoverable without the editor. */
function renderRow(rule: AllowRule): HTMLElement {
  // The row uses two class names on purpose: `cmd-outline-row` brings the
  // shared visual scale that the custom-command + terminal settings rows
  // already use (border, padding, hover); `permission-allow-rule-row` is
  // the HS-8026 hook for the click-to-edit cursor + the focus ring + the
  // flex constraints on the tool / pattern columns. The §52 terminal-prompt
  // allow list (`terminalPromptAllowListUI.tsx`) still uses the legacy
  // `.permission-allow-row` grid — see styles.scss for the comment.
  const row = toElement(
    <div className="cmd-outline-row permission-allow-rule-row" data-rule-id={rule.id} role="button" tabIndex={0}>
      <span className="permission-allow-rule-tool">{rule.tool}</span>
      <code className="permission-allow-rule-pattern" title={rule.pattern}>{rule.pattern}</code>
      <button type="button" className="cmd-outline-edit-btn permission-allow-edit" title="Edit">{raw(PENCIL_ICON)}</button>
      <button type="button" className="cmd-outline-delete-btn permission-allow-delete" title="Delete">{raw(TRASH_ICON)}</button>
    </div>
  );

  const editBtn = row.querySelector<HTMLButtonElement>('.permission-allow-edit')!;
  const deleteBtn = row.querySelector<HTMLButtonElement>('.permission-allow-delete')!;

  editBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openRuleEditor({ mode: 'edit', rule });
  });
  deleteBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void deleteRule(rule);
  });

  row.addEventListener('click', () => { openRuleEditor({ mode: 'edit', rule }); });
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openRuleEditor({ mode: 'edit', rule });
    }
  });

  return row;
}

function renderAddButton(): HTMLElement {
  const wrap = toElement(
    <div className="permission-allow-add-row">
      <button type="button" className="btn btn-sm" id="permission-allow-add-btn">+ Add rule</button>
    </div>
  );
  wrap.querySelector<HTMLButtonElement>('#permission-allow-add-btn')!.addEventListener('click', () => {
    openRuleEditor({ mode: 'add' });
  });
  return wrap;
}

async function deleteRule(rule: AllowRule): Promise<void> {
  const ok = await confirmDialog({
    title: 'Delete allow rule?',
    message: `Tool: ${rule.tool}\nPattern: ${rule.pattern}\n\nFuture matching permission requests will require manual approval again.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  const rules = await fetchRules();
  const next = rules.filter(r => r.id !== rule.id);
  await api('/file-settings', { method: 'PATCH', body: { permission_allow_rules: next } });
  renderRules(next);
}

// ---------------------------------------------------------------------------
// HS-8026 — modal rule editor (add / edit)
// ---------------------------------------------------------------------------

type EditorOptions =
  | { mode: 'add' }
  | { mode: 'edit'; rule: AllowRule };

/** Open the modal rule editor. Reuses the `.cmd-editor-overlay` /
 *  `.cmd-editor-dialog` shell that the custom-command + terminal editors
 *  already use, so the look is identical. Exported for tests. */
export function openRuleEditor(options: EditorOptions): HTMLElement {
  document.querySelectorAll('.cmd-editor-overlay.permission-allow-editor').forEach(el => el.remove());

  const isEdit = options.mode === 'edit';
  const initialTool = isEdit ? options.rule.tool : 'Bash';
  const initialPattern = isEdit ? options.rule.pattern : '';
  const headerText = isEdit ? 'Edit allow rule' : 'Add allow rule';
  const saveLabel = isEdit ? 'Save' : 'Add rule';

  const toolOptions = TOOLS_FOR_RULE
    .map(t => `<option value="${t}"${t === initialTool ? ' selected' : ''}>${t}</option>`)
    .join('');

  const overlay = toElement(
    <div className="cmd-editor-overlay permission-allow-editor">
      <div className="cmd-editor-dialog">
        <div className="cmd-editor-dialog-header">
          <span>{headerText}</span>
          <button className="cmd-editor-close-btn" title="Cancel" type="button">{'×'}</button>
        </div>
        <div className="cmd-editor-dialog-body">
          <div className="settings-field">
            <label>Tool</label>
            {raw(`<select class="permission-allow-edit-tool">${toolOptions}</select>`)}
          </div>
          <div className="settings-field">
            <label>Pattern</label>
            <textarea className="permission-allow-edit-pattern" rows={3} spellcheck="false" placeholder="^git (status|diff)$">{initialPattern}</textarea>
            <span className="settings-hint">JS regex, auto-anchored with <code>^…$</code> when matched. So <code>git status</code> matches exactly that, not <code>cd /tmp &amp;&amp; git status</code>.</span>
          </div>
          <p className="permission-allow-edit-error" style="display:none"></p>
        </div>
        <div className="cmd-editor-dialog-footer">
          <button className="btn btn-sm permission-allow-edit-cancel" type="button">Cancel</button>
          <button className="btn btn-sm permission-allow-edit-save" type="button">{saveLabel}</button>
        </div>
      </div>
    </div>
  );

  const closeBtn = overlay.querySelector<HTMLButtonElement>('.cmd-editor-close-btn')!;
  const cancelBtn = overlay.querySelector<HTMLButtonElement>('.permission-allow-edit-cancel')!;
  const saveBtn = overlay.querySelector<HTMLButtonElement>('.permission-allow-edit-save')!;
  const toolSel = overlay.querySelector<HTMLSelectElement>('.permission-allow-edit-tool')!;
  const patternEl = overlay.querySelector<HTMLTextAreaElement>('.permission-allow-edit-pattern')!;
  const errorEl = overlay.querySelector<HTMLElement>('.permission-allow-edit-error')!;

  const close = () => { overlay.remove(); };
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const submit = async () => {
    const tool = toolSel.value;
    const pattern = patternEl.value;
    const validation = validatePattern(pattern);
    if (validation !== null) {
      errorEl.textContent = `Invalid pattern: ${validation}`;
      errorEl.style.display = '';
      return;
    }
    errorEl.style.display = 'none';
    saveBtn.disabled = true;
    try {
      const rules = await fetchRules();
      let next: AllowRule[];
      if (isEdit) {
        next = rules.map(r => r.id === options.rule.id ? { ...r, tool, pattern } : r);
      } else {
        const rule: AllowRule = {
          id: newRuleId(),
          tool,
          pattern,
          added_at: new Date().toISOString(),
          added_by: 'settings',
        };
        next = [...rules, rule];
      }
      await api('/file-settings', { method: 'PATCH', body: { permission_allow_rules: next } });
      renderRules(next);
      close();
    } catch {
      errorEl.textContent = 'Failed to save rule';
      errorEl.style.display = '';
      saveBtn.disabled = false;
    }
  };

  saveBtn.addEventListener('click', () => { void submit(); });
  patternEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
    if (e.key === 'Escape') { close(); }
  });

  document.body.appendChild(overlay);
  patternEl.focus();
  patternEl.select();
  return overlay;
}

// ---------------------------------------------------------------------------
// Overlay shortcut — "Always allow" link inside the permission popup
// ---------------------------------------------------------------------------

/** HS-7953 — append the "Always allow" link + inline editor to a permission
 *  popup. Returns null when the tool isn't allow-listable OR the primary
 *  value is empty (in which case the caller should skip rendering the
 *  affordance entirely). The returned element is the wrapper div the
 *  caller appends into the popup's body.
 *
 *  `onCommit` is called when the user confirms a new rule + clicks Allow:
 *  the caller then runs its existing allow-the-current-request logic.
 */
export function buildAlwaysAllowAffordance(opts: {
  toolName: string;
  primaryValue: string;
  onCommit: () => void;
}): HTMLElement | null {
  if (opts.primaryValue === '') return null;
  if (!TOOLS_FOR_RULE.includes(opts.toolName)) return null;
  const initial = `^${regexEscape(opts.primaryValue)}$`;
  // HS-7976 — clicking "Always allow this" now commits the auto-generated
  // `^…$` pattern immediately (no second step). The gear button next to the
  // link opens the inline editor for users who want to broaden the pattern
  // before saving.
  const root = toElement(
    <div className="permission-popup-always-allow">
      <div className="permission-popup-always-allow-row">
        <a className="permission-popup-always-allow-link" href="#">Always allow this</a>
        <button className="permission-popup-always-allow-customize" type="button" title="Customize matching rule" aria-label="Customize matching rule">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
      </div>
      <div className="permission-popup-always-allow-form" style="display:none">
        <input type="text" className="permission-popup-always-allow-input" value={initial} />
        <button className="btn btn-sm permission-popup-always-allow-confirm" type="button">Save & Allow</button>
        <button className="btn btn-sm permission-popup-always-allow-cancel" type="button">Cancel</button>
      </div>
      <p className="permission-popup-always-allow-error" style="display:none;color:#991b1b;font-size:11px;margin:4px 0 0"></p>
    </div>
  );

  const linkRow = root.querySelector<HTMLElement>('.permission-popup-always-allow-row')!;
  const link = root.querySelector<HTMLAnchorElement>('.permission-popup-always-allow-link')!;
  const customize = root.querySelector<HTMLButtonElement>('.permission-popup-always-allow-customize')!;
  const form = root.querySelector<HTMLElement>('.permission-popup-always-allow-form')!;
  const input = root.querySelector<HTMLInputElement>('.permission-popup-always-allow-input')!;
  const confirm = root.querySelector<HTMLButtonElement>('.permission-popup-always-allow-confirm')!;
  const cancel = root.querySelector<HTMLButtonElement>('.permission-popup-always-allow-cancel')!;
  const errorEl = root.querySelector<HTMLElement>('.permission-popup-always-allow-error')!;

  // HS-7976 — link click commits the default pattern immediately.
  link.addEventListener('click', (e) => {
    e.preventDefault();
    if (link.classList.contains('is-saving')) return;
    link.classList.add('is-saving');
    void saveRuleAndCommit(initial);
  });
  // Gear icon opens the inline editor for users who want to broaden the
  // auto-generated pattern.
  customize.addEventListener('click', (e) => {
    e.preventDefault();
    linkRow.style.display = 'none';
    form.style.display = '';
    input.focus();
    input.select();
  });
  cancel.addEventListener('click', () => {
    form.style.display = 'none';
    linkRow.style.display = '';
    errorEl.style.display = 'none';
  });
  confirm.addEventListener('click', () => {
    void onConfirmClick();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { void onConfirmClick(); }
    if (e.key === 'Escape') { cancel.click(); }
  });

  async function onConfirmClick(): Promise<void> {
    const pattern = input.value;
    const validation = validatePattern(pattern);
    if (validation !== null) {
      errorEl.textContent = `Invalid: ${validation}`;
      errorEl.style.display = '';
      return;
    }
    errorEl.style.display = 'none';
    confirm.disabled = true;
    await saveRuleAndCommit(pattern, () => { confirm.disabled = false; });
  }

  /** Shared between the link's "use default pattern" path and the form's
   *  "Save & Allow" path. `onSaveError` lets the form path re-enable its
   *  Save button if the PATCH fails. */
  async function saveRuleAndCommit(pattern: string, onSaveError?: () => void): Promise<void> {
    try {
      const fs = await api<{ permission_allow_rules?: unknown }>('/file-settings');
      const existing = parseRules(fs.permission_allow_rules);
      const rule: AllowRule = {
        id: newRuleId(),
        tool: opts.toolName,
        pattern,
        added_at: new Date().toISOString(),
        added_by: 'overlay',
      };
      await api('/file-settings', {
        method: 'PATCH',
        body: { permission_allow_rules: [...existing, rule] },
      });
    } catch {
      errorEl.textContent = 'Failed to save rule';
      errorEl.style.display = '';
      link.classList.remove('is-saving');
      onSaveError?.();
      return;
    }
    // Rule saved — invoke the caller's allow-the-current-request handler.
    opts.onCommit();
  }

  return root;
}
