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

import { renderTicketList } from './ticketList.js';

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
