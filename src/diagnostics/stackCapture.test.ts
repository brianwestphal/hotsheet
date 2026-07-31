// HS-9519 — the pure half of "name what is blocking the loop".
//
// The worker executes this command from an eval string, so the decision of WHAT to
// run has to be testable here; the worker only runs it.

import { describe, expect, it } from 'vitest';

import { buildStackCaptureCommand, isStackCaptureEnabled } from './stackCapture.js';

const LOG_DIR = '/tmp/hs-logs';
const NOW = Date.UTC(2026, 6, 31, 1, 2, 3);

describe('buildStackCaptureCommand', () => {
  it('uses `sample` on macOS — a NATIVE sampler, which is the whole point', () => {
    // The wedges here block inside SyncProcessRunner::Spawn / uv_run / PGLite WASM,
    // where a JS-level stack shows nothing. A JS-only capture would have answered
    // none of the 16 watchdog FATALs.
    const cmd = buildStackCaptureCommand('darwin', 4242, LOG_DIR, NOW);
    expect(cmd?.command).toBe('sample');
    expect(cmd?.args).toEqual(['4242', '2', '-file', cmd?.outPath]);
  });

  it('uses eu-stack on Linux', () => {
    const cmd = buildStackCaptureCommand('linux', 4242, LOG_DIR, NOW);
    expect(cmd?.command).toBe('eu-stack');
    expect(cmd?.args).toEqual(['-p', '4242']);
  });

  it('returns null on an unsupported platform rather than guessing', () => {
    expect(buildStackCaptureCommand('win32', 4242, LOG_DIR, NOW)).toBeNull();
  });

  it('refuses pid 0 and 1 — signalling those is catastrophic', () => {
    for (const pid of [0, 1, -1, 1.5]) {
      expect(buildStackCaptureCommand('darwin', pid, LOG_DIR, NOW), String(pid)).toBeNull();
    }
  });

  it('writes into the given log dir with a filesystem-safe timestamp', () => {
    const cmd = buildStackCaptureCommand('darwin', 42, LOG_DIR, NOW);
    expect(cmd?.outPath.startsWith(`${LOG_DIR}/watchdog-stack-`)).toBe(true);
    expect(cmd?.outPath).not.toContain(':'); // colons break paths on some filesystems
  });

  it('is BOUNDED — the capture must never delay the SIGKILL indefinitely', () => {
    // HS-9510: a sync child-process call needs a timeout, and the worker pairs this
    // with killSignal SIGKILL. The process is already wedged; the recovery is what
    // must not be held up.
    const cmd = buildStackCaptureCommand('darwin', 42, LOG_DIR, NOW);
    expect(cmd?.timeoutMs).toBeGreaterThan(0);
    expect(cmd?.timeoutMs).toBeLessThanOrEqual(15_000);
  });

  it('gives distinct paths for distinct wedges, so one capture cannot clobber another', () => {
    const a = buildStackCaptureCommand('darwin', 42, LOG_DIR, NOW);
    const b = buildStackCaptureCommand('darwin', 42, LOG_DIR, NOW + 60_000);
    expect(a?.outPath).not.toBe(b?.outPath);
  });
});

describe('isStackCaptureEnabled', () => {
  it('is ON by default — a wedge is the one moment the evidence exists', () => {
    expect(isStackCaptureEnabled({})).toBe(true);
  });

  it('is disabled only by an explicit 0', () => {
    expect(isStackCaptureEnabled({ HOTSHEET_WATCHDOG_STACK: '0' })).toBe(false);
    expect(isStackCaptureEnabled({ HOTSHEET_WATCHDOG_STACK: '1' })).toBe(true);
  });
});
