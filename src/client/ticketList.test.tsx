// @vitest-environment happy-dom
/**
 * HS-8641 — `renderTicketList()` must no-op (not throw) when the `#ticket-list`
 * container isn't mounted. Repro: switching projects while the terminal
 * dashboard / cross-project view is active calls `closeDetail()`, which
 * synchronously dispatches `hotsheet:render`; the listener calls
 * `renderTicketList()`, whose column + list paths both `byId('ticket-list')` —
 * which threw "byId: no element with id ticket-list" because the dashboard had
 * replaced the list container. The guard makes rendering a no-op when there's
 * no container (dashboard exit rebuilds it and re-renders).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { buildSyncedIconMap, renderTicketList } from './ticketList.js';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('renderTicketList container guard (HS-8641)', () => {
  it('does not throw when #ticket-list is absent (dashboard / mid-switch)', () => {
    document.body.innerHTML = '<div id="something-else"></div>'; // no #ticket-list
    expect(() => renderTicketList()).not.toThrow();
  });

  it('does not throw on a hotsheet:render event with no #ticket-list mounted', () => {
    // Mirror the real trigger: closeDetail() dispatches this during switchProject.
    document.addEventListener('hotsheet:render', () => renderTicketList());
    expect(() => document.dispatchEvent(new CustomEvent('hotsheet:render'))).not.toThrow();
  });
});

/**
 * HS-8660 — `buildSyncedIconMap` converts the server's synced-tickets wire map
 * into the client `syncedTicketMap` shape, converting each plugin-manifest SVG
 * string into `SafeHtml` once. `loadTickets` now calls this BEFORE
 * `setTicketsAnimated` so the plugin icon is present when rows are first built
 * (bindList preserves rows by key, so a map populated after the rows render
 * never reaches them — the bug this fixes). These tests pin the mapping shape.
 */
describe('buildSyncedIconMap (HS-8660)', () => {
  it('converts an icon SVG string to SafeHtml and keeps the pluginId', () => {
    const map = buildSyncedIconMap({
      '7': { pluginId: 'github-issues', icon: '<svg data-test="gh"></svg>' },
    });
    expect(map[7].pluginId).toBe('github-issues');
    expect(map[7].icon).not.toBeUndefined();
    // SafeHtml stringifies back to the original (trusted) markup.
    expect(String(map[7].icon)).toContain('data-test="gh"');
  });

  it('leaves icon undefined when the entry has no icon (or an empty one)', () => {
    const map = buildSyncedIconMap({
      '8': { pluginId: 'some-plugin' },
      '9': { pluginId: 'some-plugin', icon: '' },
    });
    expect(map[8].pluginId).toBe('some-plugin');
    expect(map[8].icon).toBeUndefined();
    expect(map[9].icon).toBeUndefined();
  });

  it('keys the map by numeric ticket id', () => {
    const map = buildSyncedIconMap({
      '42': { pluginId: 'p', icon: '<svg/>' },
    });
    expect(Object.keys(map)).toEqual(['42']); // numeric key serialized
    expect(map[42]).not.toBeUndefined();
  });
});
