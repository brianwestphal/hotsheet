// HS-9519 — the pure half of "name what is blocking the loop".
//
// The worker executes this command from an eval string, so the decision of WHAT to
// run has to be testable here; the worker only runs it.

import { describe, expect, it } from 'vitest';

import { buildStackCaptureCommand, CAPTURED_AT_PLACEHOLDER, isStackCaptureEnabled } from './stackCapture.js';

const LOG_DIR = '/tmp/hs-logs';

describe('buildStackCaptureCommand', () => {
  it('uses `sample` on macOS — a NATIVE sampler, which is the whole point', () => {
    // The wedges here block inside SyncProcessRunner::Spawn / uv_run / PGLite WASM,
    // where a JS-level stack shows nothing. A JS-only capture would have answered
    // none of the 16 watchdog FATALs.
    const cmd = buildStackCaptureCommand('darwin', 4242, LOG_DIR);
    expect(cmd?.command).toBe('sample');
    expect(cmd?.args).toEqual(['4242', '2', '-file', cmd?.outPath]);
  });

  it('uses eu-stack on Linux', () => {
    const cmd = buildStackCaptureCommand('linux', 4242, LOG_DIR);
    expect(cmd?.command).toBe('eu-stack');
    expect(cmd?.args).toEqual(['-p', '4242']);
  });

  it('returns null on an unsupported platform rather than guessing', () => {
    expect(buildStackCaptureCommand('win32', 4242, LOG_DIR)).toBeNull();
  });

  it('refuses pid 0 and 1 — signalling those is catastrophic', () => {
    for (const pid of [0, 1, -1, 1.5]) {
      expect(buildStackCaptureCommand('darwin', pid, LOG_DIR), String(pid)).toBeNull();
    }
  });

  it('writes into the given log dir', () => {
    const cmd = buildStackCaptureCommand('darwin', 42, LOG_DIR);
    expect(cmd?.outPath.startsWith(`${LOG_DIR}/watchdog-stack-`)).toBe(true);
    expect(cmd?.outPath).not.toContain(':'); // colons break paths on some filesystems
  });

  it('is BOUNDED — the capture must never delay the SIGKILL indefinitely', () => {
    // HS-9510: a sync child-process call needs a timeout, and the worker pairs this
    // with killSignal SIGKILL. The process is already wedged; the recovery is what
    // must not be held up.
    const cmd = buildStackCaptureCommand('darwin', 42, LOG_DIR);
    expect(cmd?.timeoutMs).toBeGreaterThan(0);
    expect(cmd?.timeoutMs).toBeLessThanOrEqual(15_000);
  });

  // HS-9554 — this replaces a test that passed while the bug was live.
  //
  // The old version built the command twice with two different `now` values and
  // asserted the paths differed. They did — but production builds the command
  // ONCE, at watchdog start, and reuses it for every wedge in that process. So
  // the parameter the test varied is the one production holds constant, and the
  // property it "proved" (distinct wedges get distinct files) was false: the
  // 2026-08-01 wedge wrote to a path stamped 26 hours earlier, over the previous
  // capture. The timestamp has to come from the worker at capture time, so what
  // is testable here is that the builder leaves a slot for it.
  it('leaves the timestamp to capture time rather than baking in build time', () => {
    const cmd = buildStackCaptureCommand('darwin', 42, LOG_DIR);
    expect(cmd?.outPath).toContain(CAPTURED_AT_PLACEHOLDER);
    // The sampler is told the same path, so the worker's substitution has to hit
    // the argv too — writing to one path and reporting another is how a capture
    // goes missing.
    expect(cmd?.args).toContain(cmd?.outPath);
  });

  it('is stable across calls — the command is built once and reused', () => {
    const a = buildStackCaptureCommand('darwin', 42, LOG_DIR);
    const b = buildStackCaptureCommand('darwin', 42, LOG_DIR);
    expect(a?.outPath).toBe(b?.outPath);
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
