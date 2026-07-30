// HS-9359 — the Codex permission hook: codex-specific decision shapes + auto-allow
// of Hot Sheet's own control-plane tools, riding the shared IO-injected flow
// (`antigravityPermissionHook.ts::runPermissionHook`).
import { describe, expect, it } from 'vitest';

import { type PermissionHookIO, runPermissionHook } from './aiTools/permissionHook.js';
import { antigravityHookAdapter } from './antigravityPermissionHook.js';
import { codexDecisionJson, codexHookAdapter, isHotsheetControlTool } from './codexPermissionHook.js';

describe('codexDecisionJson', () => {
  it('PermissionRequest uses the decision.{behavior} shape (verified live on 0.145.0)', () => {
    expect(JSON.parse(codexDecisionJson('allow', 'PermissionRequest'))).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(JSON.parse(codexDecisionJson('deny', 'PermissionRequest'))).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } },
    });
  });

  it('PreToolUse uses the permissionDecision shape (same as agy/Claude)', () => {
    expect(JSON.parse(codexDecisionJson('deny', 'PreToolUse'))).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    });
  });
});

describe('isHotsheetControlTool', () => {
  it('matches the underscore-normalized MCP ids and bare tool names', () => {
    expect(isHotsheetControlTool('mcp__hotsheet_channel__hotsheet_query_tickets')).toBe(true); // verified live shape
    expect(isHotsheetControlTool('mcp__hotsheet-channel__hotsheet_signal_done')).toBe(true);
    expect(isHotsheetControlTool('hotsheet_update_ticket')).toBe(true);
  });
  it('does not match other tools', () => {
    expect(isHotsheetControlTool('Bash')).toBe(false);
    expect(isHotsheetControlTool('mcp__filesystem__read_file')).toBe(false);
  });
});

function makeIO(payload: unknown, overrides: Partial<PermissionHookIO> = {}): { io: PermissionHookIO; out: string[]; fetches: string[] } {
  const out: string[] = [];
  const fetches: string[] = [];
  const io: PermissionHookIO = {
    readStdin: () => Promise.resolve(JSON.stringify(payload)),
    channelBaseUrl: () => 'http://localhost:9999',
    writeStdout: (s) => out.push(s),
    fetchFn: ((url: string) => {
      fetches.push(url);
      return Promise.resolve(new Response(JSON.stringify({ decided: true, behavior: 'deny' }), { status: 200 }));
    }) as unknown as typeof fetch,
    now: () => 0,
    sleep: () => Promise.resolve(),
    newRequestId: () => 'req-1',
    ...overrides,
  };
  return { io, out, fetches };
}

describe('runPermissionHook with codexHookAdapter', () => {
  it('auto-allows hotsheet control-plane MCP calls without touching the overlay', async () => {
    const { io, out, fetches } = makeIO({
      hook_event_name: 'PermissionRequest',
      tool_name: 'mcp__hotsheet_channel__hotsheet_signal_done',
    });
    const code = await runPermissionHook(io, codexHookAdapter(), 1000);
    expect(code).toBe(0);
    expect(fetches).toEqual([]); // no inject, no poll — instant allow
    expect(JSON.parse(out[0])).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  });

  it('routes a Bash PreToolUse through the overlay and emits the deny with EXIT 0 (codex quirk)', async () => {
    const { io, out, fetches } = makeIO({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
    const code = await runPermissionHook(io, codexHookAdapter(), 1000);
    // Codex treats a non-zero hook exit as "hook failed, proceed" — the deny MUST
    // ride the stdout JSON with exit 0 (verified live: exit 2 did not block).
    expect(code).toBe(0);
    expect(fetches.some(u => u.includes('/permission/inject'))).toBe(true);
    expect(JSON.parse(out[0])).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    });
  });

  it('labels the overlay request as Codex', async () => {
    let injectedBody = '';
    const { io } = makeIO({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }, {
      fetchFn: ((url: string, init?: { body?: string }) => {
        if (url.includes('/permission/inject')) injectedBody = init?.body ?? '';
        return Promise.resolve(new Response(JSON.stringify({ decided: true, behavior: 'allow' }), { status: 200 }));
      }) as unknown as typeof fetch,
    });
    await runPermissionHook(io, codexHookAdapter(), 1000);
    expect(injectedBody).toContain('Codex wants to use Bash');
  });

  it('an allow decision emits the event-matched allow shape', async () => {
    const { io, out } = makeIO({ hook_event_name: 'PermissionRequest', tool_name: 'mcp__filesystem__write' }, {
      fetchFn: (() => Promise.resolve(new Response(JSON.stringify({ decided: true, behavior: 'allow' }), { status: 200 }))) as unknown as typeof fetch,
    });
    const code = await runPermissionHook(io, codexHookAdapter(), 1000);
    expect(code).toBe(0);
    expect(JSON.parse(out[0])).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  });

  // HS-9506 — the contrast is the point, which is why this agy case lives beside the
  // codex ones: the SAME deny must exit 2 for agy and 0 for codex. codex reads any
  // non-zero exit as "the hook failed, proceed", so an agent that inherited agy's exit
  // code would silently stop denying anything. Previously agy's shape was the module
  // DEFAULT and this test passed no adapter at all; now both are explicit adapters.
  it('agy and codex differ on exit code for the same deny (agy: exit 2, PreToolUse shape)', async () => {
    const { io, out } = makeIO({ tool_name: 'Bash' });
    const code = await runPermissionHook(io, antigravityHookAdapter(), 1000);
    expect(code).toBe(2);
    expect(JSON.parse(out[0])).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    });
  });
});
