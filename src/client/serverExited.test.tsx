// @vitest-environment happy-dom
/**
 * HS-9558 — the "Server Stopped" notice.
 *
 * The bug being guarded is a UX one and it has a precise shape: on 2026-08-03 a
 * dead server produced a fully rendered window that looked identical to a
 * working one for 49 minutes. So the assertions below are about what the USER
 * can see and cannot do — the overlay exists, it names the cause, it cannot be
 * dismissed into invisibility, and it replaces (rather than stacks behind) the
 * vaguer connection-error popup.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { showErrorPopup } from './api.js';
import {
  _resetServerExitedForTesting,
  initServerExitedNotice,
  showServerExitedOverlay,
  showServerRestartingOverlay,
} from './serverExited.js';
import { _resetShutdownStateForTesting, isShuttingDown } from './shutdownState.js';

interface TauriWindow { __TAURI__?: { event?: { listen?: unknown } } }

afterEach(() => {
  _resetServerExitedForTesting();
  _resetShutdownStateForTesting();
  document.getElementById('network-error-popup')?.remove();
  delete (window as TauriWindow).__TAURI__;
});

describe('showServerRestartingOverlay (HS-9656)', () => {
  it('puts up a transient "Restarting…" overlay that reassures the work is safe', () => {
    showServerRestartingOverlay('killed by a signal');
    expect(document.querySelector('.shutdown-overlay-title')?.textContent).toBe('Restarting the server…');
    expect(document.querySelector('.shutdown-overlay')?.textContent).toContain('saved to disk');
  });

  it('is replaced by the terminal "Server Stopped" overlay if the restart gives up', () => {
    showServerRestartingOverlay('killed by a signal');
    showServerExitedOverlay('auto-restart gave up');
    // Exactly one overlay, and it's the terminal one — not stacked behind the restart notice.
    expect(document.querySelectorAll('.shutdown-overlay')).toHaveLength(1);
    expect(document.querySelector('.shutdown-overlay-title')?.textContent).toBe('Server Stopped');
  });

  it('does NOT downgrade a terminal "Server Stopped" back to "Restarting…"', () => {
    showServerExitedOverlay('exit code 1');
    showServerRestartingOverlay('a late restart event');
    expect(document.querySelector('.shutdown-overlay-title')?.textContent).toBe('Server Stopped');
  });
});

describe('showServerExitedOverlay', () => {
  it('puts up an overlay that says the server stopped', () => {
    showServerExitedOverlay('exit code 1');
    expect(document.querySelector('.shutdown-overlay')).not.toBeNull();
    expect(document.querySelector('.shutdown-overlay-title')?.textContent).toBe('Server Stopped');
  });

  it('tells the user what to actually do about it', () => {
    // A notice that only says "something broke" leaves the user in the same
    // place as the 49-minute dead window — staring at it, unsure.
    showServerExitedOverlay('exit code 1');
    expect(document.querySelector('.shutdown-overlay')?.textContent).toContain('Quit and relaunch');
  });

  it('shows the exit detail, which is the most diagnostic single fact', () => {
    showServerExitedOverlay('killed by a signal (no exit code) — e.g. the watchdog’s SIGKILL');
    expect(document.querySelector('.shutdown-overlay')?.textContent).toContain('killed by a signal');
  });

  it('points at the diagnostic logs so a report can include them', () => {
    showServerExitedOverlay('exit code 1');
    const text = document.querySelector('.shutdown-overlay')?.textContent ?? '';
    expect(text).toContain('startup.log');
    expect(text).toContain('server-stderr.log');
  });

  it('is idempotent — a second event does not stack a second overlay', () => {
    showServerExitedOverlay('exit code 1');
    showServerExitedOverlay('exit code 1');
    expect(document.querySelectorAll('.shutdown-overlay').length).toBe(1);
  });

  it('suppresses the vaguer "Connection Error" popup, present or future', () => {
    // The shell REAPED the child, so "the server is gone" is a fact here, not the
    // guess a failed fetch makes. Stacking the guess behind the fact is noise.
    showErrorPopup('Unable to reach the server.');
    expect(document.getElementById('network-error-popup')).not.toBeNull();

    showServerExitedOverlay('exit code 1');
    expect(document.getElementById('network-error-popup')).toBeNull();
    expect(isShuttingDown()).toBe(true);
  });

  it('has no dismiss control — nothing in the window works any more', () => {
    showServerExitedOverlay('exit code 1');
    expect(document.querySelector('.shutdown-overlay')?.querySelector('button')).toBeNull();
  });
});

describe('initServerExitedNotice', () => {
  it('no-ops outside Tauri, where there is no event bridge', () => {
    expect(() => { initServerExitedNotice(); }).not.toThrow();
    expect(document.querySelector('.shutdown-overlay')).toBeNull();
  });

  it('renders the overlay when the shell reports the server exited', () => {
    // Collected in an array rather than a `let`: assigning inside the callback
    // leaves TS narrowing the variable to `never` at the call site below.
    const handlers: ((e: { payload: unknown }) => void)[] = [];
    const listen = vi.fn((_event: string, h: (e: { payload: unknown }) => void) => {
      handlers.push(h);
      return Promise.resolve(() => undefined);
    });
    (window as TauriWindow).__TAURI__ = { event: { listen } };

    initServerExitedNotice();
    expect(listen).toHaveBeenCalledWith('server-exited', expect.any(Function));

    handlers[0]?.({ payload: 'exit code 137' });
    expect(document.querySelector('.shutdown-overlay')?.textContent).toContain('exit code 137');
  });

  it('falls back to a generic line when the payload is not a usable string', () => {
    // The payload crosses a process boundary; an empty or non-string value must
    // not render an overlay whose cause line is blank or "undefined".
    const handlers: ((e: { payload: unknown }) => void)[] = [];
    (window as TauriWindow).__TAURI__ = {
      event: {
        listen: (_e: string, h: (e: { payload: unknown }) => void) => {
          handlers.push(h);
          return Promise.resolve(() => undefined);
        },
      },
    };

    initServerExitedNotice();
    handlers[0]?.({ payload: null });
    const text = document.querySelector('.shutdown-overlay')?.textContent ?? '';
    expect(text).toContain('The server exited unexpectedly.');
    expect(text).not.toContain('undefined');
  });
});
