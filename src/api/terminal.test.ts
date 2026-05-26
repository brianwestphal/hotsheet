/**
 * HS-8630 — terminal typed-API module. Verifies the callers hit the right
 * path + method (and forward the cross-project `secret`) through the injected
 * transport, and that the response schemas accept a real payload / reject a
 * malformed one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiCallOpts, type ApiTransport, setApiTransport } from './_runner.js';
import {
  AnnotatedTerminalSchema, clearTerminalBell, createTerminal, destroyTerminal,
  ForegroundProcessSchema, getCommandSuggestions, getForegroundProcess, getTerminalStatus,
  killTerminal, listTerminals, openTerminalCwd, restartTerminal, TerminalListSchema,
  TerminalStatusSchema,
} from './terminal.js';

const annotated = {
  id: 'default', command: 'zsh', name: 'Shell',
  bellPending: false, notificationMessage: null, currentCwd: null,
  state: 'alive', exitCode: null, lastSpinnerAtMs: null, lastOutputAtMs: null,
};
const list = { configured: [annotated], dynamic: [], home: '/Users/x' };
const status = { state: 'alive', startedAt: 1, command: 'zsh', exitCode: null, cols: 80, rows: 24, scrollbackBytes: 0 };

let lastCall: { path: string; opts: ApiCallOpts } | undefined;
function stub(result: unknown): void {
  const t = vi.fn<ApiTransport>((path, opts) => { lastCall = { path, opts }; return Promise.resolve(result); });
  setApiTransport(t);
}

afterEach(() => { setApiTransport(null as unknown as ApiTransport); lastCall = undefined; });

describe('terminal schemas (HS-8630)', () => {
  it('accepts valid payloads and rejects malformed ones', () => {
    expect(TerminalListSchema.safeParse(list).success).toBe(true);
    expect(AnnotatedTerminalSchema.safeParse(annotated).success).toBe(true);
    expect(TerminalStatusSchema.safeParse(status).success).toBe(true);
    expect(ForegroundProcessSchema.safeParse({ command: 'claude', isShell: false, isExempt: false }).success).toBe(true);
    // Bad state enum.
    expect(AnnotatedTerminalSchema.safeParse({ ...annotated, state: 'zombie' }).success).toBe(false);
    // Annotation fields are optional (the client treats them so), but a
    // wrong-typed one still fails.
    expect(AnnotatedTerminalSchema.safeParse({ id: 'x', command: 'zsh' }).success).toBe(true);
    expect(AnnotatedTerminalSchema.safeParse({ ...annotated, bellPending: 'yes' }).success).toBe(false);
    // Missing the required `command` config field.
    expect(AnnotatedTerminalSchema.safeParse({ id: 'x', bellPending: false }).success).toBe(false);
    // Status with a wrong-typed field.
    expect(TerminalStatusSchema.safeParse({ ...status, cols: '80' }).success).toBe(false);
  });
});

describe('terminal callers route to the right endpoint (HS-8630)', () => {
  it('listTerminals → GET /terminal/list, forwarding secret', async () => {
    stub(list);
    expect(await listTerminals()).toEqual(list);
    expect(lastCall).toEqual({ path: '/terminal/list', opts: { secret: undefined } });
    await listTerminals('sek');
    expect(lastCall).toEqual({ path: '/terminal/list', opts: { secret: 'sek' } });
  });

  it('getTerminalStatus → GET /terminal/status?terminalId=', async () => {
    stub(status);
    await getTerminalStatus('default');
    expect(lastCall?.path).toBe('/terminal/status?terminalId=default');
  });

  it('getForegroundProcess → GET /terminal/foreground-process?terminalId=', async () => {
    stub({ command: 'claude', isShell: false, isExempt: false });
    await getForegroundProcess('default');
    expect(lastCall?.path).toBe('/terminal/foreground-process?terminalId=default');
  });

  it('getCommandSuggestions → GET /terminal/command-suggestions, unwrapped', async () => {
    stub({ suggestions: ['{{claudeCommand}}', '/bin/zsh'] });
    expect(await getCommandSuggestions()).toEqual(['{{claudeCommand}}', '/bin/zsh']);
    expect(lastCall?.path).toBe('/terminal/command-suggestions');
  });

  it('restartTerminal → POST /terminal/restart', async () => {
    stub({ ok: true });
    await restartTerminal('t1', 'sek');
    expect(lastCall).toEqual({ path: '/terminal/restart', opts: { method: 'POST', body: { terminalId: 't1' }, secret: 'sek' } });
  });

  it('killTerminal → POST /terminal/kill with signal', async () => {
    stub({ ok: true });
    await killTerminal('t1', 'SIGKILL');
    expect(lastCall).toEqual({ path: '/terminal/kill', opts: { method: 'POST', body: { terminalId: 't1', signal: 'SIGKILL' }, secret: undefined } });
  });

  it('createTerminal → POST /terminal/create (default empty body)', async () => {
    stub({ config: { id: 'dyn-1', command: 'zsh' } });
    await createTerminal();
    expect(lastCall).toEqual({ path: '/terminal/create', opts: { method: 'POST', body: {}, secret: undefined } });
    await createTerminal({ spawn: true, cwd: '/tmp' }, 'sek');
    expect(lastCall).toEqual({ path: '/terminal/create', opts: { method: 'POST', body: { spawn: true, cwd: '/tmp' }, secret: 'sek' } });
  });

  it('destroyTerminal / clearTerminalBell / openTerminalCwd → POST', async () => {
    stub({ ok: true });
    await destroyTerminal('t1', 'sek');
    expect(lastCall).toEqual({ path: '/terminal/destroy', opts: { method: 'POST', body: { terminalId: 't1' }, secret: 'sek' } });
    await clearTerminalBell('t1');
    expect(lastCall?.path).toBe('/terminal/clear-bell');
    await openTerminalCwd('/Users/x/proj');
    expect(lastCall).toEqual({ path: '/terminal/open-cwd', opts: { method: 'POST', body: { path: '/Users/x/proj' }, secret: undefined } });
  });

  it('rejects a list response that fails schema validation', async () => {
    stub({ configured: [{ ...annotated, state: 'bogus' }], dynamic: [], home: '/x' });
    await expect(listTerminals()).rejects.toThrow(/response shape mismatch/);
  });
});
