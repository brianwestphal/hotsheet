// HS-9554 — recognizing a trapped PGLite WASM instance.
//
// The 2026-08-01 watchdog SIGKILL: the loop spent 61.7 s constructing
// WebAssembly RuntimeErrors because a caller kept re-entering a module that was
// already permanently faulted. These tests pin the two halves of the fix — what
// counts as a trap, and that the replacement error is cheap to raise.

import { describe, expect, it } from 'vitest';

import { isWasmTrapError, PoisonedClusterError } from './wasmTrap.js';

/** WebAssembly.RuntimeError is not constructible as a plain Error subclass in a
 *  way that reproduces V8's shape, so build the observed shape directly: the
 *  message is often bare (`unreachable`) and the identity is in `.name`. */
function wasmError(message: string, name = 'RuntimeError'): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe('isWasmTrapError', () => {
  it('matches a bare `unreachable` RuntimeError — the variant message-only matching missed', () => {
    // HS-7889 hit exactly this: the message carries no "RuntimeError" text at all,
    // so a substring check on the message alone returns false and the trap sails
    // through. It reappeared as this incident.
    const err = wasmError('unreachable');
    expect(err.message).not.toContain('RuntimeError');
    expect(isWasmTrapError(err)).toBe(true);
  });

  it('matches emscriptens production abort and the memory traps', () => {
    for (const message of [
      'Aborted(native code called abort())',
      'memory access out of bounds',
      'out of bounds memory access',
      'Cannot allocate Wasm memory for new instance',
      'null function or function signature mismatch',
    ]) {
      expect(isWasmTrapError(new Error(message)), message).toBe(true);
    }
  });

  it('matches a RuntimeError wrapped into another errors message', () => {
    expect(isWasmTrapError(new Error('query failed: RuntimeError: unreachable'))).toBe(true);
  });

  it('does NOT match a closed instance — that one heals by reopening', () => {
    // The ordering in the query proxy depends on this: if a closed-instance error
    // were treated as a trap, HS-9461's healing would stop working and every
    // eviction mid-request would surface to the user as a failure.
    expect(isWasmTrapError(new Error('PGlite is closed'))).toBe(false);
    expect(isWasmTrapError(new Error('PGlite is closing'))).toBe(false);
  });

  it('does NOT match ordinary SQL or filesystem errors', () => {
    for (const message of [
      'relation "tickets" does not exist',
      'duplicate key value violates unique constraint',
      "ENOENT: no such file or directory, open '/tmp/x'",
      'EACCES: permission denied',
      'ENOSPC: no space left on device',
    ]) {
      expect(isWasmTrapError(new Error(message)), message).toBe(false);
    }
  });

  it('handles non-Error throws without crashing the error path', () => {
    // This runs inside a catch block; throwing from the predicate would replace a
    // recoverable failure with an unhandled rejection.
    expect(isWasmTrapError(null)).toBe(false);
    expect(isWasmTrapError(undefined)).toBe(false);
    expect(isWasmTrapError(42)).toBe(false);
    expect(isWasmTrapError({})).toBe(false);
    expect(isWasmTrapError('RuntimeError: unreachable')).toBe(true);
  });
});

describe('PoisonedClusterError', () => {
  it('names the cluster and the real cause', () => {
    const err = new PoisonedClusterError('/x/.hotsheet/db');
    expect(err.dbPath).toBe('/x/.hotsheet/db');
    expect(err.message).toContain('/x/.hotsheet/db');
    expect(err.message).toContain('trapped');
    expect(err.name).toBe('PoisonedClusterError');
    expect(err instanceof Error).toBe(true);
  });

  it('does NOT capture a stack — stack capture is what wedged the loop', () => {
    // The failure mode was hundreds of stack captures on a hot path. An error
    // raised once per row to REPLACE that must not reintroduce it.
    const err = new PoisonedClusterError('/x/.hotsheet/db');
    expect(err.stack).toBe(`${err.name}: ${err.message}`);
    expect(err.stack).not.toContain('\n    at ');
  });

  it('preserves the originating trap as `cause`', () => {
    const trap = wasmError('unreachable');
    expect(new PoisonedClusterError('/x/db', trap).cause).toBe(trap);
  });
});
