import { api } from './api.js';
import { confirmDialog } from './confirm.js';
import { toElement } from './dom.js';

/**
 * HS-7953 — Settings → Permissions management page + the per-popup
 * "Always allow" overlay shortcut helper.
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

/** Fetch the rules from `/file-settings`, render the table + bind the +Add
 *  form. Called when the Settings → Permissions tab is shown. */
export async function loadAndRenderAllowList(): Promise<void> {
  const rules = await fetchRules();
  renderRules(rules);
  bindAddForm();
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
    return;
  }
  // Most-recent first.
  const sorted = [...rules].sort((a, b) => (b.added_at ?? '').localeCompare(a.added_at ?? ''));
  for (const rule of sorted) {
    const row = toElement(
      <div className="permission-allow-row" data-rule-id={rule.id}>
        <span className="permission-allow-tool">{rule.tool}</span>
        <code className="permission-allow-pattern">{rule.pattern}</code>
        <span className="permission-allow-meta">{formatRuleMeta(rule)}</span>
        <button className="permission-allow-delete btn btn-sm btn-danger" title="Delete rule" type="button">×</button>
      </div>
    );
    row.querySelector<HTMLButtonElement>('.permission-allow-delete')!.addEventListener('click', () => {
      void deleteRule(rule);
    });
    container.appendChild(row);
  }
}

/** Pure: format the meta column ("added overlay" / "added 4d ago" etc.).
 *  Empty when neither added_at nor added_by is meaningful. Exported for
 *  tests. */
export function formatRuleMeta(rule: AllowRule): string {
  const parts: string[] = [];
  if (rule.added_by !== undefined) parts.push(rule.added_by);
  if (rule.added_at !== '' && rule.added_at !== undefined) {
    const date = new Date(rule.added_at);
    if (!Number.isNaN(date.getTime())) parts.push(date.toLocaleDateString());
  }
  return parts.join(' · ');
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

function bindAddForm(): void {
  const btn = document.getElementById('permission-allow-add-btn') as HTMLButtonElement | null;
  if (btn === null || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', () => { void onAddClick(); });
  const patternInput = document.getElementById('permission-allow-add-pattern') as HTMLInputElement | null;
  if (patternInput !== null) {
    patternInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { void onAddClick(); }
    });
  }
}

async function onAddClick(): Promise<void> {
  const toolEl = document.getElementById('permission-allow-add-tool') as HTMLSelectElement | null;
  const patternEl = document.getElementById('permission-allow-add-pattern') as HTMLInputElement | null;
  const errEl = document.getElementById('permission-allow-add-error');
  if (toolEl === null || patternEl === null) return;
  const tool = toolEl.value;
  const pattern = patternEl.value;
  const validation = validatePattern(pattern);
  if (validation !== null) {
    if (errEl !== null) {
      errEl.textContent = `Invalid pattern: ${validation}`;
      errEl.style.display = '';
    }
    return;
  }
  if (errEl !== null) errEl.style.display = 'none';
  const rule: AllowRule = {
    id: newRuleId(),
    tool,
    pattern,
    added_at: new Date().toISOString(),
    added_by: 'settings',
  };
  const rules = await fetchRules();
  const next = [...rules, rule];
  await api('/file-settings', { method: 'PATCH', body: { permission_allow_rules: next } });
  patternEl.value = '';
  renderRules(next);
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
  const root = toElement(
    <div className="permission-popup-always-allow">
      <a className="permission-popup-always-allow-link" href="#">Always allow this</a>
      <div className="permission-popup-always-allow-form" style="display:none">
        <input type="text" className="permission-popup-always-allow-input" value={initial} />
        <button className="btn btn-sm permission-popup-always-allow-confirm" type="button">Save & Allow</button>
        <button className="btn btn-sm permission-popup-always-allow-cancel" type="button">Cancel</button>
      </div>
      <p className="permission-popup-always-allow-error" style="display:none;color:#991b1b;font-size:11px;margin:4px 0 0"></p>
    </div>
  );

  const link = root.querySelector<HTMLAnchorElement>('.permission-popup-always-allow-link')!;
  const form = root.querySelector<HTMLElement>('.permission-popup-always-allow-form')!;
  const input = root.querySelector<HTMLInputElement>('.permission-popup-always-allow-input')!;
  const confirm = root.querySelector<HTMLButtonElement>('.permission-popup-always-allow-confirm')!;
  const cancel = root.querySelector<HTMLButtonElement>('.permission-popup-always-allow-cancel')!;
  const errorEl = root.querySelector<HTMLElement>('.permission-popup-always-allow-error')!;

  link.addEventListener('click', (e) => {
    e.preventDefault();
    link.style.display = 'none';
    form.style.display = '';
    input.focus();
    input.select();
  });
  cancel.addEventListener('click', () => {
    form.style.display = 'none';
    link.style.display = '';
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
      confirm.disabled = false;
      return;
    }
    // Rule saved — invoke the caller's allow-the-current-request handler.
    opts.onCommit();
  }

  return root;
}
