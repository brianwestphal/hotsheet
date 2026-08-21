import { describe, expect, it } from 'vitest';

import {
  AUTO_APPROVE_OPTIONS,
  autoApproveLabel,
  autoApproveRemainingMs,
  formatCountdown,
  isAutoApproveEnabled,
  isEnabledAutoApproveMs,
  parseAutoApproveMs,
} from './permissionAutoApprove.js';

describe('AUTO_APPROVE_OPTIONS (HS-9702)', () => {
  it('leads with the Off sentinel then the documented windows (incl. the 15s option)', () => {
    expect(AUTO_APPROVE_OPTIONS.map(o => o.ms)).toEqual([0, 15_000, 60_000, 120_000, 300_000, 900_000, 3_600_000]);
    expect(AUTO_APPROVE_OPTIONS[0]).toEqual({ ms: 0, label: 'Off' });
    expect(AUTO_APPROVE_OPTIONS[1]).toEqual({ ms: 15_000, label: '15 seconds' });
  });
});

describe('isEnabledAutoApproveMs', () => {
  it('accepts exactly the enabled windows', () => {
    for (const ms of [15_000, 60_000, 120_000, 300_000, 900_000, 3_600_000]) {
      expect(isEnabledAutoApproveMs(ms)).toBe(true);
    }
  });
  it('rejects 0 (off) and any non-offered value', () => {
    for (const ms of [0, 1, 30_000, 61_000, 7_200_000, -60_000, NaN]) {
      expect(isEnabledAutoApproveMs(ms)).toBe(false);
    }
  });
});

describe('parseAutoApproveMs — fail-closed coercion', () => {
  it('passes through a valid enabled window', () => {
    expect(parseAutoApproveMs(300_000)).toBe(300_000);
  });
  it('collapses everything else to 0 (OFF), so a bad setting never auto-approves', () => {
    expect(parseAutoApproveMs(0)).toBe(0);
    expect(parseAutoApproveMs(undefined)).toBe(0);
    expect(parseAutoApproveMs(null)).toBe(0);
    expect(parseAutoApproveMs('300000')).toBe(0); // strings are not accepted
    expect(parseAutoApproveMs(45_000)).toBe(0); // an unoffered duration
    expect(parseAutoApproveMs(-60_000)).toBe(0);
    expect(parseAutoApproveMs(NaN)).toBe(0);
    expect(parseAutoApproveMs({ ms: 60_000 })).toBe(0);
  });
});

describe('isAutoApproveEnabled', () => {
  it('is true only for a valid enabled window', () => {
    expect(isAutoApproveEnabled(60_000)).toBe(true);
    expect(isAutoApproveEnabled(0)).toBe(false);
    expect(isAutoApproveEnabled(undefined)).toBe(false);
    expect(isAutoApproveEnabled(45_000)).toBe(false);
  });
});

describe('autoApproveRemainingMs', () => {
  it('returns the time left until the deadline', () => {
    // created at 1000, window 5000 → deadline 6000; at now=2500 → 3500 left
    expect(autoApproveRemainingMs(1000, 5000, 2500)).toBe(3500);
  });
  it('clamps to 0 once the deadline has passed (never negative)', () => {
    expect(autoApproveRemainingMs(1000, 5000, 6000)).toBe(0);
    expect(autoApproveRemainingMs(1000, 5000, 9999)).toBe(0);
  });
});

describe('formatCountdown', () => {
  it('formats whole-minute + second values as M:SS', () => {
    expect(formatCountdown(47_000)).toBe('0:47');
    expect(formatCountdown(125_000)).toBe('2:05');
    expect(formatCountdown(3_600_000)).toBe('60:00');
  });
  it('rounds UP to whole seconds so the last tick shows 0:01, not a premature 0:00', () => {
    expect(formatCountdown(500)).toBe('0:01');
    expect(formatCountdown(1)).toBe('0:01');
  });
  it('shows 0:00 exactly at (and below) zero', () => {
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-5000)).toBe('0:00');
  });
});

describe('autoApproveLabel', () => {
  it('maps an enabled window to its human label', () => {
    expect(autoApproveLabel(300_000)).toBe('5 minutes');
    expect(autoApproveLabel(3_600_000)).toBe('60 minutes');
  });
  it('falls back to <ms>ms for an unexpected value', () => {
    expect(autoApproveLabel(45_000)).toBe('45000ms');
  });
});
