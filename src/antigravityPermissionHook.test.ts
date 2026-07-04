// HS-9327 — the Antigravity PreToolUse permission hook logic (IO fully injected).
import { describe, expect, it } from 'vitest';

import { decisionJson, type PermissionHookIO, runPermissionHook } from './antigravityPermissionHook.js';

interface Opts {
  base?: string | null;
  stdin?: string;
  injectOk?: boolean;
  /** Poll returns "decided" only from the Nth poll onward (0 = immediately). */
  decideAfterPolls?: number;
  behavior?: 'allow' | 'deny';
  /** true → decision never comes (for the timeout path). */
  neverDecide?: boolean;
}

function makeIo(o: Opts = {}): { io: PermissionHookIO; out: string[]; urls: string[] } {
  const out: string[] = [];
  const urls: string[] = [];
  let polls = 0;
  let clock = 0;
  const fetchFn = ((url: string): Promise<Response> => {
    urls.push(url);
    if (url.includes('/permission/inject')) {
      return (o.injectOk ?? true) ? Promise.resolve({} as Response) : Promise.reject(new Error('down'));
    }
    polls += 1;
    const decided = !(o.neverDecide ?? false) && polls > (o.decideAfterPolls ?? 0);
    return Promise.resolve({ json: () => Promise.resolve({ decided, behavior: decided ? (o.behavior ?? 'allow') : null }) } as unknown as Response);
  }) as unknown as typeof fetch;
  const io: PermissionHookIO = {
    readStdin: () => Promise.resolve(o.stdin ?? JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })),
    channelBaseUrl: () => (o.base === undefined ? 'http://localhost:5000' : o.base),
    writeStdout: (s) => out.push(s),
    fetchFn,
    now: () => clock,
    sleep: () => { clock += 5; return Promise.resolve(); }, // advance the clock so timeouts terminate
    newRequestId: () => 'req-1',
  };
  return { io, out, urls };
}

describe('runPermissionHook', () => {
  it('ALLOW: injects, polls, and emits allow (exit 0)', async () => {
    const { io, out, urls } = makeIo({ behavior: 'allow' });
    expect(await runPermissionHook(io)).toBe(0);
    expect(out.at(-1)).toBe(decisionJson('allow'));
    expect(urls.some(u => u.includes('/permission/inject'))).toBe(true);
    expect(urls.some(u => u.includes('/permission/decision?request_id=req-1'))).toBe(true);
  });

  it('DENY: a deny decision → exit 2 + deny JSON', async () => {
    const { io, out } = makeIo({ behavior: 'deny' });
    expect(await runPermissionHook(io)).toBe(2);
    expect(out.at(-1)).toBe(decisionJson('deny'));
  });

  it('polls repeatedly until the user answers', async () => {
    const { io, urls } = makeIo({ behavior: 'allow', decideAfterPolls: 3 });
    expect(await runPermissionHook(io)).toBe(0);
    expect(urls.filter(u => u.includes('/permission/decision')).length).toBe(4); // 3 pending + 1 decided
  });

  it('FAIL-OPEN when the channel is unresolved (no inject, allow)', async () => {
    const { io, out, urls } = makeIo({ base: null });
    expect(await runPermissionHook(io)).toBe(0);
    expect(out.at(-1)).toBe(decisionJson('allow'));
    expect(urls).toHaveLength(0); // never touched the network
  });

  it('FAIL-OPEN when the inject POST fails (allow)', async () => {
    const { io, out } = makeIo({ injectOk: false });
    expect(await runPermissionHook(io)).toBe(0);
    expect(out.at(-1)).toBe(decisionJson('allow'));
  });

  it('FAIL-CLOSED (deny) when no answer arrives before the timeout', async () => {
    const { io, out } = makeIo({ neverDecide: true });
    expect(await runPermissionHook(io, 20)).toBe(2); // clock advances +5 per sleep → exits past 20
    expect(out.at(-1)).toBe(decisionJson('deny'));
  });

  it('treats unparseable stdin as a bare tool (still gates)', async () => {
    const { io } = makeIo({ stdin: 'not json', behavior: 'allow' });
    expect(await runPermissionHook(io)).toBe(0);
  });
});
