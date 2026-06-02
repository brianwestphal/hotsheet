import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createStartupWatchdog,
  getCurrentPhase,
  getElapsedMs,
  getStartupLogPath,
  initStartupLog,
  startupLog,
  startupMark,
} from './startup-log.js';

// HS-8704 (option A — self-diagnosing launch): the installed beta app hung on
// the splash and, because it was launched from the Dock (no controlling
// terminal), produced NO logs. These tests pin the two halves of the fix:
//   1. The persisted timeline — markers land in `~/.hotsheet/startup.log` even
//      with no TTY, so the next hang is diagnosable from the file alone.
//   2. The escalating watchdog — it keeps firing and NAMES the stuck phase
//      (pre-fix it was a single 10s one-shot with no phase info).
describe('startup-log persisted timeline (HS-8704)', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hs-startup-log-'));
    logPath = join(dir, 'startup.log');
    process.env.HOTSHEET_STARTUP_LOG = logPath;
  });

  afterEach(() => {
    delete process.env.HOTSHEET_STARTUP_LOG;
    rmSync(dir, { recursive: true, force: true });
  });

  it('honors the HOTSHEET_STARTUP_LOG override', () => {
    expect(getStartupLogPath()).toBe(logPath);
  });

  it('defaults to ~/.hotsheet/startup.log when no override is set', () => {
    delete process.env.HOTSHEET_STARTUP_LOG;
    expect(getStartupLogPath()).toMatch(/[/\\]\.hotsheet[/\\]startup\.log$/);
  });

  it('writes a session header capturing argv, cwd, and TTY state', () => {
    initStartupLog(() => 1000);
    const contents = readFileSync(logPath, 'utf8');
    expect(contents).toContain('==== Hot Sheet startup');
    expect(contents).toContain('argv:');
    expect(contents).toContain('cwd:');
    expect(contents).toContain('tty:');
  });

  it('records phase markers to the file AND updates the current-phase tracker', () => {
    initStartupLog(() => 1000);
    startupMark('initializing DB', () => 1200);
    expect(getCurrentPhase()).toBe('initializing DB');
    const contents = readFileSync(logPath, 'utf8');
    // Elapsed is computed from the init clock: 1200 - 1000 = 200ms.
    expect(contents).toContain('[+200ms] initializing DB');
  });

  it('getElapsedMs reflects time since init', () => {
    initStartupLog(() => 5000);
    expect(getElapsedMs(() => 5350)).toBe(350);
  });

  it('appends across markers without clobbering earlier lines', () => {
    initStartupLog(() => 0);
    startupMark('phase one', () => 10);
    startupMark('phase two', () => 25);
    const contents = readFileSync(logPath, 'utf8');
    expect(contents).toContain('[+10ms] phase one');
    expect(contents).toContain('[+25ms] phase two');
    // Header + both markers all present in one file.
    expect(contents.indexOf('phase one')).toBeLessThan(contents.indexOf('phase two'));
  });

  it('startupLog writes arbitrary (non-phase) lines without changing the phase', () => {
    initStartupLog(() => 0);
    startupMark('the stuck phase', () => 5);
    startupLog('[startup] WARNING: not ready', () => 100);
    expect(getCurrentPhase()).toBe('the stuck phase');
    expect(readFileSync(logPath, 'utf8')).toContain('[startup] WARNING: not ready');
  });

  it('truncates an oversized existing log before starting a new session', () => {
    // Seed a >1 MB file, then init — it should be truncated, not appended to.
    writeFileSync(logPath, 'x'.repeat(1_000_001));
    initStartupLog(() => 0);
    expect(statSync(logPath).size).toBeLessThan(1_000_000);
    expect(readFileSync(logPath, 'utf8')).toContain('==== Hot Sheet startup');
  });

  it('never throws when the log path is unwritable (best-effort)', () => {
    // Point at a path whose parent cannot be created (a file used as a dir).
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'i am a file');
    process.env.HOTSHEET_STARTUP_LOG = join(blocker, 'nested', 'startup.log');
    expect(() => initStartupLog(() => 0)).not.toThrow();
    expect(() => startupMark('phase', () => 1)).not.toThrow();
    // Phase tracking still works even with file logging disabled.
    expect(getCurrentPhase()).toBe('phase');
  });
});

describe('createStartupWatchdog escalation (HS-8704)', () => {
  it('fires at 10s / 20s / 30s then every 30s, naming the stuck phase each time', () => {
    let now = 0;
    let phase = 'init';
    const logs: string[] = [];
    const scheduled: Array<{ fn: () => void; ms: number }> = [];

    const wd = createStartupWatchdog<number>({
      getElapsedMs: () => now,
      getCurrentPhase: () => phase,
      log: (m) => logs.push(m),
      schedule: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length - 1; },
      cancel: () => { /* no-op for this test */ },
    });

    wd.start();
    // First timer is armed for 10s.
    expect(scheduled[0].ms).toBe(10_000);

    // Fire #1 at t=10s while stuck in "init-project: initializing DB".
    now = 10_000;
    phase = 'init-project: initializing DB';
    scheduled[0].fn();
    expect(logs[0]).toContain('WARNING');
    expect(logs[0]).toContain('stuck in phase "init-project: initializing DB"');
    // First fire also emits the usual-suspects hint + the log-location note.
    expect(logs.some((l) => l.includes('Usual suspects'))).toBe(true);
    // Re-armed for the next 10s step (20s - 10s).
    expect(scheduled[1].ms).toBe(10_000);

    // Fire #2 at t=20s.
    now = 20_000;
    scheduled[1].fn();
    expect(logs.some((l) => l.includes('WARNING') && l.includes('20000ms'))).toBe(true);

    // Fire #3 at t=30s — severity escalates past WARNING.
    now = 30_000;
    scheduled[2].fn();
    const thirdFire = logs.find((l) => l.includes('30000ms'));
    expect(thirdFire).toContain('STILL HANGING');
    // Now it repeats every 30s.
    expect(scheduled[3].ms).toBe(30_000);
  });

  it('stop() cancels the pending timer', () => {
    const cancel = vi.fn();
    const wd = createStartupWatchdog<number>({
      getElapsedMs: () => 0,
      getCurrentPhase: () => 'x',
      log: () => { /* ignore */ },
      schedule: () => 42,
      cancel,
    });
    wd.start();
    wd.stop();
    expect(cancel).toHaveBeenCalledWith(42);
  });
});
