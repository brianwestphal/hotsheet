/**
 * HS-8790 — the Apple Foundation Models provider: availability probing (gated on
 * macOS + a present helper binary + a passing probe) and the summarize subprocess
 * contract. The actual Swift helper + on-device run are verified on a desktop;
 * here the process runner + platform are injected.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  _resetAppleFoundationForTesting, _setAppleFoundationForTesting,
  appleFmBinPath, isAppleFoundationAvailable, runAppleFoundationSummarize,
} from './appleFoundation.js';

// `process.execPath` (the node binary) always exists on disk, so it's a handy
// stand-in for "the helper binary is present" without writing a temp file.
const PRESENT_BIN = process.execPath;

/** Point the `<cwd>/apple-fm-helper` fallback at an empty dir so "no binary"
 *  cases hold even when a real helper has been built at the repo root. */
function cwdWithoutHelper(): void {
  vi.spyOn(process, 'cwd').mockReturnValue('/nonexistent-hotsheet-test-dir');
}

afterEach(() => {
  _resetAppleFoundationForTesting();
  delete process.env.HOTSHEET_APPLE_FM_BIN;
  vi.restoreAllMocks();
});

describe('appleFmBinPath', () => {
  it('resolves the env var when it points at an existing file', () => {
    process.env.HOTSHEET_APPLE_FM_BIN = PRESENT_BIN;
    expect(appleFmBinPath()).toBe(PRESENT_BIN);
  });

  it('is null when the env path does not exist and there is no fallback', () => {
    process.env.HOTSHEET_APPLE_FM_BIN = '/no/such/apple-fm-helper-xyz';
    cwdWithoutHelper();
    expect(appleFmBinPath()).toBeNull();
  });
});

describe('isAppleFoundationAvailable', () => {
  it('is false on non-macOS regardless of the binary', () => {
    process.env.HOTSHEET_APPLE_FM_BIN = PRESENT_BIN;
    _setAppleFoundationForTesting({ darwin: false, runner: () => Promise.resolve({ stdout: 'available', code: 0 }) });
    return expect(isAppleFoundationAvailable()).resolves.toBe(false);
  });

  it('is false on macOS when no helper binary is present', () => {
    cwdWithoutHelper();
    _setAppleFoundationForTesting({ darwin: true });
    return expect(isAppleFoundationAvailable()).resolves.toBe(false);
  });

  it('is true on macOS when the helper probe reports "available"', async () => {
    process.env.HOTSHEET_APPLE_FM_BIN = PRESENT_BIN;
    _setAppleFoundationForTesting({ darwin: true, runner: () => Promise.resolve({ stdout: 'available\n', code: 0 }) });
    expect(await isAppleFoundationAvailable()).toBe(true);
  });

  it('is false when the probe reports anything else or fails', async () => {
    process.env.HOTSHEET_APPLE_FM_BIN = PRESENT_BIN;
    _setAppleFoundationForTesting({ darwin: true, runner: () => Promise.resolve({ stdout: 'unavailable', code: 0 }) });
    expect(await isAppleFoundationAvailable()).toBe(false);

    _setAppleFoundationForTesting({ darwin: true, runner: () => Promise.reject(new Error('spawn failed')) });
    expect(await isAppleFoundationAvailable()).toBe(false);
  });

  it('caches the result (probe runs once)', async () => {
    process.env.HOTSHEET_APPLE_FM_BIN = PRESENT_BIN;
    let calls = 0;
    _setAppleFoundationForTesting({ darwin: true, runner: () => { calls++; return Promise.resolve({ stdout: 'available', code: 0 }); } });
    await isAppleFoundationAvailable();
    await isAppleFoundationAvailable();
    expect(calls).toBe(1);
  });
});

describe('runAppleFoundationSummarize', () => {
  it('passes {system, material} on stdin and returns the helper stdout', async () => {
    process.env.HOTSHEET_APPLE_FM_BIN = PRESENT_BIN;
    let seenStdin = '';
    let seenArgs: string[] = [];
    _setAppleFoundationForTesting({
      darwin: true,
      runner: (_bin, args, stdin) => { seenArgs = args; seenStdin = stdin; return Promise.resolve({ stdout: '{"entries":[]}', code: 0 }); },
    });
    const out = await runAppleFoundationSummarize('SYS', 'MAT');
    expect(out).toBe('{"entries":[]}');
    expect(seenArgs).toEqual(['--summarize']);
    expect(JSON.parse(seenStdin)).toEqual({ system: 'SYS', material: 'MAT' });
  });

  it('throws when the helper exits non-zero', async () => {
    process.env.HOTSHEET_APPLE_FM_BIN = PRESENT_BIN;
    _setAppleFoundationForTesting({ darwin: true, runner: () => Promise.resolve({ stdout: '', code: 3 }) });
    await expect(runAppleFoundationSummarize('s', 'm')).rejects.toThrow(/exited with code 3/);
  });

  it('surfaces the helper stderr reason in the error (HS-8883)', async () => {
    // The Swift helper writes its diagnostic to stderr (e.g. code 4 =
    // "inference failed: <error>"); discarding it left only a bare exit code,
    // so the soft-failure log couldn't say WHY narration failed.
    process.env.HOTSHEET_APPLE_FM_BIN = PRESENT_BIN;
    _setAppleFoundationForTesting({
      darwin: true,
      runner: () => Promise.resolve({ stdout: '', code: 4, stderr: 'inference failed: exceededContextWindowSize\n' }),
    });
    await expect(runAppleFoundationSummarize('s', 'm')).rejects.toThrow(
      /exited with code 4: inference failed: exceededContextWindowSize/,
    );
  });

  it('omits the trailing colon when the helper provides no stderr', async () => {
    process.env.HOTSHEET_APPLE_FM_BIN = PRESENT_BIN;
    _setAppleFoundationForTesting({ darwin: true, runner: () => Promise.resolve({ stdout: '', code: 4, stderr: '   ' }) });
    await expect(runAppleFoundationSummarize('s', 'm')).rejects.toThrow(/exited with code 4$/);
  });

  it('throws when no helper binary is present', async () => {
    process.env.HOTSHEET_APPLE_FM_BIN = '/no/such/bin';
    cwdWithoutHelper();
    _setAppleFoundationForTesting({ darwin: true });
    await expect(runAppleFoundationSummarize('s', 'm')).rejects.toThrow(/not found/);
  });
});
