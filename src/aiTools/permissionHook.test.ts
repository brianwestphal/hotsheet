// HS-9506 (docs/132 §132.9.1) — the host half of the §47 permission bridge.
//
// The FLOW itself (inject → poll → fail-open/fail-closed) is exercised through both
// real adapters, in `antigravityPermissionHook.test.ts` and `codexPermissionHook.test.ts`
// — driving it through the actual adapters is what proves the split is right, so it is
// deliberately not re-tested here against a synthetic one. What IS here is the toolkit's
// own surface: the shared wire shape, and the real-IO block that used to be duplicated.

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { claudeStyleDecisionJson, realPermissionHookIo } from './permissionHook.js';

describe('claudeStyleDecisionJson', () => {
  it('emits the hookSpecificOutput permissionDecision shape, echoing the event name', () => {
    expect(JSON.parse(claudeStyleDecisionJson('allow', 'PreToolUse'))).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    });
    expect(JSON.parse(claudeStyleDecisionJson('deny', 'SomeOtherEvent'))).toEqual({
      hookSpecificOutput: { hookEventName: 'SomeOtherEvent', permissionDecision: 'deny' },
    });
  });
});

describe('realPermissionHookIo (HS-9506)', () => {
  let originalCwd = '';
  let dir = '';

  afterEach(() => {
    if (originalCwd !== '') process.chdir(originalCwd);
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
    originalCwd = '';
    dir = '';
  });

  it('resolves the channel URL from the CWD project, and returns null when there is none', () => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'hs-9506-'));
    process.chdir(dir);

    const io = realPermissionHookIo();

    // No `.hotsheet/` here, so there is no channel to reach. Returning null (rather
    // than a URL pointing at nothing) is what drives `runPermissionHook`'s FAIL-OPEN
    // branch — the agent proceeds instead of wedging on a Hot Sheet that isn't there.
    expect(io.channelBaseUrl()).toBeNull();
  });

  it('supplies a complete IO surface, so no adapter has to fill gaps itself', () => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'hs-9506-'));
    process.chdir(dir);

    const io = realPermissionHookIo();

    // The point of the helper is that a tool plugin supplies ONLY its adapter. If a
    // field went missing, each tool would quietly start hand-rolling it again, which
    // is precisely how the duplication this replaced came about.
    expect(typeof io.readStdin).toBe('function');
    expect(typeof io.channelBaseUrl).toBe('function');
    expect(typeof io.writeStdout).toBe('function');
    expect(typeof io.fetchFn).toBe('function');
    expect(typeof io.sleep).toBe('function');
    expect(typeof io.newRequestId).toBe('function');
    expect(io.now()).toBeGreaterThan(0);
    // Request ids must be unique per call — two hook runs racing on one channel would
    // otherwise collide and read each other's decision.
    expect(io.newRequestId()).not.toBe(io.newRequestId());
  });
});
