/**
 * HS-9498 — the shared lazily-resolving `exec` / `execFile` helpers, and the guard
 * that stops the module-scope-`promisify` trap coming back.
 *
 * The trap: `const execFileAsync = promisify(execFile)` at module scope throws when
 * `execFile` is absent, so any test that PARTIALLY mocks `child_process` — naming only
 * the exports it uses — dies at import the moment such a module is anywhere in its
 * dependency graph. Transitive, non-local, and fatal to the whole file rather than a
 * case: `routes/dashboard.test.ts` and `routes/shell.test.ts` were both red from
 * 2026-07-27 because of a memory probe (docs/131) they have nothing to do with.
 *
 * It bit twice before this (HS-8723, then HS-9498), each time fixed by adding the
 * missing export to the one mock that noticed. `lazyChildProcessImport.test.ts` is the
 * version that doesn't need anyone to notice; this file covers the helpers themselves.
 */
import { describe, expect, it } from 'vitest';

import { execAsync, execFileAsync } from './execAsync.js';

describe('execAsync / execFileAsync (HS-9498)', () => {
  it('execAsync runs a command and returns its stdout', async () => {
    const { stdout } = await execAsync('echo hello-exec');
    expect(stdout.trim()).toBe('hello-exec');
  });

  it('execFileAsync runs a file with args and returns its stdout', async () => {
    const { stdout } = await execFileAsync('echo', ['hello-execfile']);
    expect(stdout.trim()).toBe('hello-execfile');
  });

  it('rejects on a non-zero exit rather than resolving with a status', async () => {
    // Every caller's error handling assumes this shape — `promisify(exec)` rejects,
    // it does not hand back a code.
    await expect(execFileAsync('sh', ['-c', 'exit 3'])).rejects.toThrow();
  });

  it('rejects on a missing binary', async () => {
    await expect(execFileAsync('definitely-not-a-real-binary-9498')).rejects.toThrow();
  });

  it('honors the timeout option', async () => {
    await expect(execAsync('sleep 5', { timeout: 150 })).rejects.toThrow();
  });

  it('returns stderr separately from stdout', async () => {
    const { stdout, stderr } = await execAsync('echo out; echo err 1>&2');
    expect(stdout.trim()).toBe('out');
    expect(stderr.trim()).toBe('err');
  });
});
