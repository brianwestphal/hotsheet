/**
 * HS-9004 — Settings → Sharing tab. The Xcode-build-settings "Levels" view of
 * the HS-9002 shared/local split (docs/2 §2.3.1): a segmented control switches
 * the whole panel between editing the committed `settings.json` (Shared),
 * editing the gitignored `settings.local.json` (Local overrides), and a
 * read-only merged view (Resolved) tagged by origin.
 *
 * Pure row logic lives in `settingsSharing.ts`. This module builds the panel as
 * one SafeHtml tree, converts it with `toElement`, then wires listeners via the
 * `data-*` hooks (the codebase convention — no inline DOM nodes / listeners).
 */
import {
  clearLocalSettingOverride,
  getLayeredFileSettings,
  type LayeredFileSettings,
  updateFileSettingsLayer,
} from '../api/index.js';
import type { SafeHtml } from '../jsx-runtime.js';
import { confirmDialog } from './confirm.js';
import { byIdOrNull, toElement } from './dom.js';
import {
  buildSharingRows,
  type SharingMode,
  type SharingRow,
} from './settingsSharing.js';

let mode: SharingMode = 'resolved';
let layered: LayeredFileSettings | null = null;
let currentRows: SharingRow[] = [];
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Fetch the layered settings and render the tab. Called when the Sharing tab
 *  is first shown (lazy, like the Permissions tab). */
export async function loadAndRenderSharing(): Promise<void> {
  const container = byIdOrNull('settings-sharing-panel');
  if (container === null) return;
  try {
    layered = await getLayeredFileSettings();
  } catch {
    container.replaceChildren(toElement(<p className="settings-hint">Couldn't load settings.</p>));
    return;
  }
  render();
}

function render(): void {
  const container = byIdOrNull('settings-sharing-panel');
  if (container === null || layered === null) return;
  currentRows = buildSharingRows(layered);

  const panel = toElement(
    <div>
      <h3>Sharing</h3>
      <p className="settings-hint">
        Settings live in two files. <strong>Shared</strong> (<code>settings.json</code>) is committed
        to git for your team. <strong>Local</strong> (<code>settings.local.json</code>) stays on this
        machine and overrides the shared value. <strong>Resolved</strong> is the effective result.
      </p>
      <div className="sharing-seg" role="tablist">
        <button className={`sharing-seg-btn sharing-seg-shared${mode === 'shared' ? ' active' : ''}`} data-mode="shared"><span className="sharing-seg-dot" />Shared</button>
        <button className={`sharing-seg-btn sharing-seg-local${mode === 'local' ? ' active' : ''}`} data-mode="local"><span className="sharing-seg-dot" />Local overrides</button>
        <button className={`sharing-seg-btn sharing-seg-resolved${mode === 'resolved' ? ' active' : ''}`} data-mode="resolved"><span className="sharing-seg-dot" />Resolved</button>
      </div>
      {renderScopeNote()}
      <div className="sharing-rows">
        {currentRows.map(renderRow)}
      </div>
    </div>,
  );

  wire(panel);
  container.replaceChildren(panel);
}

function renderScopeNote(): SafeHtml {
  if (mode === 'shared') {
    return <p className="sharing-note sharing-note-shared">Editing <code>settings.json</code> — committed to git, shared with your team.</p>;
  }
  if (mode === 'local') {
    return <p className="sharing-note sharing-note-local">Editing <code>settings.local.json</code> — gitignored, this machine only. Overrides win over the shared value.</p>;
  }
  return <p className="sharing-note sharing-note-resolved">🔒 Effective values in use — read-only. Each row shows where its value came from.</p>;
}

function renderRow(row: SharingRow): SafeHtml {
  return (
    <div className="sharing-row" data-key={row.key}>
      <div className="sharing-row-head">
        <label className="sharing-row-label">{row.label}</label>
        {renderRowTag(row)}
      </div>
      {row.hint !== undefined ? <div className="sharing-row-hint">{row.hint}</div> : ''}
      <div className="sharing-row-body">{renderRowBody(row)}</div>
    </div>
  );
}

/** Right-aligned status tag / action for a row, given the active mode. */
function renderRowTag(row: SharingRow): SafeHtml | string {
  if (mode === 'resolved') {
    const label = row.origin === 'local' ? 'from Local' : row.origin === 'shared' ? 'from Shared' : 'default';
    return <span className={`sharing-tag sharing-tag-${row.origin}`}><span className="sharing-tag-dot" />{label}</span>;
  }
  if (mode === 'shared') {
    return row.overridden
      ? <span className="sharing-tag sharing-tag-local"><span className="sharing-tag-dot" />overridden locally</span>
      : '';
  }
  // local mode
  return row.overridden
    ? <button className="sharing-link" data-action="reset" data-key={row.key}>Reset to shared</button>
    : <button className="sharing-ghostbtn" data-action="override" data-key={row.key}>+ Override</button>;
}

function renderRowBody(row: SharingRow): SafeHtml {
  if (mode === 'resolved') {
    return <div className="sharing-value-ro">{row.resolvedDisplay}</div>;
  }
  if (mode === 'shared') {
    if (row.kind === 'complex' || row.isOther) return <div className="sharing-value-ro">{row.sharedDisplay}</div>;
    return renderEditor(row, 'shared', row.sharedValue);
  }
  // local mode
  if (!row.overridden) {
    return <div className="sharing-value-inherited">{row.resolvedDisplay}<span className="sharing-inherited-note"> · inherited</span></div>;
  }
  if (row.kind === 'complex' || row.isOther) return <div className="sharing-value-ro">{row.localDisplay}</div>;
  return renderEditor(row, 'local', row.localValue);
}

function renderEditor(row: SharingRow, layer: 'shared' | 'local', value: unknown): SafeHtml {
  return (
    <input
      className="sharing-input"
      type={row.kind === 'number' ? 'number' : 'text'}
      data-key={row.key}
      data-layer={layer}
      value={typeof value === 'number' ? String(value) : typeof value === 'string' ? value : ''}
    />
  );
}

/** Wire listeners onto the freshly-built (not-yet-inserted) panel via data hooks. */
function wire(panel: HTMLElement): void {
  panel.querySelectorAll<HTMLButtonElement>('.sharing-seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.mode;
      if (next !== 'shared' && next !== 'local' && next !== 'resolved') return;
      if (next === mode) return;
      mode = next;
      render();
    });
  });
  panel.querySelectorAll<HTMLButtonElement>('[data-action="override"]').forEach(btn => {
    btn.addEventListener('click', () => { void onOverride(btn.dataset.key ?? ''); });
  });
  panel.querySelectorAll<HTMLButtonElement>('[data-action="reset"]').forEach(btn => {
    btn.addEventListener('click', () => { void onReset(btn.dataset.key ?? ''); });
  });
  panel.querySelectorAll<HTMLInputElement>('.sharing-input').forEach(input => {
    input.addEventListener('input', () => {
      const key = input.dataset.key ?? '';
      const layer = input.dataset.layer === 'local' ? 'local' : 'shared';
      const existing = debounceTimers.get(key);
      if (existing) clearTimeout(existing);
      debounceTimers.set(key, setTimeout(() => { void writeValue(key, layer, input.value); }, 400));
    });
  });
}

