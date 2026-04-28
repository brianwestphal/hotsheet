/**
 * HS-7977 — terminals are a Tauri-only feature. The drawer-tab gating helper
 * coerces any saved `terminal:*` active-tab back to `commands-log` whenever
 * the runtime is a plain browser, so the drawer never ends up activating a
 * pane that has no chance of rendering xterm output.
 */
import { describe, expect, it } from 'vitest';

import { resolveDrawerTabForTauri } from './drawerTabGating.js';

describe('resolveDrawerTabForTauri (HS-7977)', () => {
  it('keeps commands-log unchanged in a browser', () => {
    expect(resolveDrawerTabForTauri('commands-log', false)).toBe('commands-log');
  });

  it('keeps commands-log unchanged in Tauri', () => {
    expect(resolveDrawerTabForTauri('commands-log', true)).toBe('commands-log');
  });

  it('keeps a terminal tab in Tauri', () => {
    expect(resolveDrawerTabForTauri('terminal:default', true)).toBe('terminal:default');
  });

  it('keeps a dynamic terminal tab in Tauri', () => {
    expect(resolveDrawerTabForTauri('terminal:dyn-abc123', true)).toBe('terminal:dyn-abc123');
  });

  it('redirects a configured terminal tab to commands-log in a browser', () => {
    expect(resolveDrawerTabForTauri('terminal:default', false)).toBe('commands-log');
  });

  it('redirects a dynamic terminal tab to commands-log in a browser', () => {
    expect(resolveDrawerTabForTauri('terminal:dyn-xyz', false)).toBe('commands-log');
  });

  it('redirects regardless of the terminal id shape', () => {
    expect(resolveDrawerTabForTauri('terminal:server', false)).toBe('commands-log');
    expect(resolveDrawerTabForTauri('terminal:Claude', false)).toBe('commands-log');
    expect(resolveDrawerTabForTauri('terminal:', false)).toBe('commands-log');
  });

  it('does not redirect strings that merely contain "terminal:" (the prefix is anchored)', () => {
    expect(resolveDrawerTabForTauri('not-terminal:default', false)).toBe('not-terminal:default');
    expect(resolveDrawerTabForTauri('myterminal:default', false)).toBe('myterminal:default');
  });
});
