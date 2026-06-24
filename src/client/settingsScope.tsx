/**
 * HS-9004 — dialog-wide Shared | Local overrides | Resolved scope control.
 *
 * A persistent toolbar under the Settings tab strip switches the whole dialog
 * between three views of the HS-9002 shared/local split (docs/2 §2.3.1):
 *
 *   - `resolved` (default) — the effective values, edited exactly as before
 *     (writes route to each key's default layer). Each field is tagged with
 *     where its value comes from.
 *   - `shared` — edit the committed `settings.json`. A field shows the literal
 *     shared value (even when locally overridden) + an "overridden locally" tag.
 *   - `local` — edit the gitignored `settings.local.json`. Overridden fields are
 *     editable with "Reset to shared"; inherited fields show the inherited value
 *     read-only behind a "+ Override" affordance.
 *
 * Settings stay in their own tabs. File-settings fields decorate in place via a
 * declared registry (keyed by control id). Fields that can't participate are
 * handled two ways: machine-global settings already carry a "Global Setting"
 * badge and are left alone; project-level surfaces that aren't file-settings
 * (plugin toggles, complex list editors) are containers tagged
 * `data-scope-complex` and become read-only in Shared/Local with a short note.
 *
 * Pure layer logic lives in `settingsSharing.ts`; this module does the DOM.
 */
import {
  clearLocalSettingOverride,
  getLayeredFileSettings,
  type LayeredFileSettings,
  updateFileSettingsLayer,
} from '../api/index.js';
import { confirmDialog } from './confirm.js';
import { byIdOrNull, toElement } from './dom.js';
import {
  resolveFieldScope,
  type ScopeMode,
  type SettingKind,
} from './settingsSharing.js';

/** A scalar file-settings field that participates in the scope control.
 *  `controlId` is the form control's element id; `key` is its settings.json key. */
interface ScopedField {
  controlId: string;
  key: string;
  kind: Exclude<SettingKind, 'complex'>;
  /**
   * HS-9009 (docs/95 §95.4) — sharing constraint:
   *  - `shared-only`: editable in Shared + Resolved, read-only in Local (no
   *    "+ Override" — a hard team value, e.g. appName / ticketPrefix).
   *  - `local-only`: editable in Local + Resolved, read-only in Shared (never
   *    committed, e.g. the Announcer enable toggle).
   *  - undefined (default): the standard scoped field — editable everywhere,
   *    "+ Override" in Local when inherited.
   */
  share?: 'shared-only' | 'local-only';
}

/**
 * The scalar file-settings fields whose write listeners live in
 * `settingsDialog.tsx` (so their writes route through `persistScopedSetting`).
 * Complex list editors (categories, terminals, allow-rules, …) live in their
 * own modules and are locked via `data-scope-complex` instead — see HS-9005 for
 * per-layer (element-level) editing of those.
 *
 * STANDING RULE (docs/95 §95.6): the shared-vs-local classification of a setting
 * is a product decision — personal preference vs team policy vs machine value.
 * When you add a new setting (especially a complex/list editor) or hit an unclear
 * case, do NOT guess — ask the maintainer how it should be shared. The current
 * classification + per-editor rules live in docs/95-settings-sharing-classification.md;
 * the default layer per key is `defaultScope` in `src/file-settings.ts`.
 */
