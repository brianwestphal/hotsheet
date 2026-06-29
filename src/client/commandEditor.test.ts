// @vitest-environment happy-dom
/**
 * HS-8614 — the custom-command outline list moved its per-row edit/delete
 * clicks, group-name commit, and drag handlers off per-element attachment and
 * onto one delegated set on the stable `#settings-commands-list` container,
 * keyed by each row's `data-ref` (`JSON.stringify(ItemRef)`). These tests
 * confirm a delegated edit/delete acts on the correct command after a rebuild
 * (identity comes from the attribute, not a closure) — the invariant a future
 * `morph()` migration depends on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiIndex from '../api/index.js';
import { _resetCommandRowDelegationForTests, renderCustomCommandSettings } from './commandEditor.js';
import { _setCommandModeForTests, _setCommandOverriddenIdsForTests, _setCommandSharedForTests, getCommandItems, reloadCustomCommands } from './experimentalSettings.js';

const getSettingsMock = vi.hoisted(() => vi.fn<() => Promise<{ custom_commands: string }>>());
vi.mock('../api/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiIndex>()),
  getSettings: () => getSettingsMock(),
  updateSettings: vi.fn(() => Promise.resolve({})),
  // HS-9127 — these tests now render the editable Shared view, whose saves route
  // through `updateFileSettingsLayer` (no client transport in unit tests).
  updateFileSettingsLayer: vi.fn(() => Promise.resolve({ shared: {}, local: {} })),
}));
// `saveCommandItems` re-renders the sidebar — stub it so the test doesn't need
// the channel-sidebar DOM.
vi.mock('./commandSidebar.js', () => ({ renderChannelCommands: vi.fn() }));

function deleteBtnAtRow(index: number): HTMLButtonElement {
  const rows = document.querySelectorAll<HTMLElement>('#settings-commands-list .cmd-outline-row');
  const btn = rows[index].querySelector<HTMLButtonElement>('.cmd-outline-delete-btn');
  if (!btn) throw new Error(`no delete button at row ${index}`);
  return btn;
}

describe('commandEditor — delegated outline row handlers (HS-8614)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="settings-commands-list"></div>';
    getSettingsMock.mockReset();
    _resetCommandRowDelegationForTests();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    _resetCommandRowDelegationForTests();
  });

  async function seed(items: { name: string; prompt: string; target?: 'claude' | 'shell' }[]): Promise<void> {
    getSettingsMock.mockResolvedValue({ custom_commands: JSON.stringify(items) });
    await reloadCustomCommands();
    // HS-9127 — the Resolved view is read-only (no edit/delete/add buttons), so
    // these delegated edit/delete tests run in the editable Shared view.
    _setCommandModeForTests('shared');
    renderCustomCommandSettings();
  }

  it('a delegated edit click opens the editor modal for the clicked row', async () => {
    await seed([
      { name: 'Build', prompt: 'npm run build', target: 'shell' },
      { name: 'Test', prompt: 'npm test', target: 'shell' },
    ]);

    const rows = document.querySelectorAll<HTMLElement>('#settings-commands-list .cmd-outline-row');
    rows[1].querySelector<HTMLButtonElement>('.cmd-outline-edit-btn')!.click();

    const overlay = document.querySelector('.cmd-editor-overlay');
    expect(overlay).not.toBeNull();
    const nameInput = overlay!.querySelector<HTMLInputElement>('.settings-command-row-header input[type="text"]');
    expect(nameInput?.value).toBe('Test');
  });

  it('a delegated delete click removes the clicked command', async () => {
    await seed([
      { name: 'Build', prompt: 'b', target: 'shell' },
      { name: 'Test', prompt: 't', target: 'shell' },
    ]);

    deleteBtnAtRow(0).click();

    const names = getCommandItems().map(i => 'name' in i ? i.name : '(group)');
    expect(names).toEqual(['Test']);
  });

  it('HS-9102: toggling "Safe to run on busy workers" persists workerSafe on a Claude command', async () => {
    await seed([{ name: 'Lint', prompt: 'run the linter', target: 'claude' }]);

    const rows = document.querySelectorAll<HTMLElement>('#settings-commands-list .cmd-outline-row');
    rows[0].querySelector<HTMLButtonElement>('.cmd-outline-edit-btn')!.click();

    const overlay = document.querySelector('.cmd-editor-overlay')!;
    const label = overlay.querySelector<HTMLElement>('.command-worker-safe-label')!;
    const checkbox = overlay.querySelector<HTMLInputElement>('.command-worker-safe')!;
    // Visible for a Claude command, unchecked by default.
    expect(label.style.display).not.toBe('none');
    expect(checkbox.checked).toBe(false);

    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));

    const item = getCommandItems()[0];
    expect('workerSafe' in item && item.workerSafe).toBe(true);
  });

  it('HS-9102: the worker-safe checkbox is hidden for a Shell command', async () => {
    await seed([{ name: 'Build', prompt: 'npm run build', target: 'shell' }]);

    const rows = document.querySelectorAll<HTMLElement>('#settings-commands-list .cmd-outline-row');
    rows[0].querySelector<HTMLButtonElement>('.cmd-outline-edit-btn')!.click();

    const overlay = document.querySelector('.cmd-editor-overlay')!;
    const label = overlay.querySelector<HTMLElement>('.command-worker-safe-label')!;
    expect(label.style.display).toBe('none');

    // Switching the target to Claude reveals it.
    overlay.querySelector<HTMLButtonElement>('.seg-btn[data-target="claude"]')!.click();
    expect(label.style.display).not.toBe('none');
  });

  it('REBUILD INVARIANT: deleting "row 0" twice removes the right items in order', async () => {
    await seed([
      { name: 'A', prompt: 'a', target: 'shell' },
      { name: 'B', prompt: 'b', target: 'shell' },
      { name: 'C', prompt: 'c', target: 'shell' },
    ]);

    // First delete → [B, C], list re-renders with B at row 0.
    deleteBtnAtRow(0).click();
    expect(getCommandItems().map(i => 'name' in i ? i.name : '?')).toEqual(['B', 'C']);

    // Second delete of the (rebuilt) row 0 → removes B (read from its fresh
    // data-ref), not a stale ref. Leaves [C].
    deleteBtnAtRow(0).click();
    expect(getCommandItems().map(i => 'name' in i ? i.name : '?')).toEqual(['C']);
  });

  // HS-9184 — a locally-overridden shared command offers an undo-2 "reset to
  // shared" button in Local mode; a non-overridden command doesn't, and the
  // button never appears in Shared mode (nothing to reset there).
  it('HS-9184: shows a reset-to-shared button only for an overridden shared command in Local mode', async () => {
    getSettingsMock.mockResolvedValue({ custom_commands: JSON.stringify([
      { id: 'c1', name: 'Build', prompt: 'npm run build', target: 'shell' },
      { id: 'c2', name: 'Test', prompt: 'npm test', target: 'shell' },
    ]) });
    await reloadCustomCommands();
    _setCommandModeForTests('local');
    _setCommandOverriddenIdsForTests(new Set(['c2'])); // "Test" is overridden locally
    renderCustomCommandSettings();

    const rows = document.querySelectorAll<HTMLElement>('#settings-commands-list .cmd-outline-row');
    expect(rows[0].querySelector('.cmd-reset-btn')).toBeNull();     // Build — not overridden
    expect(rows[1].querySelector('.cmd-reset-btn')).not.toBeNull(); // Test — overridden → reset

    // Shared mode: nothing is "overridden", so no reset buttons at all.
    _setCommandModeForTests('shared');
    _setCommandOverriddenIdsForTests(new Set());
    renderCustomCommandSettings();
    expect(document.querySelectorAll('#settings-commands-list .cmd-reset-btn').length).toBe(0);
  });

  // HS-9183 — a shared command hidden on this machine renders as a dimmed row
  // with a restore button (instead of vanishing), in Local mode.
  it('HS-9183: shows hidden shared commands as dimmed rows with a restore (eye) button', async () => {
    // editTree shows only the visible command; the shared baseline has both;
    // `c2` is hidden on this machine.
    getSettingsMock.mockResolvedValue({ custom_commands: JSON.stringify([
      { id: 'c1', name: 'Build', prompt: 'npm run build', target: 'shell' },
    ]) });
    await reloadCustomCommands();
    // The shared baseline has BOTH; the editor tree (resolved) shows only c1 →
    // c2 is "absent from the editor in Local mode" = hidden on this machine.
    _setCommandSharedForTests([
      { id: 'c1', name: 'Build', prompt: 'npm run build' },
      { id: 'c2', name: 'Hidden One', prompt: 'echo hi' },
    ]);
    _setCommandModeForTests('local');
    renderCustomCommandSettings();

    const hiddenRows = document.querySelectorAll<HTMLElement>('#settings-commands-list .cmd-outline-row-hidden');
    expect(hiddenRows.length).toBe(1);
    expect(hiddenRows[0].textContent).toContain('Hidden One');
    expect(hiddenRows[0].querySelector('.cmd-reenable-btn')).not.toBeNull();
    expect(hiddenRows[0].getAttribute('data-cmd-id')).toBe('c2');
    // The visible command (c1) is a normal (non-hidden) row.
    const visible = document.querySelectorAll('#settings-commands-list .cmd-outline-row:not(.cmd-outline-row-hidden):not(.cmd-outline-group-row)');
    expect(visible.length).toBe(1);

    // Shared mode: hidden-on-this-machine doesn't apply → no hidden rows.
    _setCommandModeForTests('shared');
    renderCustomCommandSettings();
    expect(document.querySelectorAll('#settings-commands-list .cmd-outline-row-hidden').length).toBe(0);
  });
});
