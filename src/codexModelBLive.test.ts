/**
 * HS-9431 — LOCAL-ONLY live integration test for codex model-B discovery, against
 * the REAL codex app-server daemon (like the live-GitHub tests, this skips unless
 * the environment provides the dependency — here, an already-running codex daemon).
 *
 * Why this exists: the model-B discovery bug (`thread/list` misses a fresh
 * in-memory thread → the drive never joins a just-launched `codex --remote`
 * terminal) sailed through the fake-based unit tests because the scripted server
 * couldn't reproduce the daemon's real persisted-vs-loaded distinction. This test
 * drives the ACTUAL daemon and would have caught it.
 *
 * HS-9438 extends it with the other half of the same real-daemon asymmetry: a fresh
 * loaded thread is discoverable but NOT resumable (`no rollout found`), which is why
 * the drive must adopt a discovered thread without depending on `thread/resume`.
 *
 * HS-9435 extends it further along the drive-protocol contract (still cost-free, no
 * LLM turn): it asserts the daemon's REAL `initialize` + `thread/start` responses
 * still parse through the PRODUCTION mapping functions (`threadIdFromResponse`,
 * `rolloutPathFromThreadPayload`) — the `codexAppServerMapping.test.ts` unit tests
 * only prove those parsers handle HAND-AUTHORED shapes; this proves they handle the
 * shape codex actually emits, catching a `thread/start` result reshape before the
 * drive silently fails to learn its thread id / rollout path. (The turn lifecycle —
 * `turn/start` → approval/elicitation → done — is a REAL-turn concern, covered by
 * the opt-in `src/codexApprovalLive.test.ts` and the schema-contract test
 * `src/codexApprovalSchemaContract.test.ts`; it is not reproducible cost-free.)
 *
 * Cost-free + side-effect-bounded: it only runs when the daemon socket ALREADY
 * exists (it never starts one, and never runs an LLM turn — the turn fan-out is
 * codex's own multi-client feature, separately verified by hand). It creates a
 * throwaway thread in a temp cwd and deletes it. In CI (no codex) the whole block
 * is skipped.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import { loadedThreadIdsFromResponse, pickThreadForCwd, rolloutPathFromThreadPayload, threadIdFromResponse, threadReadEntry } from './codexAppServerMapping.js';
import { codexDaemonSocketPath, type CodexTransport,connectCodexDaemon } from './codexDaemonTransport.js';

const daemonUp = existsSync(codexDaemonSocketPath());

describe.skipIf(!daemonUp)('model-B live discovery against the real codex daemon (HS-9431)', () => {
  const canon = (p: string): string => { try { return realpathSync.native(p); } catch { return p; } };
  let transport: CodexTransport | null = null;
  let createdThreadId: string | null = null;

  /** Minimal JSON-RPC client over the daemon transport. */
  function client(t: CodexTransport) {
    let idc = 0;
    const pending = new Map<number, (v: Record<string, unknown>) => void>();
    // Route responses (the onMessage handler pushed them into `msgs`).
    const onMsg = (raw: string): void => {
      try {
        const j = JSON.parse(raw) as { id?: number };
        const resolver = typeof j.id === 'number' ? pending.get(j.id) : undefined;
        if (resolver !== undefined && typeof j.id === 'number') { resolver(j); pending.delete(j.id); }
      } catch { /* non-JSON frame */ }
    };
    return {
      onMsg,
      req: (method: string, params: unknown): Promise<Record<string, unknown>> => {
        const id = ++idc;
        return new Promise((resolve, reject) => {
          pending.set(id, resolve);
          t.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
          const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, 30_000);
          timer.unref();
        });
      },
      note: (method: string, params: unknown): void => t.send(JSON.stringify({ jsonrpc: '2.0', method, params })),
    };
  }

  afterAll(async () => {
    if (transport !== null && createdThreadId !== null) {
      try { transport.send(JSON.stringify({ jsonrpc: '2.0', id: 9999, method: 'thread/delete', params: { threadId: createdThreadId } })); } catch { /* best effort */ }
      await new Promise((r) => { const t = setTimeout(r, 200); t.unref(); });
    }
    transport?.close();
  });

  it('a FRESH daemon thread (no turn yet) is discovered by cwd via loaded/list + thread/read', async () => {
    // Connect to the ALREADY-RUNNING daemon only — never start one (startDaemon → false).
    let onMsg: (raw: string) => void = () => { /* bound after the client exists */ };
    transport = await connectCodexDaemon(
      { onMessage: (t) => { onMsg(t); }, onClose: () => { /* ignore */ } },
      { startDaemon: () => Promise.resolve(false) },
    );
    // Re-gate defensively: if the socket vanished between the module check and now.
    if (transport === null) return;
    const c = client(transport);
    onMsg = c.onMsg;

    // HS-9435 — the drive's handshake: `initialize` must succeed (no error) before
    // any thread method is valid. A protocol/version drift would surface here first.
    const initRes = await c.req('initialize', { clientInfo: { name: 'hs-modelb-live', version: '0' } });
    expect(initRes.error).toBeUndefined();
    c.note('initialized', {});

    const cwd = mkdtempSync(join(tmpdir(), 'hs-mb-live-'));
    try {
      // Simulate the terminal: start a daemon-hosted thread pinned to `cwd` (what
      // `codex --remote -C <cwd>` does). It has NO turn, so it is LOADED but NOT in
      // the on-disk `thread/list` — the exact bug condition.
      const started = await c.req('thread/start', { cwd, sandbox: 'workspace-write', approvalPolicy: 'untrusted' });
      const threadId = ((started.result as { thread?: { id?: string } } | undefined)?.thread)?.id ?? null;
      createdThreadId = threadId;
      expect(threadId).toBeTruthy();
      // HS-9435 — the PRODUCTION parser must extract that same id from the REAL
      // response (the unit test only proves it handles hand-authored shapes).
      expect(threadIdFromResponse(started.result)).toBe(threadId);

      // Simulate the drive's discovery (the real Phase-1 sequence).
      const loaded = loadedThreadIdsFromResponse((await c.req('thread/loaded/list', {})).result);
      expect(loaded).toContain(threadId); // in-memory: present

      const entries = [];
      for (const id of loaded) {
        const read = await c.req('thread/read', { threadId: id, includeTurns: false }).catch(() => null);
        const entry = read === null ? null : threadReadEntry(id, read.result);
        if (entry !== null) entries.push({ ...entry, cwd: entry.cwd !== null ? canon(entry.cwd) : null });
      }
      // The fix: pick by realpath-normalized cwd → finds the fresh thread.
      expect(pickThreadForCwd(entries, canon(cwd))?.id).toBe(threadId);

      // HS-9438 — the SECOND half of the bug, and the reason discovery alone wasn't
      // enough: `thread/resume` on that same fresh thread FAILS, because the rollout
      // JSONL isn't written until the thread's first turn completes. The drive used to
      // treat that failure as "discovery didn't work" and fall back to its own
      // off-screen thread. Pin both facts so a codex change in either direction shows up.
      const reported = ((started.result as { thread?: { path?: string } } | undefined)?.thread)?.path ?? null;
      expect(reported).toBeTruthy(); // the daemon names a rollout path…
      // HS-9435 — and the PRODUCTION rollout parser must extract that same path from
      // the REAL response (a reshape here would break the §123 attach-gating).
      expect(rolloutPathFromThreadPayload(started.result)).toBe(reported);
      expect(existsSync(reported as string)).toBe(false); // …before the file exists
      const resumed = await c.req('thread/resume', { threadId, config: undefined });
      expect(resumed.error).toBeTruthy();
      expect(JSON.stringify(resumed.error)).toContain('no rollout found');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
