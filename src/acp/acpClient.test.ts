import { describe, expect, it, vi } from 'vitest';

import { type AcpTransport, createAcpClient } from './acpClient.js';

// HS-9330 — the ACP session driver, exercised end-to-end against a MOCK transport
// replaying the REAL opencode message shapes captured by the spike (docs/114
// §114.11). No spawn, no auth, no LLM turn — the transport is injected.

/** A mock transport that records outgoing lines and lets the test feed agent bytes. */
function makeHarness() {
  const sentRaw: string[] = [];
  const transport: AcpTransport = {
    send: (line: string) => { sentRaw.push(line); },
    close: vi.fn(),
  };
  return {
    transport,
    /** Parsed view of the i-th outgoing message. */
    sent: (i: number) => JSON.parse(sentRaw[i]) as Record<string, unknown>,
    count: () => sentRaw.length,
  };
}

/** Flush the microtask + timer queue so awaited continuations run. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('createAcpClient.runPrompt (HS-9330)', () => {
  it('drives initialize → session/new → session/prompt and resolves on stopReason', async () => {
    const h = makeHarness();
    const onBusy = vi.fn();
    const onTurnEnd = vi.fn();
    const client = createAcpClient(h.transport, { onBusy, onTurnEnd });
    const feed = (o: unknown): void => { client.receive(JSON.stringify(o) + '\n'); };

    const done = client.runPrompt('/repo', 'process the worklist');

    // 1) initialize sent first.
    await tick();
    const init = h.sent(0);
    expect(init.method).toBe('initialize');
    expect((init.params as { protocolVersion: number }).protocolVersion).toBe(1);
    feed({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1, agentInfo: { name: 'OpenCode', version: '1.17.9' } } });

    // 2) session/new next — with the hotsheet stdio MCP server entry.
    await tick();
    const sn = h.sent(1);
    expect(sn.method).toBe('session/new');
    const params = sn.params as { cwd: string; mcpServers: { name: string; command: string; env: unknown[] }[] };
    expect(params.cwd).toBe('/repo');
    expect(params.mcpServers[0].name).toBe('hotsheet');
    expect(Array.isArray(params.mcpServers[0].env)).toBe(true);
    feed({ jsonrpc: '2.0', id: sn.id, result: { sessionId: 'ses_test' } });

    // 3) session/prompt next — carrying the worklist text.
    await tick();
    const sp = h.sent(2);
    expect(sp.method).toBe('session/prompt');
    const spParams = sp.params as { sessionId: string; prompt: { type: string; text: string }[] };
    expect(spParams.sessionId).toBe('ses_test');
    expect(spParams.prompt[0]).toEqual({ type: 'text', text: 'process the worklist' });

    // Mid-turn the agent streams an update (⇒ busy heartbeat), then finishes.
    feed({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ses_test', update: { sessionUpdate: 'agent_message_chunk' } } });
    expect(onBusy).toHaveBeenCalledWith('agent_message_chunk', true);
    feed({ jsonrpc: '2.0', id: sp.id, result: { stopReason: 'end_turn' } });

    const result = await done;
    expect(result).toEqual({ sessionId: 'ses_test', stopReason: 'end_turn' });
    expect(onTurnEnd).toHaveBeenCalledTimes(1);
    expect(onTurnEnd).toHaveBeenCalledWith('completed', 'end_turn');
  });

  it('routes a mid-turn permission request to the resolver and replies with the chosen optionId', async () => {
    const h = makeHarness();
    const requestPermission = vi.fn().mockResolvedValue({ optionId: 'allow-once' });
    const client = createAcpClient(h.transport, { requestPermission });
    const feed = (o: unknown): void => { client.receive(JSON.stringify(o) + '\n'); };

    const done = client.runPrompt('/repo', 'go');
    await tick(); feed({ jsonrpc: '2.0', id: h.sent(0).id, result: { protocolVersion: 1 } });
    await tick(); feed({ jsonrpc: '2.0', id: h.sent(1).id, result: { sessionId: 'ses_1' } });
    await tick();
    const promptId = h.sent(2).id;

    // Agent asks permission (its OWN id namespace).
    feed({
      jsonrpc: '2.0', id: 100, method: 'session/request_permission',
      params: { sessionId: 'ses_1', toolCall: { title: 'write file' }, options: [
        { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ] },
    });
    await tick();
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect((requestPermission.mock.calls[0][0] as { options: unknown[] }).options).toHaveLength(2);
    // The client replied to id 100 with the selected optionId.
    const reply = h.sent(3);
    expect(reply.id).toBe(100);
    expect(reply.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });

    feed({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
    expect((await done).stopReason).toBe('end_turn');
  });

  it('cancels a permission request when no resolver is wired (deny-by-default)', async () => {
    const h = makeHarness();
    const client = createAcpClient(h.transport, {}); // no requestPermission
    const feed = (o: unknown): void => { client.receive(JSON.stringify(o) + '\n'); };

    client.runPrompt('/repo', 'go').catch(() => { /* not awaited here */ });
    await tick(); feed({ jsonrpc: '2.0', id: h.sent(0).id, result: {} });
    await tick(); feed({ jsonrpc: '2.0', id: h.sent(1).id, result: { sessionId: 's' } });
    await tick();

    feed({ jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: { sessionId: 's', options: [{ optionId: 'a', name: 'Allow', kind: 'allow_once' }] } });
    await tick();
    const reply = h.sent(3);
    expect(reply.id).toBe(7);
    expect(reply.result).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('replies method-not-found to an unknown agent→client request (never leaves it hanging)', () => {
    const h = makeHarness();
    const client = createAcpClient(h.transport, {});
    client.receive(JSON.stringify({ jsonrpc: '2.0', id: 55, method: 'fs/read_text_file', params: {} }) + '\n');
    const reply = h.sent(0);
    expect(reply.id).toBe(55);
    expect((reply.error as { code: number }).code).toBe(-32601);
  });

  it('ends the turn as error (busy clears) when session/prompt returns an error', async () => {
    const h = makeHarness();
    const onTurnEnd = vi.fn();
    const client = createAcpClient(h.transport, { onTurnEnd });
    const feed = (o: unknown): void => { client.receive(JSON.stringify(o) + '\n'); };

    const done = client.runPrompt('/repo', 'go');
    await tick(); feed({ jsonrpc: '2.0', id: h.sent(0).id, result: {} });
    await tick(); feed({ jsonrpc: '2.0', id: h.sent(1).id, result: { sessionId: 's' } });
    await tick(); feed({ jsonrpc: '2.0', id: h.sent(2).id, error: { code: -32603, message: 'boom' } });

    await expect(done).rejects.toThrow(/boom/);
    expect(onTurnEnd).toHaveBeenCalledTimes(1);
    expect(onTurnEnd).toHaveBeenCalledWith('error', 'error');
  });

  it('treats an unknown session/update kind as busy-but-unrecognized', () => {
    const h = makeHarness();
    const onBusy = vi.fn();
    const client = createAcpClient(h.transport, { onBusy });
    client.receive(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'available_commands_update' } } }) + '\n');
    expect(onBusy).toHaveBeenCalledWith('available_commands_update', false);
  });
});
