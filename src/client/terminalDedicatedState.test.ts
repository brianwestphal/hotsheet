// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import { hasOpenDedicatedTerminalView } from './terminalDedicatedState.js';

describe('hasOpenDedicatedTerminalView (HS-7985)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns false when no dedicated view is mounted', () => {
    expect(hasOpenDedicatedTerminalView()).toBe(false);
  });

  it('returns true when a dashboard dedicated view is mounted', () => {
    const el = document.createElement('div');
    el.className = 'terminal-dashboard-dedicated';
    document.body.appendChild(el);
    expect(hasOpenDedicatedTerminalView()).toBe(true);
  });

  it('returns true when a drawer-grid dedicated view is mounted', () => {
    const el = document.createElement('div');
    el.className = 'drawer-terminal-grid-dedicated';
    document.body.appendChild(el);
    expect(hasOpenDedicatedTerminalView()).toBe(true);
  });

  it('returns false when the dedicated view has been unmounted', () => {
    const el = document.createElement('div');
    el.className = 'terminal-dashboard-dedicated';
    document.body.appendChild(el);
    expect(hasOpenDedicatedTerminalView()).toBe(true);
    el.remove();
    expect(hasOpenDedicatedTerminalView()).toBe(false);
  });

  it('does not match an unrelated element with a similar class', () => {
    const el = document.createElement('div');
    el.className = 'terminal-dashboard-dedicated-bar';
    document.body.appendChild(el);
    expect(hasOpenDedicatedTerminalView()).toBe(false);
  });
});
