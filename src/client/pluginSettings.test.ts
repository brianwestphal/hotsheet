// @vitest-environment happy-dom
/**
 * HS-9003 — `bindPluginSettings` must not throw when the plugins settings panel
 * is absent. The panel (and `#plugin-install-btn`) is only server-rendered when
 * `PLUGINS_ENABLED` (pages.tsx); with plugins disabled the old
 * `byId('plugin-install-btn')` threw at bind time → an unhandled rejection →
 * the generic HS-9455 "Something went wrong" crash popup on every load for a
 * plugins-disabled instance. (Surfaced by the demo capture, which runs with
 * `PLUGINS_ENABLED=false`.)
 */
import { afterEach, describe, expect, it } from 'vitest';

import { bindPluginSettings } from './pluginSettings.js';

afterEach(() => {
  document.body.innerHTML = '';
});

function button(id: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.id = id;
  document.body.appendChild(b);
  return b;
}

describe('bindPluginSettings (HS-9003)', () => {
  it('is a no-op — does NOT throw — when the plugins panel is not rendered', () => {
    // Plugins disabled: neither #plugin-install-btn nor the panel exists.
    expect(document.getElementById('plugin-install-btn')).toBeNull();
    expect(() => bindPluginSettings()).not.toThrow();
  });

  it('binds without throwing when the plugins panel IS present', () => {
    button('settings-btn');
    button('plugin-install-btn');
    expect(() => bindPluginSettings()).not.toThrow();
  });
});
