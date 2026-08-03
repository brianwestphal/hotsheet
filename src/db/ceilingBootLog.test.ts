/**
 * HS-9560 — the cluster-budget ceiling has to reach the startup log.
 *
 * `describeExternalCeiling()` exists for exactly one reason: `usedPctOfCeiling`
 * in a freeze log is uninterpretable without knowing the denominator. It was
 * emitted with `console.error`, and on a GUI launch the server child's stderr
 * has no terminal — so the one line whose whole job is to make the denominator
 * visible was the one line you could not see. `~/.hotsheet/startup.log`, which
 * that same startup path calls "the only record" for a GUI launch, never got it.
 *
 * Asserting on the FILE rather than on a `console.error` spy is the point: a spy
 * would have passed for the entire time the bug existed.
 */
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initStartupLog } from '../startup-log.js';
import { startClusterEvictionTimer, stopClusterEvictionTimer } from './connection.js';

let dir: string;
let logPath: string;
const priorEnv = process.env.HOTSHEET_STARTUP_LOG;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hs-9560-'));
  logPath = join(dir, 'startup.log');
  process.env.HOTSHEET_STARTUP_LOG = logPath;
  initStartupLog();
});

afterEach(() => {
  stopClusterEvictionTimer();
  if (priorEnv === undefined) delete process.env.HOTSHEET_STARTUP_LOG;
  else process.env.HOTSHEET_STARTUP_LOG = priorEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe('cluster budget ceiling boot line (HS-9560)', () => {
  it('lands in the startup log, the only record a GUI launch has', () => {
    startClusterEvictionTimer();
    expect(readFileSync(logPath, 'utf-8')).toContain('PGLite cluster budget ceiling');
  });

  it('records the denominator AND the two inputs it was derived from', () => {
    // Without the machine RAM and the V8 limit beside it, a reader cannot tell a
    // deliberate budget from an inherited default — which is precisely how a V8
    // default masqueraded as a chosen ceiling across three incidents (docs/128).
    startClusterEvictionTimer();
    const line = readFileSync(logPath, 'utf-8');
    expect(line).toMatch(/PGLite cluster budget ceiling: \d+MB/);
    expect(line).toContain('machine RAM');
    expect(line).toContain('V8 heap limit');
  });

  it('is written once per boot, not once per sweep', () => {
    // It is a constant for the process lifetime; repeating it would push the real
    // startup timeline out of the size-capped log.
    startClusterEvictionTimer();
    startClusterEvictionTimer(); // idempotent — the timer is already running
    const occurrences = readFileSync(logPath, 'utf-8').split('PGLite cluster budget ceiling').length - 1;
    expect(occurrences).toBe(1);
  });
});
