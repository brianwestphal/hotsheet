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
import { _setCommandModeForTests, _setCommandOverriddenIdsForTests, _setCommandSharedForTests, type CommandItem, getCommandItems, reloadCustomCommands, setCommandCopySelection } from './experimentalSettings.js';
import type * as SettingsClipboard from './settingsClipboard.js';
import { copyJsonToClipboard } from './settingsClipboard.js';
import { emptySelection } from './settingsCopySelection.js';

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
vi.mock('./toast.js', () => ({ showToast: vi.fn() }));
// HS-9324 — spy the clipboard copy so the copy-selection tests can assert exactly
// which top-level items get serialized (real helpers otherwise, e.g. paste).
vi.mock('./settingsClipboard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof SettingsClipboard>()),
  copyJsonToClipboard: vi.fn(() => Promise.resolve()),
}));

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

  // HS-9220 — editing a shared command locally must IMMEDIATELY flip its row to
  // the "overridden" tag + reset-to-shared button (no scope-switch reload needed).
  // Pre-fix `commandOverriddenIds` was refreshed only by `loadScopedCommands`, so
  // the row kept its stale "shared" tag with no reset affordance until the user
  // toggled views and back.
  it('HS-9220: a local edit immediately marks the command "overridden" (tag + reset button)', async () => {
    getSettingsMock.mockResolvedValue({ custom_commands: JSON.stringify([
      { id: 'c1', name: 'Build', prompt: 'npm run build', target: 'shell' },
    ]) });
    await reloadCustomCommands();
    _setCommandSharedForTests([{ id: 'c1', name: 'Build', prompt: 'npm run build', target: 'shell' }]);
    _setCommandModeForTests('local');
    _setCommandOverriddenIdsForTests(new Set()); // pristine: nothing overridden yet
    renderCustomCommandSettings();

    // Pristine shared command → "shared" tag, no reset button.
    let row = document.querySelector<HTMLElement>('#settings-commands-list .cmd-outline-row')!;
    expect(row.querySelector('.cmd-scope-tag')!.textContent).toContain('shared');
    expect(row.querySelector('.cmd-reset-btn')).toBeNull();

    // Edit the prompt locally through the editor modal, then close it.
    row.querySelector<HTMLButtonElement>('.cmd-outline-edit-btn')!.click();
    const overlay = document.querySelector('.cmd-editor-overlay')!;
    const promptArea = overlay.querySelector<HTMLTextAreaElement>('textarea')!;
    promptArea.value = 'npm run build -- --prod';
    promptArea.dispatchEvent(new Event('input'));
    overlay.querySelector<HTMLButtonElement>('.cmd-editor-done-btn')!.click();

    // The row now reads "overridden" (local-styled) and shows the reset button —
    // without any scope switch.
    row = document.querySelector<HTMLElement>('#settings-commands-list .cmd-outline-row')!;
    expect(row.querySelector('.cmd-scope-tag')!.textContent).toContain('overridden');
    expect(row.querySelector('.cmd-scope-tag.scope-tag-local')).not.toBeNull();
    expect(row.querySelector('.cmd-scope-tag.scope-tag-shared')).toBeNull();
    expect(row.querySelector('.cmd-reset-btn')).not.toBeNull();
  });

  // HS-9181 — a command shown in the Shared editor is tagged "shared" immediately,
  // even a just-added one not yet folded into the shared baseline (pre-fix it
  // flashed a "local" tag until the dialog was reopened).
  it('HS-9181: Shared mode tags every command "shared" (incl. a just-added one)', async () => {
    await seed([{ name: 'Build', prompt: 'npm run build', target: 'shell' }]);
    // `seed` renders in Shared mode but the seeded item is NOT in `commandShared`
    // (empty here) — simulating the just-added lag. The tag must still read shared.
    _setCommandSharedForTests([]); // baseline empty → would have flashed "local" pre-fix
    renderCustomCommandSettings();
    const row = document.querySelector<HTMLElement>('#settings-commands-list .cmd-outline-row');
    expect(row?.querySelector('.cmd-scope-tag.scope-tag-shared')).not.toBeNull();
    expect(row?.querySelector('.cmd-scope-tag.scope-tag-local')).toBeNull();
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

describe('commandEditor — copy-selection (HS-9324)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="settings-commands-list"></div>';
    getSettingsMock.mockReset();
    _resetCommandRowDelegationForTests();
    setCommandCopySelection(emptySelection());
    vi.mocked(copyJsonToClipboard).mockClear();
  });
  afterEach(() => {
    document.body.innerHTML = '';
    _resetCommandRowDelegationForTests();
    setCommandCopySelection(emptySelection());
  });

  async function seedIds(items: CommandItem[]): Promise<void> {
    getSettingsMock.mockResolvedValue({ custom_commands: JSON.stringify(items) });
    await reloadCustomCommands();
    _setCommandModeForTests('shared');
    renderCustomCommandSettings();
  }

  const topRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('#settings-commands-list .cmd-outline-row[data-cmd-id]:not([data-parent-group-id])')];
  const childRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('#settings-commands-list .cmd-outline-row[data-parent-group-id]')];
  const copyBtn = (): HTMLElement => document.querySelector<HTMLElement>('.cmd-outline-copy-btn')!;
  // Click a non-interactive part of the row: the name span for command rows, or
  // the row itself for a group (whose name is contentEditable → intentionally not
  // a select target). Either way the target isn't a button/editable/drag-handle.
  const clickName = (row: HTMLElement, mods: MouseEventInit = {}): void => {
    const target = row.querySelector('.cmd-outline-name') ?? row;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, ...mods }));
  };

  it('clicking a top-level row selects it and flips Copy to "Copy Selected"; re-click clears', async () => {
    await seedIds([
      { id: 'c1', name: 'Build', prompt: 'b', target: 'shell' },
      { id: 'c2', name: 'Test', prompt: 't', target: 'shell' },
    ]);
    const rows = topRows();
    expect(rows.length).toBe(2);
    expect(copyBtn().textContent).toBe('Copy All');

    clickName(rows[0]);
    expect(rows[0].classList.contains('selected')).toBe(true);
    expect(rows[1].classList.contains('selected')).toBe(false);
    expect(copyBtn().textContent).toBe('Copy Selected');

    clickName(rows[0]); // sole selected → clears
    expect(rows[0].classList.contains('selected')).toBe(false);
    expect(copyBtn().textContent).toBe('Copy All');
  });

  it('Cmd-click multi-selects; clicking a row button does NOT select', async () => {
    await seedIds([
      { id: 'c1', name: 'Build', prompt: 'b', target: 'shell' },
      { id: 'c2', name: 'Test', prompt: 't', target: 'shell' },
    ]);
    const rows = topRows();
    clickName(rows[0]);
    clickName(rows[1], { metaKey: true });
    expect(rows[0].classList.contains('selected')).toBe(true);
    expect(rows[1].classList.contains('selected')).toBe(true);

    // Clicking the edit button must not toggle the selection.
    rows[0].querySelector<HTMLButtonElement>('.cmd-outline-edit-btn')!.click();
    expect(rows[0].classList.contains('selected')).toBe(true);
    expect(rows[1].classList.contains('selected')).toBe(true);
  });

  it('Copy copies only the selected top-level items — a selected group copies whole', async () => {
    await seedIds([
      { id: 'c1', name: 'Build', prompt: 'b', target: 'shell' },
      { id: 'g1', type: 'group', name: 'Group', children: [{ id: 'gc1', name: 'Child', prompt: 'x', target: 'shell' }] },
      { id: 'c2', name: 'Test', prompt: 't', target: 'shell' },
    ]);
    const rows = topRows();
    expect(rows.length).toBe(3); // Build, Group, Test — the group's child row has no data-cmd-id

    clickName(rows[1]); // Group
    clickName(rows[2], { metaKey: true }); // Test
    copyBtn().click();

    const call = vi.mocked(copyJsonToClipboard).mock.calls.at(-1);
    const copied = call?.[0] as CommandItem[];
    expect(copied.map(i => i.name)).toEqual(['Group', 'Test']); // render order; Build excluded
    const grp = copied.find(i => i.name === 'Group');
    expect(grp !== undefined && 'children' in grp && grp.children.length).toBe(1); // group carried its child
  });

  it('Copy with nothing selected copies the whole tree (default)', async () => {
    await seedIds([
      { id: 'c1', name: 'Build', prompt: 'b', target: 'shell' },
      { id: 'c2', name: 'Test', prompt: 't', target: 'shell' },
    ]);
    copyBtn().click();
    const copied = vi.mocked(copyJsonToClipboard).mock.calls.at(-1)?.[0] as CommandItem[];
    expect(copied.map(i => i.name)).toEqual(['Build', 'Test']);
  });

  // HS-9324 (maintainer refinement) — children are individually selectable; a
  // selected group is ATOMIC (implies + locks all its children).
  const withGroup = (): CommandItem[] => [
    { id: 'g1', type: 'group', name: 'Group', children: [
      { id: 'gc1', name: 'Child A', prompt: 'a', target: 'shell' },
      { id: 'gc2', name: 'Child B', prompt: 'b', target: 'shell' },
      { id: 'gc3', name: 'Child C', prompt: 'c', target: 'shell' },
    ] },
    { id: 'c1', name: 'Top', prompt: 't', target: 'shell' },
  ];

  it('a lone child is selectable on its own; Copy wraps it back in its group', async () => {
    await seedIds(withGroup());
    const kids = childRows();
    expect(kids.length).toBe(3);
    clickName(kids[0]); // Child A
    expect(kids[0].classList.contains('selected')).toBe(true);
    expect(topRows()[0].classList.contains('selected')).toBe(false); // the group is NOT selected
    expect(copyBtn().textContent).toBe('Copy Selected');

    copyBtn().click();
    const copied = vi.mocked(copyJsonToClipboard).mock.calls.at(-1)?.[0] as CommandItem[];
    expect(copied.length).toBe(1);
    const grp = copied[0];
    expect(grp.name).toBe('Group');
    expect('children' in grp && grp.children.map(c => c.name)).toEqual(['Child A']); // wrapped, only the selected child
  });

  it('selecting a group selects + LOCKS all its children (atomic — a child click is a no-op)', async () => {
    await seedIds(withGroup());
    const group = topRows()[0];
    clickName(group); // select the whole group
    const kids = childRows();
    for (const k of kids) {
      expect(k.classList.contains('selected')).toBe(true);
      expect(k.classList.contains('selection-locked')).toBe(true);
    }
    // Clicking a locked child must NOT opt it out — the group stays selected + whole.
    clickName(kids[1]);
    expect(group.classList.contains('selected')).toBe(true);
    expect(kids[1].classList.contains('selected')).toBe(true);

    copyBtn().click();
    const copied = vi.mocked(copyJsonToClipboard).mock.calls.at(-1)?.[0] as CommandItem[];
    expect(copied.length).toBe(1);
    expect('children' in copied[0] && copied[0].children.length).toBe(3); // whole group
  });

  it('Copy of a partial-child selection carries only the selected children', async () => {
    await seedIds(withGroup());
    const kids = childRows();
    clickName(kids[0]);                       // Child A
    clickName(kids[2], { metaKey: true });    // + Child C
    copyBtn().click();
    const copied = vi.mocked(copyJsonToClipboard).mock.calls.at(-1)?.[0] as CommandItem[];
    expect(copied.length).toBe(1);
    expect('children' in copied[0] && copied[0].children.map(c => c.name)).toEqual(['Child A', 'Child C']);
  });
});
