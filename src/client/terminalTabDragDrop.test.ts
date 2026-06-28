// @vitest-environment happy-dom
/**
 * HS-9130 — unit coverage for the drawer tab strip drag-and-drop reorder
 * (`terminalTabDragDrop.ts`): the per-tab dragstart/over/leave/end class
 * bookkeeping + the drop → reorder-DOM → persist-configured-subset flow. The
 * pure order math lives in `terminalTabReorder.ts` (its own tests); here we pin
 * the event wiring + the persistence shape. `updateFileSettings` is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TerminalTabConfig } from './terminal.js';
import { attachTabDragHandlers, initTabDragDrop,type LastKnownConfigs } from './terminalTabDragDrop.js';

const updateFileSettingsMock = vi.fn<(body: unknown) => Promise<unknown>>();
vi.mock('../api/index.js', () => ({ updateFileSettings: (body: unknown) => updateFileSettingsMock(body) }));

/** A drag event with a minimal `dataTransfer` (happy-dom's plain Event lacks it). */
function dragEvent(type: string): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', {
    value: { effectAllowed: '', dropEffect: '', setData() { /* noop */ }, getData() { return ''; } },
  });
  return ev;
}

let lastKnown: LastKnownConfigs;
const cfg = (id: string): TerminalTabConfig => ({ id, command: `cmd-${id}`, dynamic: false });

function buildStrip(ids: string[]): void {
  const tabs = ids.map(id => `<div class="drawer-terminal-tab" data-terminal-id="${id}"></div>`).join('');
  const panes = ids.map(id => `<div class="drawer-terminal-pane" data-drawer-panel="terminal:${id}"></div>`).join('');
  document.body.innerHTML = `<div id="drawer-terminal-tabs">${tabs}</div><div id="drawer-terminal-panes">${panes}</div>`;
  for (const id of ids) {
    const el = document.querySelector<HTMLElement>(`.drawer-terminal-tab[data-terminal-id="${id}"]`)!;
    attachTabDragHandlers(el, id);
  }
}

function tab(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(`.drawer-terminal-tab[data-terminal-id="${id}"]`)!;
}
function stripOrder(): string[] {
  return [...document.querySelectorAll<HTMLElement>('#drawer-terminal-tabs .drawer-terminal-tab')].map(el => el.dataset.terminalId!);
}

beforeEach(() => {
  updateFileSettingsMock.mockReset().mockResolvedValue({});
  lastKnown = { configured: [cfg('a'), cfg('b'), cfg('c')], dynamic: [] };
  initTabDragDrop({
    getLastKnownConfigs: () => lastKnown,
    setLastKnownConfigs: (next) => { lastKnown = next; },
  });
  buildStrip(['a', 'b', 'c']);
});
afterEach(() => { document.body.innerHTML = ''; });

describe('drag class bookkeeping', () => {
  it('dragstart marks the tab; dragend clears it + any drag-over', () => {
    tab('a').dispatchEvent(dragEvent('dragstart'));
    expect(tab('a').classList.contains('dragging')).toBe(true);
    tab('c').classList.add('drag-over'); // simulate a leftover
    tab('a').dispatchEvent(dragEvent('dragend'));
    expect(tab('a').classList.contains('dragging')).toBe(false);
    expect(tab('c').classList.contains('drag-over')).toBe(false);
  });

  it('dragover a DIFFERENT tab adds drag-over; dragleave removes it', () => {
    tab('a').dispatchEvent(dragEvent('dragstart'));
    tab('b').dispatchEvent(dragEvent('dragover'));
    expect(tab('b').classList.contains('drag-over')).toBe(true);
    tab('b').dispatchEvent(dragEvent('dragleave'));
    expect(tab('b').classList.contains('drag-over')).toBe(false);
  });

  it('dragover the SAME tab does not mark drag-over', () => {
    tab('a').dispatchEvent(dragEvent('dragstart'));
    tab('a').dispatchEvent(dragEvent('dragover'));
    expect(tab('a').classList.contains('drag-over')).toBe(false);
  });
});

describe('drop → reorder + persist', () => {
  it('reorders the DOM and persists the configured subset in the new order', async () => {
    tab('a').dispatchEvent(dragEvent('dragstart'));
    tab('c').dispatchEvent(dragEvent('drop')); // move a after c → b,c,a
    await vi.waitFor(() => expect(updateFileSettingsMock).toHaveBeenCalledTimes(1));

    expect(stripOrder()).toEqual(['b', 'c', 'a']);
    const body = updateFileSettingsMock.mock.calls[0][0] as { terminals: { id: string }[] };
    expect(body.terminals.map(t => t.id)).toEqual(['b', 'c', 'a']);
    // Cache updated to the new order too.
    expect(lastKnown.configured.map(c => c.id)).toEqual(['b', 'c', 'a']);
  });

  it('a drop onto the same tab is a no-op (no persist)', async () => {
    tab('a').dispatchEvent(dragEvent('dragstart'));
    tab('a').dispatchEvent(dragEvent('drop'));
    await new Promise(r => setTimeout(r, 10));
    expect(updateFileSettingsMock).not.toHaveBeenCalled();
    expect(stripOrder()).toEqual(['a', 'b', 'c']);
  });

  it('swallows a persist rejection (DOM + cache order already moved)', async () => {
    updateFileSettingsMock.mockRejectedValue(new Error('patch failed'));
    tab('a').dispatchEvent(dragEvent('dragstart'));
    tab('c').dispatchEvent(dragEvent('drop'));
    await vi.waitFor(() => expect(updateFileSettingsMock).toHaveBeenCalled());
    expect(stripOrder()).toEqual(['b', 'c', 'a']);
  });
});
