// @vitest-environment happy-dom
/**
 * HS-9455 — the client had no `window.onerror` / `unhandledrejection` listener, so a
 * crash in a handler or a floating promise was invisible outside devtools. These
 * cover the three things a global handler has to get right: it must not loop when
 * reporting itself throws, it must not turn an error storm into a popup storm, and
 * it must ignore resource-load `error` events (a broken <img> is not a crash).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetGlobalErrorHandlerForTesting,
  describeClientError,
  formatErrorLocation,
  installGlobalErrorHandler,
} from './globalErrorHandler.js';

describe('describeClientError', () => {
  it('names an Error by type and message', () => {
    expect(describeClientError(new RangeError('Maximum call stack size exceeded'), 'error'))
      .toBe('RangeError: Maximum call stack size exceeded');
  });
  it('falls back to the error name when the message is empty', () => {
    expect(describeClientError(new Error(''), 'error')).toBe('Error');
  });
  it('describes a non-Error throw rather than rendering "[object Object]"', () => {
    expect(describeClientError({ nope: 1 }, 'error')).toContain('Unexpected value thrown');
    expect(describeClientError('a string', 'error')).toContain('a string');
  });
  it('marks a rejection so the source is obvious in the popup', () => {
    expect(describeClientError(new Error('boom'), 'unhandledrejection'))
      .toBe('Error: boom (unhandled promise rejection)');
  });
});

describe('formatErrorLocation', () => {
  it('reduces a URL to file:line:col', () => {
    expect(formatErrorLocation('http://localhost:4174/static/app.global.js', 12, 34)).toBe('app.global.js:12:34');
  });
  it('omits missing line/col', () => {
    expect(formatErrorLocation('/a/b/app.js', 0, 0)).toBe('app.js');
  });
  it('is null when the browser gave no filename', () => {
    expect(formatErrorLocation('', 1, 1)).toBeNull();
    expect(formatErrorLocation(undefined, 1, 1)).toBeNull();
  });
});

describe('installGlobalErrorHandler', () => {
  let now = 0;
  const popup = (): HTMLElement | null => document.getElementById('network-error-popup');

  let dispose: () => void = () => { /* replaced in beforeEach */ };

  beforeEach(() => {
    _resetGlobalErrorHandlerForTesting();
    now = 1_000_000;
    vi.spyOn(console, 'error').mockImplementation(() => { /* quiet */ });
    dispose = installGlobalErrorHandler(() => now);
  });
  // Detach: a leaked listener would count the NEXT test's errors too.
  afterEach(() => { dispose(); popup()?.remove(); vi.restoreAllMocks(); });

  const raise = (err: unknown): void => {
    const e = new ErrorEvent('error', { error: err, message: 'x', filename: '/app.js', lineno: 5, colno: 6 });
    Object.defineProperty(e, 'target', { value: window });
    window.dispatchEvent(e);
  };

  it('surfaces a thrown error that would otherwise be console-only', () => {
    raise(new RangeError('Maximum call stack size exceeded'));
    expect(popup()!.textContent).toContain('RangeError: Maximum call stack size exceeded');
    expect(popup()!.textContent).toContain('Something went wrong');
    expect(popup()!.querySelector('.error-popup-detail')!.textContent).toContain('app.js:5:6');
  });

  it('surfaces an unhandled promise rejection', () => {
    window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('async boom') }));
    expect(popup()!.textContent).toContain('async boom');
    expect(popup()!.textContent).toContain('unhandled promise rejection');
  });

  // A runaway interval throwing every tick must not rebuild the overlay forever.
  it('rate-limits a storm to one popup, then reports how many were suppressed', () => {
    for (let i = 0; i < 25; i++) raise(new Error(`burst ${String(i)}`));
    expect(popup()!.textContent).toContain('burst 0');
    expect(popup()!.textContent).not.toContain('burst 24');

    popup()!.remove();
    now += 11_000; // past the cool-off
    raise(new Error('after cooldown'));
    expect(popup()!.textContent).toContain('after cooldown');
    expect(popup()!.querySelector('.error-popup-detail')!.textContent).toContain('24 more suppressed');
  });

  // A broken <img> fires `error` on the ELEMENT. That is not an app crash.
  it('ignores resource-load error events from elements', () => {
    const img = document.createElement('img');
    document.body.appendChild(img);
    const e = new ErrorEvent('error', { message: '404' });
    Object.defineProperty(e, 'target', { value: img });
    window.dispatchEvent(e);
    expect(popup()).toBeNull();
    img.remove();
  });

  it('is idempotent — installing twice does not double-report', () => {
    installGlobalErrorHandler(() => now); // no-op; must not attach a second listener
    raise(new Error('once'));
    expect(document.querySelectorAll('#network-error-popup')).toHaveLength(1);
  });
});
