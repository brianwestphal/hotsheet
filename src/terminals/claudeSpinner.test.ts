import { describe, expect, it } from 'vitest';

import { busyStaleDecision, CLAUDE_SPINNER_GLYPHS, containsClaudeSpinner, shouldShowDegradedBusy } from './claudeSpinner.js';

describe('CLAUDE_SPINNER_GLYPHS (HS-6702)', () => {
  it('contains exactly the six glyphs from the user\'s ticket note', () => {
    expect(CLAUDE_SPINNER_GLYPHS.size).toBe(6);
    for (const ch of ['·', '✢', '✳', '✶', '✻', '✽']) {
      expect(CLAUDE_SPINNER_GLYPHS.has(ch)).toBe(true);
    }
  });

  it('does not include other look-alike characters', () => {
    expect(CLAUDE_SPINNER_GLYPHS.has('*')).toBe(false);
    expect(CLAUDE_SPINNER_GLYPHS.has('•')).toBe(false); // bullet, looks like middle dot but not the same code point
    expect(CLAUDE_SPINNER_GLYPHS.has('.')).toBe(false);
  });
});

describe('containsClaudeSpinner (HS-6702)', () => {
  it('returns true when the input contains any spinner glyph', () => {
    expect(containsClaudeSpinner('· Working...')).toBe(true);
    expect(containsClaudeSpinner('Done ✶')).toBe(true);
    expect(containsClaudeSpinner('foo ✻ bar')).toBe(true);
  });

  it('returns false for plain text with no spinner glyphs', () => {
    expect(containsClaudeSpinner('Hello, world!')).toBe(false);
    expect(containsClaudeSpinner('')).toBe(false);
    expect(containsClaudeSpinner('* not a spinner')).toBe(false);
    expect(containsClaudeSpinner('• bullet, not middle dot')).toBe(false);
  });

  it('returns true even when the spinner glyph is at the very end of the chunk', () => {
    expect(containsClaudeSpinner('Loading...·')).toBe(true);
  });

  it('handles ANSI escape sequences around the spinner correctly', () => {
    // Real-world Claude spinner emission includes ANSI color escapes —
    // the helper just scans characters, so escapes are harmless.
    expect(containsClaudeSpinner('\x1b[33m✻\x1b[0m')).toBe(true);
  });
});

describe('shouldShowDegradedBusy (HS-6702)', () => {
  it('returns false when channel is not busy', () => {
    expect(shouldShowDegradedBusy(false, null, 1000)).toBe(false);
    expect(shouldShowDegradedBusy(false, 500, 1000)).toBe(false);
  });

  it('returns true when channel is busy and we\'ve never seen a spinner', () => {
    expect(shouldShowDegradedBusy(true, null, 1000)).toBe(true);
  });

  it('returns false when channel is busy and the spinner was seen within the silence threshold', () => {
    // 1 second ago, threshold 5s → still active
    expect(shouldShowDegradedBusy(true, 4000, 5000)).toBe(false);
    // Just now → definitely active
    expect(shouldShowDegradedBusy(true, 5000, 5000)).toBe(false);
  });

  it('returns true when the spinner has been silent past the threshold', () => {
    // 6 seconds ago, threshold 5s → degraded
    expect(shouldShowDegradedBusy(true, 4000, 10000)).toBe(true);
    // Exactly at the threshold → degraded (boundary inclusive)
    expect(shouldShowDegradedBusy(true, 5000, 10000)).toBe(true);
  });

  it('respects a caller-supplied silence threshold', () => {
    // Threshold 2s — 3 seconds since last spinner is degraded
    expect(shouldShowDegradedBusy(true, 0, 3000, 2000)).toBe(true);
    // Threshold 10s — same elapsed time is still active
    expect(shouldShowDegradedBusy(true, 0, 3000, 10000)).toBe(false);
  });
});

describe('busyStaleDecision (HS-9262)', () => {
  const FRESH = 8000;
  const CAP = 300000;

  it('SUSTAINS when the spinner is fresh (long single tool call, no heartbeat)', () => {
    // Heartbeat 30s ago (stale), but spinner painted 2s ago → still working.
    expect(busyStaleDecision({
      lastSpinnerAtMs: 98000, nowMs: 100000, lastHeartbeatAtMs: 70000,
      spinnerFreshMs: FRESH, maxSustainMs: CAP,
    })).toBe('sustain');
  });

  it('CLEARS when the spinner has gone quiet past the fresh window', () => {
    // Spinner 10s ago (> 8s fresh window) → premature-off is now correct-off.
    expect(busyStaleDecision({
      lastSpinnerAtMs: 90000, nowMs: 100000, lastHeartbeatAtMs: 70000,
      spinnerFreshMs: FRESH, maxSustainMs: CAP,
    })).toBe('clear');
  });

  it('CLEARS when a spinner was never seen (null)', () => {
    expect(busyStaleDecision({
      lastSpinnerAtMs: null, nowMs: 100000, lastHeartbeatAtMs: 99000,
      spinnerFreshMs: FRESH, maxSustainMs: CAP,
    })).toBe('clear');
  });

  it('CLEARS past the max-sustain cap even with a fresh spinner (stuck-spinner backstop)', () => {
    // Spinner fresh (1s ago) but the last real heartbeat was 6 min ago (> 5 min cap).
    expect(busyStaleDecision({
      lastSpinnerAtMs: 99000, nowMs: 100000, lastHeartbeatAtMs: 100000 - 360000,
      spinnerFreshMs: FRESH, maxSustainMs: CAP,
    })).toBe('clear');
  });

  it('the fresh-window boundary is exclusive (exactly freshMs old → clear)', () => {
    expect(busyStaleDecision({
      lastSpinnerAtMs: 100000 - FRESH, nowMs: 100000, lastHeartbeatAtMs: 90000,
      spinnerFreshMs: FRESH, maxSustainMs: CAP,
    })).toBe('clear');
  });
});