const SCOPED_FIELDS: ScopedField[] = [
  // General — appName + ticketPrefix are shared-only (hard team values, docs/95 §95.4).
  { controlId: 'settings-app-name', key: 'appName', kind: 'text', share: 'shared-only' },
  { controlId: 'settings-ticket-prefix', key: 'ticketPrefix', kind: 'text', share: 'shared-only' },
  { controlId: 'settings-worklist-preamble', key: 'worklist_preamble', kind: 'text' },
  { controlId: 'settings-trash-days', key: 'trash_cleanup_days', kind: 'number' },
  { controlId: 'settings-verified-days', key: 'verified_cleanup_days', kind: 'number' },
  { controlId: 'settings-auto-order', key: 'auto_order', kind: 'boolean' },
  { controlId: 'settings-hide-verified-column', key: 'hide_verified_column', kind: 'boolean' },
  { controlId: 'settings-notify-permission', key: 'notify_permission', kind: 'text' },
  { controlId: 'settings-notify-completed', key: 'notify_completed', kind: 'text' },
  // Backups
  { controlId: 'settings-backup-dir', key: 'backupDir', kind: 'text' },
  // Telemetry
  { controlId: 'settings-telemetry-enabled', key: 'telemetry_enabled', kind: 'boolean' },
  { controlId: 'settings-telemetry-metrics-enabled', key: 'telemetry_metrics_enabled', kind: 'boolean' },
  { controlId: 'settings-telemetry-logs-enabled', key: 'telemetry_logs_enabled', kind: 'boolean' },
  { controlId: 'settings-telemetry-traces-enabled', key: 'telemetry_traces_enabled', kind: 'boolean' },
  { controlId: 'settings-telemetry-retention-days', key: 'telemetry_retention_days', kind: 'number' },
  // Terminal
  { controlId: 'settings-terminal-scrollback', key: 'terminal_scrollback_bytes', kind: 'number' },
  { controlId: 'settings-shell-integration-ui', key: 'shell_integration_ui', kind: 'boolean' },
  // Experimental
  { controlId: 'settings-shell-streaming-enabled', key: 'shell_streaming_enabled', kind: 'boolean' },
  // Announcer (per-project file setting; the model/rate/etc. are machine-global
  // and write to ~/.hotsheet/config.json, so they're layer-safe and stay plain).
  // local-only: the Announcer is never shared (docs/95 §95.4).
  { controlId: 'settings-announcer-enabled', key: 'announcer_enabled', kind: 'boolean', share: 'local-only' },
];

let mode: ScopeMode = 'resolved';
let layered: LayeredFileSettings | null = null;
let initialized = false;

/** A control element that carries a scalar value (input / select / textarea). */
type ValueControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function controlFor(field: ScopedField): ValueControl | null {
  return byIdOrNull<ValueControl>(field.controlId);
}

function hostFor(control: ValueControl): HTMLElement | null {
  return control.closest<HTMLElement>('.settings-field');
}

/** Push a layer value into a control (checkbox → checked, else → value text). */
function applyValueToControl(control: ValueControl, kind: ScopedField['kind'], value: unknown): void {
  if (kind === 'boolean' && control instanceof HTMLInputElement) {
    control.checked = value === true || value === 'true';
    return;
  }
  control.value = typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '';
}

/**
 * Wire the toolbar segment buttons once. Idempotent — `bindSettingsDialog`
 * calls it during the single dialog bind.
 */
export function initSettingsScope(): void {
  if (initialized) return;
  initialized = true;
  const bar = byIdOrNull('settings-scope-bar');
  if (bar === null) return;
  bar.querySelectorAll<HTMLButtonElement>('.scope-seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.scopeMode;
      if (next !== 'shared' && next !== 'local' && next !== 'resolved') return;
      if (next === mode) return;
      mode = next;
      applyScope();
    });
  });
}

/** Reset to the default (resolved) view — called when the dialog opens. */
export function resetScopeMode(): void {
  mode = 'resolved';
}

/** Fetch the layered settings, then decorate every field for the current mode. */
export async function loadAndApplyScope(): Promise<void> {
  try {
    layered = await getLayeredFileSettings();
  } catch {
    layered = null;
  }
  applyScope();
}

/**
 * Write a scoped scalar setting. In `resolved` mode the field's own
 * default-routed `fallback` runs (preserving today's behavior + side-effects);
 * in `shared`/`local` mode the value is written to that explicit layer.
 * Refreshes the cached layers + badges (without clobbering the focused input).
 * Returns `true` on success, `false` on failure, so callers that need to revert
 * an optimistic control (e.g. the Announcer toggle) can react.
 */