function findRow(key: string): SharingRow | undefined {
  return currentRows.find(r => r.key === key);
}

/** Coerce the raw input string to the value type the key expects. */
function coerce(row: SharingRow, raw: string): unknown {
  if (row.kind === 'number') {
    const n = Number(raw);
    return raw.trim() === '' || Number.isNaN(n) ? raw : n;
  }
  return raw;
}

async function writeValue(key: string, layer: 'shared' | 'local', raw: string): Promise<void> {
  const row = findRow(key);
  if (row === undefined) return;
  try {
    layered = await updateFileSettingsLayer(layer, { [key]: coerce(row, raw) });
  } catch { /* network popup handled by the api layer */ }
  // Intentionally no re-render — preserve the focused input mid-typing. Tags
  // refresh on the next mode switch / reopen.
}

async function onOverride(key: string): Promise<void> {
  const row = findRow(key);
  if (row === undefined) return;
  try {
    const seed = row.resolvedValue === undefined ? '' : row.resolvedValue;
    layered = await updateFileSettingsLayer('local', { [key]: seed });
    render();
  } catch { /* handled by api layer */ }
}

async function onReset(key: string): Promise<void> {
  const row = findRow(key);
  if (row === undefined) return;
  const ok = await confirmDialog({
    title: 'Reset to shared',
    message: `Remove the local override for "${row.label}"? The shared value will take effect.`,
    confirmLabel: 'Reset',
  });
  if (!ok) return;
  try {
    layered = await clearLocalSettingOverride([key]);
    render();
  } catch { /* handled by api layer */ }
}
