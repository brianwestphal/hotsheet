// @vitest-environment happy-dom
/** HS-9131 — FLIP list animation helpers (`animate.ts`). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureSnapshot, flipAnimate, suppressAnimation } from './animate.js';

function rect(left: number, top: number): DOMRect {
  return { left, top, right: left, bottom: top, x: left, y: top, width: 0, height: 0, toJSON() { return {}; } };
}

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { vi.useRealTimers(); });

describe('captureSnapshot', () => {
  it('captures a rect per .ticket-row[data-id] / .column-card[data-id]', () => {
    document.body.innerHTML = '<div class="ticket-row" data-id="1"></div><div class="column-card" data-id="2"></div><div class="ticket-row"></div>';
    const snap = captureSnapshot();
    expect(snap.size).toBe(2); // the third row has no data-id
    expect(snap.has('1')).toBe(true);
    expect(snap.has('2')).toBe(true);
  });
});

describe('flipAnimate', () => {
  it('is a no-op (and consumes the flag) after suppressAnimation()', () => {
    document.body.innerHTML = '<div class="ticket-row" data-id="1"></div>';
    const el = document.querySelector<HTMLElement>('.ticket-row')!;
    el.getBoundingClientRect = () => rect(0, 0);
    const before = new Map([['1', rect(100, 100)]]);
    suppressAnimation();
    flipAnimate(before);
    expect(el.style.transition).toBe('');
    // The flag is one-shot: a subsequent flip with a real delta DOES animate.
    flipAnimate(before);
    expect(el.style.transition).toBe('transform 200ms ease-out');
  });

  it('is a no-op when the before-snapshot is empty', () => {
    document.body.innerHTML = '<div class="ticket-row" data-id="1"></div>';
    const el = document.querySelector<HTMLElement>('.ticket-row')!;
    el.getBoundingClientRect = () => rect(0, 0);
    flipAnimate(new Map());
    expect(el.style.transition).toBe('');
  });

  it('skips an element that did not move (delta < 1px)', () => {
    document.body.innerHTML = '<div class="ticket-row" data-id="1"></div>';
    const el = document.querySelector<HTMLElement>('.ticket-row')!;
    el.getBoundingClientRect = () => rect(0, 0);
    flipAnimate(new Map([['1', rect(0, 0)]]));
    expect(el.style.transition).toBe('');
  });

  it('animates a moved element then clears the transition on cleanup', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div class="ticket-row" data-id="1"></div>';
    const el = document.querySelector<HTMLElement>('.ticket-row')!;
    el.getBoundingClientRect = () => rect(0, 0); // new position
    flipAnimate(new Map([['1', rect(100, 100)]])); // old position 100,100 → delta 100
    expect(el.style.transition).toBe('transform 200ms ease-out');
    expect(el.style.transform).toBe(''); // reset to '' to run the transition
    vi.advanceTimersByTime(10_000); // past TRANSITION_CLEANUP_MS
    expect(el.style.transition).toBe('');
  });

  it('ignores ids present in the snapshot but absent from the DOM', () => {
    document.body.innerHTML = '<div class="ticket-row" data-id="1"></div>';
    const el = document.querySelector<HTMLElement>('.ticket-row')!;
    el.getBoundingClientRect = () => rect(0, 0);
    // snapshot has an extra id '99' with no element — must not throw.
    expect(() => flipAnimate(new Map([['99', rect(50, 50)]]))).not.toThrow();
    expect(el.style.transition).toBe(''); // '1' had no old rect → skipped
  });
});
