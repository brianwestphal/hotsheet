// @vitest-environment happy-dom
/**
 * HS-9277 — the shared transient-rename store + `tileLabel` consulting it, so a
 * terminal renamed in the drawer shows the new name on its dashboard tile (they
 * render from independent sources; before this the dashboard kept the old name).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TerminalListEntry } from './terminalDashboardState.js';
import { tileLabel, toTileEntry } from './terminalDashboardTiles.js';
import {
  _resetTransientTerminalNamesForTests,
  clearTransientTerminalNames,
  getTransientTerminalName,
  setTransientTerminalName,
  TERMINAL_RENAMED_EVENT,
} from './terminalTransientNames.js';

const entry = (over: Partial<TerminalListEntry> = {}): TerminalListEntry => ({
  id: 't1', command: '/bin/zsh', name: 'Shell', dynamic: false, ...over,
});

describe('terminalTransientNames (HS-9277)', () => {
  afterEach(() => { _resetTransientTerminalNamesForTests(); vi.restoreAllMocks(); });

  it('round-trips a transient name keyed by (secret, id)', () => {
    setTransientTerminalName('secA', 't1', 'Renamed');
    expect(getTransientTerminalName('secA', 't1')).toBe('Renamed');
    // Different project with the same terminal id does NOT collide.
    expect(getTransientTerminalName('secB', 't1')).toBeUndefined();
  });

  it('an empty name clears the override', () => {
    setTransientTerminalName('secA', 't1', 'Renamed');
    setTransientTerminalName('secA', 't1', '');
    expect(getTransientTerminalName('secA', 't1')).toBeUndefined();
  });

  it('clearTransientTerminalNames wipes everything (project-switch semantics)', () => {
    setTransientTerminalName('secA', 't1', 'X');
    setTransientTerminalName('secB', 't2', 'Y');
    clearTransientTerminalNames();
    expect(getTransientTerminalName('secA', 't1')).toBeUndefined();
    expect(getTransientTerminalName('secB', 't2')).toBeUndefined();
  });

  it('dispatches hotsheet:terminal-renamed with the (secret, id) detail', () => {
    const seen: Array<{ secret: string; id: string }> = [];
    const handler = (e: Event) => { seen.push((e as CustomEvent).detail as { secret: string; id: string }); };
    document.addEventListener(TERMINAL_RENAMED_EVENT, handler);
    setTransientTerminalName('secA', 't1', 'Renamed');
    document.removeEventListener(TERMINAL_RENAMED_EVENT, handler);
    expect(seen).toEqual([{ secret: 'secA', id: 't1' }]);
  });

  describe('tileLabel', () => {
    it('returns the transient name over the configured name when secret is given', () => {
      setTransientTerminalName('secA', 't1', 'My Rename');
      expect(tileLabel(entry({ name: 'Shell' }), 'secA')).toBe('My Rename');
    });

    it('falls back to the configured name for a different project (no collision)', () => {
      setTransientTerminalName('secA', 't1', 'My Rename');
      expect(tileLabel(entry({ name: 'Shell' }), 'secB')).toBe('Shell');
    });

    it('ignores the transient store when no secret is passed (label-only callers)', () => {
      setTransientTerminalName('secA', 't1', 'My Rename');
      expect(tileLabel(entry({ name: 'Shell' }))).toBe('Shell');
    });

    it('still derives from the command when there is no name or transient override', () => {
      expect(tileLabel(entry({ name: '', command: '/usr/bin/fish' }), 'secA')).toBe('fish');
    });
  });

  // Wiring: the dashboard's tile mapper must thread its project secret into
  // tileLabel so a drawer rename (which writes the transient store) surfaces on
  // the tile it builds on open. This is the drawer→dashboard path from the bug.
  it('toTileEntry(secret) resolves the tile label from the transient store', () => {
    setTransientTerminalName('secX', 't1', 'Drawer Rename');
    const tile = toTileEntry('secX')(entry({ name: 'Shell' }));
    expect(tile.label).toBe('Drawer Rename');
  });
});