export async function persistScopedSetting(
  key: string,
  layerValue: unknown,
  fallback: () => Promise<unknown>,
): Promise<boolean> {
  try {
    if (mode === 'resolved') {
      await fallback();
      layered = await getLayeredFileSettings();
    } else {
      layered = await updateFileSettingsLayer(mode, { [key]: layerValue });
    }
  } catch {
    return false; // network popup handled by the api layer
  }
  applyScope({ skipValues: true });
  return true;
}

/** Decorate all registered fields + lock complex panels for the current mode. */
export function applyScope(opts: { skipValues?: boolean } = {}): void {
  updateToolbar();
  lockComplexPanels();
  for (const field of SCOPED_FIELDS) {
    decorateField(field, opts.skipValues ?? false);
  }
}

function updateToolbar(): void {
  const bar = byIdOrNull('settings-scope-bar');
  if (bar === null) return;
  bar.dataset.scopeMode = mode;
  bar.querySelectorAll<HTMLButtonElement>('.scope-seg-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.scopeMode === mode);
  });
  const note = byIdOrNull('settings-scope-note');
  if (note !== null) note.textContent = SCOPE_NOTE[mode];
}

const SCOPE_NOTE: Record<ScopeMode, string> = {
  resolved: 'Effective values in use. Each field is tagged with where its value comes from.',
  shared: 'Editing settings.json — committed to git, shared with your team.',
  local: 'Editing settings.local.json — gitignored, this machine only. Local values win.',
};

/**
 * Project-level surfaces that aren't file-settings (plugin toggles, complex
 * list editors): read-only in shared/local. The lock is a pure CSS class +
 * `::before` banner so it survives lazy panels replacing their own children
 * (Permissions / Plugins render content on first show).
 */
function lockComplexPanels(): void {
  document.querySelectorAll<HTMLElement>('[data-scope-complex]').forEach(panel => {
    // HS-9009 — `data-scope-complex` variants: '' (default) locks outside
    // Resolved; 'shared-only' locks only in Local; 'local-only' locks only in
    // Shared. The chip text is driven by the matching CSS class.
    const variant = panel.getAttribute('data-scope-complex') ?? '';
    const locked = variant === 'shared-only' ? mode === 'local'
      : variant === 'local-only' ? mode === 'shared'
        : mode !== 'resolved';
    panel.classList.toggle('scope-locked', locked);
    panel.classList.toggle('scope-locked-shared-only', locked && variant === 'shared-only');
    panel.classList.toggle('scope-locked-local-only', locked && variant === 'local-only');
  });
}

function decorateField(field: ScopedField, skipValues: boolean): void {
  const control = controlFor(field);
  if (control === null) return;
  const host = hostFor(control);
  if (host === null) return;
  host.classList.add('scope-host');

  // No layered data (fetch failed): leave the field untouched + enabled.
  if (layered === null) {
    control.disabled = false;
    removeAffordance(host);
    return;
  }

  const scope = resolveFieldScope(layered, field.key);

  // Editability (HS-9009):
  //  - shared-only: read-only in Local (can't override a hard team value).
  //  - local-only: read-only in Shared (never committed).
  //  - default: inherited Local fields are read-only until "+ Override".
  control.disabled = field.share === 'shared-only' ? mode === 'local'
    : field.share === 'local-only' ? mode === 'shared'
      : mode === 'local' && !scope.overridden;

  // Value, per mode:
  //  - shared: the literal settings.json value (blank when absent — truthful;
  //    this is the bug-fix path: show the shared value even when overridden).
  //    A local-only field has no shared value, so show its effective value
  //    read-only instead of blank.
  //  - local + overridden: the local value.
  //  - local + inherited / resolved: the resolved (effective) value — but when
  //    that key isn't in EITHER file (a pure runtime default like the cleanup
  //    days on a fresh project), leave the field's own populated default rather
  //    than blanking it.
  if (!skipValues) {
    if (mode === 'shared') {
      applyValueToControl(control, field.kind, field.share === 'local-only' ? scope.resolvedValue : scope.sharedValue);
    } else if (mode === 'local' && scope.overridden) {
      applyValueToControl(control, field.kind, scope.localValue);
    } else if (scope.resolvedValue !== undefined) {
      applyValueToControl(control, field.kind, scope.resolvedValue);
    }
  }

  renderAffordance(host, field, scope);
}

