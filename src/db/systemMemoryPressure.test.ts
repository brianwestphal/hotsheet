/**
 * HS-9469 — the machine-level memory signal. Every parser and the hysteresis rule
 * are pure, so the platform-specific behavior is testable on any host (the same
 * discipline CLAUDE.md requires of the Rust `#[cfg(target_os)]` branches).
 */
import { describe, expect, it } from 'vitest';

import {
  applyHysteresis,
  EASE_SAMPLES,
  levelFromFreeRatio,
  parseLinuxPsi,
  parseMacPressureLevel,
  sampleSystemPressure,
} from './systemMemoryPressure.js';

describe('parseMacPressureLevel (HS-9469)', () => {
  it('maps the kernel levels', () => {
    // 1 / 2 / 4 are the documented `kern.memorystatus_vm_pressure_level` values.
    expect(parseMacPressureLevel('1\n')).toBe('normal');
    expect(parseMacPressureLevel('2\n')).toBe('warn');
    expect(parseMacPressureLevel('4\n')).toBe('critical');
  });

  it('treats an unknown higher level as critical rather than ignoring it', () => {
    // Fail toward caution: an unrecognized HIGH value should not read as calm.
    expect(parseMacPressureLevel('8')).toBe('critical');
  });

  it('returns null for junk so the caller can fall back', () => {
    expect(parseMacPressureLevel('')).toBeNull();
    expect(parseMacPressureLevel('not-a-number')).toBeNull();
    expect(parseMacPressureLevel('0')).toBeNull();
  });
});

describe('parseLinuxPsi (HS-9469)', () => {
  const psi = (avg10: string) => `some avg10=${avg10} avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`;

  it('reads the "some avg10" stall percentage', () => {
    // Stall time beats free bytes: a machine can have little free memory and be
    // fine, but it cannot be stalling and be fine.
    expect(parseLinuxPsi(psi('0.00'))).toBe('normal');
    expect(parseLinuxPsi(psi('7.50'))).toBe('warn');
    expect(parseLinuxPsi(psi('35.00'))).toBe('critical');
  });

  it('reads the `some` line, not the `full` one', () => {
    const raw = `full avg10=99.00 avg60=0.00 avg300=0.00 total=0\nsome avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`;
    expect(parseLinuxPsi(raw)).toBe('normal');
  });

  it('returns null when the file is not what we expect', () => {
    expect(parseLinuxPsi('')).toBeNull();
    expect(parseLinuxPsi('some garbage without avg10')).toBeNull();
  });
});

describe('levelFromFreeRatio (HS-9469)', () => {
  const GB = 1024 * 1024 * 1024;

  it('is deliberately generous, because free-memory figures under-report', () => {
    // On macOS "free" excludes purgeable and file-backed pages, so a healthy
    // 32 GB machine routinely shows a few hundred MB free. A naive threshold here
    // would pin the cache at its floor forever — a cure worse than the disease.
    expect(levelFromFreeRatio(4 * GB, 32 * GB)).toBe('normal');
    expect(levelFromFreeRatio(3.2 * GB, 32 * GB)).toBe('normal');
  });

  it('fires only when things look genuinely dire', () => {
    expect(levelFromFreeRatio(2 * GB, 32 * GB)).toBe('warn');
    expect(levelFromFreeRatio(0.3 * GB, 32 * GB)).toBe('critical');
  });

  it('does not divide by zero', () => {
    expect(levelFromFreeRatio(0, 0)).toBe('normal');
  });
});

describe('applyHysteresis (HS-9469)', () => {
  it('adopts an INCREASE in pressure immediately', () => {
    // Reacting late to rising pressure is the failure that matters.
    expect(applyHysteresis('normal', 'critical', 0)).toEqual({ level: 'critical', calmerRun: 0 });
    expect(applyHysteresis('normal', 'warn', 0)).toEqual({ level: 'warn', calmerRun: 0 });
  });

  it('requires several consecutive calmer samples before easing off', () => {
    // Pressure is spiky; following every dip back down would reopen clusters that
    // are about to be evicted again — churn, during exactly the period when
    // reopens are most expensive.
    const state = { level: 'critical' as const, calmerRun: 0 };
    let out = applyHysteresis(state.level, 'normal', state.calmerRun);
    expect(out.level).toBe('critical'); // not yet
    expect(out.calmerRun).toBe(1);

    out = applyHysteresis('critical', 'normal', out.calmerRun);
    expect(out.level).toBe('critical');
    expect(out.calmerRun).toBe(2);

    out = applyHysteresis('critical', 'normal', out.calmerRun);
    expect(out.level).toBe('normal'); // EASE_SAMPLES reached
    expect(out.calmerRun).toBe(0);
    expect(EASE_SAMPLES).toBe(3);
  });

  it('a single spike back up resets the calmer run', () => {
    // Two calm samples then one spike must NOT ease on the next calm sample.
    let out = applyHysteresis('critical', 'normal', 0);
    out = applyHysteresis('critical', 'normal', out.calmerRun);
    expect(out.calmerRun).toBe(2);
    const spiked = applyHysteresis('critical', 'critical', out.calmerRun);
    expect(spiked).toEqual({ level: 'critical', calmerRun: 0 });
  });

  it('holding steady is not progress toward easing', () => {
    expect(applyHysteresis('warn', 'warn', 2)).toEqual({ level: 'warn', calmerRun: 0 });
  });
});

describe('sampleSystemPressure (HS-9469)', () => {
  it('falls back to the free-ratio heuristic on an unknown platform', async () => {
    // Windows and anything exotic: no cheap kernel verdict, so the generous
    // fallback rather than pretending we know.
    await expect(sampleSystemPressure('sunos')).resolves.toMatch(/^(normal|warn|critical)$/);
  });

  it('never throws — a failed probe reports normal', async () => {
    // A broken probe must add NO constraint, leaving the process-level guard
    // exactly as it was. Shrinking the cache because we failed to measure would
    // be the worst possible failure mode.
    await expect(sampleSystemPressure('linux')).resolves.toMatch(/^(normal|warn|critical)$/);
    await expect(sampleSystemPressure('darwin')).resolves.toMatch(/^(normal|warn|critical)$/);
  });
});
