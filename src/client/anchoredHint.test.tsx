// @vitest-environment happy-dom
/**
 * HS-8784 — the anchored hint bubble. The earlier "no pending changes" fix was
 * only unit-tested at the pure-boolean layer (`glassboxReview.test.ts`); nothing
 * asserted that feedback actually RENDERS, which is exactly what the user
 * reported missing. These tests cover the create → show → auto-dismiss lifecycle
 * so a regression that silently drops the feedback element is caught.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dismissAnchoredHint, flashAnchoredHint } from './anchoredHint.js';

function anchor(): HTMLElement {
  const btn = document.createElement('button');
  document.body.appendChild(btn);
  return btn;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('flashAnchoredHint (HS-8784)', () => {
  it('renders a hint bubble carrying the message', () => {
    flashAnchoredHint(anchor(), 'No pending changes for Glassbox to review.');
    const hint = document.querySelector('.anchored-hint');
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toBe('No pending changes for Glassbox to review.');
    // It's a polite live region so assistive tech announces it too.
    expect(hint?.getAttribute('role')).toBe('status');
  });

  it('shows only one hint at a time (a second call replaces the first)', () => {
    const a = anchor();
    flashAnchoredHint(a, 'first');
    flashAnchoredHint(a, 'second');
    const hints = document.querySelectorAll('.anchored-hint');
    expect(hints).toHaveLength(1);
    expect(hints[0].textContent).toBe('second');
  });

  it('auto-dismisses after the duration + fade', () => {
    flashAnchoredHint(anchor(), 'bye', { durationMs: 1000 });
    expect(document.querySelector('.anchored-hint')).not.toBeNull();
    vi.advanceTimersByTime(1000); // duration elapses → fade starts
    expect(document.querySelector('.anchored-hint')).not.toBeNull(); // still fading
    vi.advanceTimersByTime(300);  // TOAST_FADE_OUT_MS
    expect(document.querySelector('.anchored-hint')).toBeNull();
  });

  it('is dismissed by the next pointer-down', () => {
    flashAnchoredHint(anchor(), 'tap away', { durationMs: 100000 });
    vi.advanceTimersByTime(1); // arm the one-shot pointerdown listener (next tick)
    document.dispatchEvent(new Event('pointerdown'));
    vi.advanceTimersByTime(300); // fade-out
    expect(document.querySelector('.anchored-hint')).toBeNull();
  });

  it('dismissAnchoredHint removes a visible hint immediately', () => {
    flashAnchoredHint(anchor(), 'gone');
    dismissAnchoredHint();
    expect(document.querySelector('.anchored-hint')).toBeNull();
  });
});
