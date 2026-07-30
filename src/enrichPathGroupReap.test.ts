// HS-9509 — the PATH probe must not leak the shell's forks.
//
// HS-9391 fixed the HANG (an interactive shell ignores SIGTERM, so `timeout`'s
// default kill never landed and the sync call blocked forever). It did NOT fix the
// second symptom of the same root cause: an interactive zsh FORKS, and killing the
// direct child leaves the fork alive, reparented to init, forever. Measured on the
// dev machine 2026-07-30 — 17 stuck `/bin/zsh -ilc printf %s "$PATH"` processes,
// the oldest alive 4 days 18 hours.
//
// The fix spawns `detached` so the child leads its own process group, then signals
// the whole group by negative pid. Two things make this worth an integration test
// rather than an options-object assertion:
//
//  1. The leak happens on the SUCCESS path too. The shell prints PATH, exits 0, and
//     its fork lives on — so a test that only exercised failure would miss it.
//  2. `detached` is honoured by `spawnSync` at runtime but is absent from
//     @types/node's `SpawnSyncOptions`, i.e. we depend on undocumented behavior. If
//     a future Node stops honouring it, this test goes red instead of the app
//     silently resuming the leak.

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { enrichProcessPath } from './enrich-path.js';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch {
    return false;
  }
}

/** A killed process lingers as a zombie until init reaps it, so poll briefly
 *  rather than asserting on the instant after the signal. */
function waitForDeath(pid: number, timeoutMs = 5000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(wait, 0, 0, 50); // sync sleep — this test cannot await
  }
  return !isAlive(pid);
}

describe('HS-9509 — the PATH probe reaps the shell process group', () => {
  let dir = '';
  let grandchildPid = 0;

  afterEach(() => {
    // Never leave a stray `sleep` behind if the assertion failed.
    if (grandchildPid > 1 && isAlive(grandchildPid)) {
      try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* already gone */ }
    }
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  it('kills a fork the shell leaves behind, even when the probe SUCCEEDS', () => {
    if (process.platform === 'win32') return; // sh script + POSIX process groups

    dir = join(tmpdir(), `hs-9509-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const pidFile = join(dir, 'fork.pid');
    const fakeShell = join(dir, 'fakeshell');

    // Stands in for the interactive shell: forks a child that ignores SIGTERM
    // (exactly what made HS-9391 unkillable), records it, then succeeds normally.
    // The fork's stdio is redirected deliberately. A background job that inherits
    // the stdout PIPE keeps it open, and the parent waits on the pipe rather than
    // on the child — so leaving it attached makes the probe time out instead of
    // succeeding, and this test is specifically about the success path (verified:
    // with the pipe held, both attempts burn the full 2s timeout).
    writeFileSync(fakeShell, [
      '#!/bin/sh',
      '(trap "" TERM; sleep 45) >/dev/null 2>&1 &',
      `echo $! > ${pidFile}`,
      'printf %s "/hs-9509-probe:/usr/bin"',
      '',
    ].join('\n'));
    chmodSync(fakeShell, 0o755);

    const originalPath = process.env.PATH;
    try {
      enrichProcessPath({ shell: fakeShell });

      // The probe succeeded — PATH really was enriched from our fake shell.
      expect(process.env.PATH).toContain('/hs-9509-probe');

      grandchildPid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(grandchildPid).toBeGreaterThan(1);

      // The actual regression: before HS-9509 this fork outlived the process.
      expect(waitForDeath(grandchildPid)).toBe(true);
    } finally {
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    }
  }, 30_000);
});
