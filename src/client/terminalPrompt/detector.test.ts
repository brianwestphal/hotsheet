/**
 * HS-7971 Phase 1 — detector behaviour tests. Pure dispatch decisions —
 * doesn't drive the debounce timer (vitest fake timers are flaky in CI;
 * the debounce is one `setTimeout` call which is well-covered elsewhere).
 */
import { describe, expect, it } from 'vitest';

import {
  clearDetectorSuppression,
  createDetector,
  decideDispatch,
  isDetectorSuppressed,
  markDetectorSuppressed,
  notifyUserKeystroke,
} from './detector.js';

const promptRows = [
  'Loading development channels can pose a security risk',
  '',
  '> 1. I am using this for local development',
  '  2. Exit',
  '',
  'Enter to confirm · Esc to cancel',
];

describe('decideDispatch (HS-7971)', () => {
  it('dispatches a fresh match when nothing is suppressed and overlay is closed', () => {
    const { match, nextLastSig } = decideDispatch(promptRows, {
      overlayOpen: false,
      suppressed: false,
      lastDispatchedSignature: null,
    });
    expect(match).not.toBeNull();
    expect(nextLastSig).toMatch(/^claude-numbered:/);
  });

  it('skips dispatch when overlay is already open', () => {
    const { match, nextLastSig } = decideDispatch(promptRows, {
      overlayOpen: true,
      suppressed: false,
      lastDispatchedSignature: null,
    });
    expect(match).toBeNull();
    expect(nextLastSig).toBeNull();
  });

  it('skips dispatch when suppressed', () => {
    const { match } = decideDispatch(promptRows, {
      overlayOpen: false,
      suppressed: true,
      lastDispatchedSignature: null,
    });
    expect(match).toBeNull();
  });

  it('does not re-dispatch the same signature back-to-back (cursor-blink redraws)', () => {
    // First dispatch records the signature.
    const first = decideDispatch(promptRows, {
      overlayOpen: false,
      suppressed: false,
      lastDispatchedSignature: null,
    });
    expect(first.match).not.toBeNull();
    // Second dispatch with the same rows + the recorded signature: skipped.
    const second = decideDispatch(promptRows, {
      overlayOpen: false,
      suppressed: false,
      lastDispatchedSignature: first.nextLastSig,
    });
    expect(second.match).toBeNull();
  });

  it('clears lastDispatchedSignature when no prompt is visible (lets a re-arrival re-dispatch)', () => {
    const sigBefore = 'claude-numbered:abc12345:0';
    const { match, nextLastSig } = decideDispatch(['just plain output'], {
      overlayOpen: false,
      suppressed: false,
      lastDispatchedSignature: sigBefore,
    });
    expect(match).toBeNull();
    expect(nextLastSig).toBeNull();
  });

  it('dispatches a different prompt even when a stale signature is recorded', () => {
    // Different question text ⇒ different hash ⇒ different signature.
    const otherPromptRows = [
      'Pick one',
      '',
      '> 1. Foo',
      '  2. Bar',
      '',
      'Enter to confirm',
    ];
    const { match, nextLastSig } = decideDispatch(otherPromptRows, {
      overlayOpen: false,
      suppressed: false,
      lastDispatchedSignature: 'claude-numbered:00000000:0',
    });
    expect(match).not.toBeNull();
    expect(nextLastSig).not.toBe('claude-numbered:00000000:0');
  });
});

describe('suppression helpers (HS-7986)', () => {
  function makeDetector() {
    return createDetector({
      readRows: () => [],
      isActive: () => true,
      onMatch: () => { /* noop */ },
    });
  }

  it('isDetectorSuppressed returns false on a fresh detector', () => {
    expect(isDetectorSuppressed(makeDetector())).toBe(false);
  });

  it('markDetectorSuppressed flips the suppressed flag and isDetectorSuppressed reflects it', () => {
    const d = makeDetector();
    markDetectorSuppressed(d);
    expect(isDetectorSuppressed(d)).toBe(true);
  });

  it('clearDetectorSuppression resets the flag', () => {
    const d = makeDetector();
    markDetectorSuppressed(d);
    expect(isDetectorSuppressed(d)).toBe(true);
    clearDetectorSuppression(d);
    expect(isDetectorSuppressed(d)).toBe(false);
  });

  it('notifyUserKeystroke also clears suppression', () => {
    const d = makeDetector();
    markDetectorSuppressed(d);
    notifyUserKeystroke(d);
    expect(isDetectorSuppressed(d)).toBe(false);
  });
});