function removeAffordance(host: HTMLElement): void {
  host.querySelector(':scope > .scope-affordance')?.remove();
}

function renderAffordance(host: HTMLElement, field: ScopedField, scope: ReturnType<typeof resolveFieldScope>): void {
  removeAffordance(host);
  let content: HTMLElement | null = null;

  if (mode === 'resolved') {
    const label = scope.origin === 'local' ? 'from Local' : scope.origin === 'shared' ? 'from Shared' : 'default';
    content = toElement(<span className={`scope-tag scope-tag-${scope.origin}`}><span className="scope-tag-dot" />{label}</span>);
  } else if (field.share === 'shared-only') {
    // Editable in Shared (it IS the shared value); read-only "shared only" in Local.
    if (mode === 'local') content = toElement(<span className="scope-tag scope-tag-shared"><span className="scope-tag-dot" />shared only</span>);
  } else if (field.share === 'local-only') {
    // Editable in Local (its home); read-only "local only" in Shared.
    if (mode === 'shared') content = toElement(<span className="scope-tag scope-tag-local"><span className="scope-tag-dot" />local only</span>);
  } else if (mode === 'shared') {
    if (scope.overridden) {
      content = toElement(<span className="scope-tag scope-tag-local"><span className="scope-tag-dot" />overridden locally</span>);
    }
  } else {
    // local mode, standard scoped field
    content = scope.overridden
      ? toElement(<button type="button" className="scope-link" data-scope-action="reset">Reset to shared</button>)
      : toElement(<button type="button" className="scope-ghostbtn" data-scope-action="override">+ Override</button>);
  }

  if (content === null) return;
  const slot = toElement(<div className="scope-affordance" />);
  slot.appendChild(content);
  if (content.dataset.scopeAction === 'override') {
    content.addEventListener('click', () => { void onOverride(field); });
  } else if (content.dataset.scopeAction === 'reset') {
    content.addEventListener('click', () => { void onReset(field); });
  }
  host.appendChild(slot);
}

async function onOverride(field: ScopedField): Promise<void> {
  if (layered === null) return;
  const scope = resolveFieldScope(layered, field.key);
  const seed = scope.resolvedValue === undefined ? '' : scope.resolvedValue;
  try {
    layered = await updateFileSettingsLayer('local', { [field.key]: seed });
  } catch {
    return;
  }
  applyScope();
  // Focus the freshly-enabled control so the user can type immediately.
  controlFor(field)?.focus();
}

async function onReset(field: ScopedField): Promise<void> {
  const label = labelFor(field);
  const ok = await confirmDialog({
    title: 'Reset to shared',
    message: `Remove the local override for "${label}"? The shared value will take effect.`,
    confirmLabel: 'Reset',
  });
  if (!ok) return;
  try {
    layered = await clearLocalSettingOverride([field.key]);
  } catch {
    return;
  }
  applyScope();
}

/** Best-effort human label from the field's `.settings-field > label`. */
function labelFor(field: ScopedField): string {
  const control = controlFor(field);
  const host = control === null ? null : hostFor(control);
  if (host === null) return field.key;
  const labelEl = host.querySelector('label');
  const text = labelEl === null ? '' : labelEl.textContent.trim();
  return text !== '' ? text : field.key;
}
