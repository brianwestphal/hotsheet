// @vitest-environment happy-dom
/**
 * HS-8614 — the terminals settings row list moved its per-row edit/delete
 * clicks + drag (`dragstart`/`dragend`/`dragover`/`drop`) off per-element
 * attachment and onto one delegated set on the stable `#settings-terminals-list`
 * container, reading the row index from each row's `data-index`. (The only
 * surviving per-row listener is the stateless WebKit mousedown swallow.) These
 * tests cover the explicitly-called-out reorder + delete flows through the
 * delegated handlers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { destroyTerminal } from '../api/index.js';
import {
  _getTerminalsForTests,
  _resetTerminalsForTests,
  loadAndRenderTerminalsSettings,
} from './terminalsSettings.js';

vi.mock('../api/index.js', () => ({
  getFileSettings: vi.fn(() => Promise.resolve({
    terminals: JSON.stringify([
      { id: 't0', command: 'a', name: 'Zero' },
      { id: 't1', command: 'b', name: 'One' },
      { id: 't2', command: 'c', name: 'Two' },
    ]),
  })),
  updateFileSettings: vi.fn(() => Promise.resolve({})),
  getCommandSuggestions: vi.fn(() => Promise.resolve([])),
  destroyTerminal: vi.fn(() => Promise.resolve({})),
}));
vi.mock('./confirm.js', () => ({ confirmDialog: vi.fn(() => Promise.resolve(true)) }));
vi.mock('./commandLog.js', () => ({ previewDrawerTab: vi.fn(() => () => { /* restore no-op */ }) }));

/** Minimal DragEvent shim — happy-dom's plain Event has no `dataTransfer`, and
 *  the delegated handlers touch `dataTransfer.setData` / `.effectAllowed`. */
function dragEvent(type: string): Event {
  const ev = new Event(type, { bubbles: true });
  Object.defineProperty(ev, 'dataTransfer', {
    value: { setData() { /* noop */ }, getData() { return ''; }, effectAllowed: '', dropEffect: '' },
  });
  return ev;
}

function row(index: number): HTMLElement {
  const el = document.querySelector<HTMLElement>(`#settings-terminals-list .settings-terminal-row[data-index="${index}"]`);
  if (el === null) throw new Error(`no row at index ${index}`);
  return el;
}

describe('terminalsSettings — delegated row handlers (HS-8614)', () => {
  beforeEach(async () => {
    _resetTerminalsForTests();
    document.body.innerHTML = '<div id="settings-terminals-list"></div>';
    await loadAndRenderTerminalsSettings();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    _resetTerminalsForTests();
    vi.clearAllMocks();
  });

  it('renders one row per terminal, each stamped with its data-index', () => {
    const rows = document.querySelectorAll('#settings-terminals-list .settings-terminal-row');
    expect(rows.length).toBe(3);
    expect(_getTerminalsForTests().map(t => t.id)).toEqual(['t0', 't1', 't2']);
  });

  it('a delegated drag-and-drop from row 0 onto row 2 reorders the terminals', () => {
    row(0).dispatchEvent(dragEvent('dragstart'));
    row(2).dispatchEvent(dragEvent('drop'));
    // splice(0,1)=t0 then insert at index 2 → [t1, t2, t0].
    expect(_getTerminalsForTests().map(t => t.id)).toEqual(['t1', 't2', 't0']);
    // The list re-rendered with fresh data-index values.
    expect(row(0).querySelector('.cmd-outline-name')?.textContent).toBe('One');
  });

  it('a no-op drop onto the same row leaves the order unchanged', () => {
    row(1).dispatchEvent(dragEvent('dragstart'));
    row(1).dispatchEvent(dragEvent('drop'));
    expect(_getTerminalsForTests().map(t => t.id)).toEqual(['t0', 't1', 't2']);
  });

  it('a delegated delete click removes the clicked terminal (and stops its PTY)', async () => {
    row(1).querySelector<HTMLButtonElement>('.cmd-outline-delete-btn')!.click();
    // handleDelete dynamically imports commandLog + awaits the (mocked) confirm
    // before stopping the PTY — wait for the whole chain to settle.
    await vi.waitFor(() => { expect(vi.mocked(destroyTerminal)).toHaveBeenCalledWith('t1'); });
    expect(_getTerminalsForTests().map(t => t.id)).toEqual(['t0', 't2']);
  });
});
