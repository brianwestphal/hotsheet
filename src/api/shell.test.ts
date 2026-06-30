/**
 * HS-8638 — shell command-execution typed-API module.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiCallOpts, type ApiTransport, setApiTransport } from './_runner.js';
import { execShellCommand, getRunningShellCommands, killShellCommand, RunningShellSchema } from './shell.js';

let lastCall: { path: string; opts: ApiCallOpts } | undefined;
function stub(result: unknown): void {
  setApiTransport(vi.fn<ApiTransport>((path, opts) => { lastCall = { path, opts }; return Promise.resolve(result); }));
}
afterEach(() => { setApiTransport(null as unknown as ApiTransport); lastCall = undefined; });

describe('shell domain (HS-8638)', () => {
  it('RunningShellSchema accepts ids, rejects a non-number id', () => {
    expect(RunningShellSchema.safeParse({ ids: [1, 2] }).success).toBe(true);
    expect(RunningShellSchema.safeParse({ ids: [] }).success).toBe(true);
    expect(RunningShellSchema.safeParse({ ids: ['x'] }).success).toBe(false);
  });

  it('getRunningShellCommands → GET /shell/running', async () => {
    stub({ ids: [42] });
    expect(await getRunningShellCommands()).toEqual({ ids: [42] });
    expect(lastCall).toEqual({ path: '/shell/running', opts: {} });
  });

  it('execShellCommand → POST /shell/exec (omits name when undefined)', async () => {
    stub({ id: 7 });
    expect(await execShellCommand('npm test')).toEqual({ id: 7 });
    expect(lastCall).toEqual({ path: '/shell/exec', opts: { method: 'POST', body: { command: 'npm test' } } });
    await execShellCommand('npm run build', 'Build');
    expect(lastCall).toEqual({ path: '/shell/exec', opts: { method: 'POST', body: { command: 'npm run build', name: 'Build' } } });
  });

  it('killShellCommand → POST /shell/kill { id }', async () => {
    stub({ ok: true });
    await killShellCommand(42);
    expect(lastCall).toEqual({ path: '/shell/kill', opts: { method: 'POST', body: { id: 42 } } });
  });
});
