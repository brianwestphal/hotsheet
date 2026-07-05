// HS-9330 — the ACP session driver (docs/114 §114.3-114.6). Drives an ACP-native
// agent (OpenCode, validated §114.11) through the play-button turn:
//   initialize → session/new (with the hotsheet_* MCP server) → session/prompt,
// routing the agent's `session/update` stream to BUSY, its terminal `stopReason`
// to DONE, and its `session/request_permission` requests to a caller-supplied
// resolver (the §47 overlay + the auto-allow gate, wired by the real drive).
//
// The transport (child-process stdio) is INJECTED, so this whole driver is
// unit-testable against a scripted mock agent replaying real OpenCode messages —
// no spawn, no auth, no LLM turn. The thin real-IO edge (spawn `opencode acp`,
// pipe stdio) is `acpDrive.ts` (still to build), mirroring antigravityDrive.ts.

import { ACP_PROTOCOL_VERSION, buildHotsheetMcpServerEntry } from './acpAgents.js';
import {
  type AcpMessage,
  createIdCounter,
  createNdjsonDecoder,
  encodeMessage,
  isNotification,
  isRequest,
  isResponse,
} from './acpFraming.js';
import { type AcpPermissionOption, classifyUpdate, turnEndOutcome } from './acpMapping.js';

/** The byte transport to the agent: send a framed line, close the connection. */
export interface AcpTransport {
  send: (line: string) => void;
  close: () => void;
}

/** The agent's `session/request_permission` params (v1). */
export interface AcpPermissionRequest {
  sessionId: string;
  toolCall: unknown;
  options: AcpPermissionOption[];
}

/** A permission resolver's answer: pick an option, or cancel (no option chosen). */
export type AcpPermissionReply = { optionId: string } | { cancelled: true };

export interface AcpClientCallbacks {
  /** Fired on every `session/update` (activity ⇒ busy — a heartbeat while a turn
   *  runs). `known` reports whether the update kind is one we model (§114.6). */
  onBusy?: (updateKind: string, known: boolean) => void;
  /** Fired exactly once when the turn ends — on the `stopReason`, or 'error' if the
   *  session failed. Wire this to clear busy + signal channel-done. */
  onTurnEnd?: (outcome: 'completed' | 'stopped' | 'error', stopReason: string) => void;
  /** Resolve a permission request → the chosen option (or cancel). The real drive
   *  applies the auto-allow gate (`permission_allow_rules`) then the §47 overlay;
   *  absent, every request is cancelled (deny-by-default, never auto-approve). */
  requestPermission?: (req: AcpPermissionRequest) => Promise<AcpPermissionReply>;
  /** Non-fatal protocol surprise (unknown message, parse issue) — for logging. */
  onNotice?: (message: string) => void;
}

interface Pending {
  resolve: (result: AcpMessage) => void;
  reject: (err: Error) => void;
}

export interface AcpClient {
  /** Feed raw stdout bytes from the agent (the real drive pipes child stdout here). */
  receive: (chunk: string) => void;
  /** Run one play-button turn end-to-end. Resolves with the terminal stopReason. */
  runPrompt: (cwd: string, promptText: string) => Promise<{ sessionId: string; stopReason: string }>;
  /** Tear down the transport. */
  close: () => void;
}

export function createAcpClient(transport: AcpTransport, callbacks: AcpClientCallbacks = {}): AcpClient {
  const decoder = createNdjsonDecoder();
  const ids = createIdCounter();
  const pending = new Map<number, Pending>();

  const sendMessage = (msg: AcpMessage): void => { transport.send(encodeMessage(msg)); };
  /** Wire values that SHOULD be strings — take them only when they actually are
   *  (a stray object would otherwise stringify to '[object Object]'). */
  const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

  const sendRequest = (method: string, params: unknown): Promise<AcpMessage> => {
    const id = ids.next();
    return new Promise<AcpMessage>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      sendMessage({ jsonrpc: '2.0', id, method, params });
    });
  };

  const replyResult = (id: unknown, result: unknown): void => {
    sendMessage({ jsonrpc: '2.0', id, result });
  };
  const replyError = (id: unknown, code: number, message: string): void => {
    sendMessage({ jsonrpc: '2.0', id, error: { code, message } });
  };

  const handlePermissionRequest = (msg: AcpMessage): void => {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const req: AcpPermissionRequest = {
      sessionId: asString(params.sessionId),
      toolCall: params.toolCall,
      options: Array.isArray(params.options) ? (params.options as AcpPermissionOption[]) : [],
    };
    const resolver = callbacks.requestPermission;
    if (resolver === undefined) {
      // Deny-by-default: never auto-approve a tool call with no resolver wired.
      replyResult(msg.id, { outcome: { outcome: 'cancelled' } });
      return;
    }
    void resolver(req).then(
      (reply) => {
        if ('optionId' in reply) {
          replyResult(msg.id, { outcome: { outcome: 'selected', optionId: reply.optionId } });
        } else {
          replyResult(msg.id, { outcome: { outcome: 'cancelled' } });
        }
      },
      () => { replyResult(msg.id, { outcome: { outcome: 'cancelled' } }); },
    );
  };

  const route = (msg: AcpMessage): void => {
    if (isResponse(msg)) {
      const p = pending.get(msg.id as number);
      if (p === undefined) { callbacks.onNotice?.(`response for unknown id ${String(msg.id)}`); return; }
      pending.delete(msg.id as number);
      if ('error' in msg) {
        const err = msg.error as { message?: string; code?: number };
        p.reject(new Error(`ACP error ${String(err.code ?? '')}: ${err.message ?? 'unknown'}`));
      } else {
        p.resolve((msg.result ?? {}) as AcpMessage);
      }
      return;
    }
    if (isRequest(msg)) {
      if (msg.method === 'session/request_permission') { handlePermissionRequest(msg); return; }
      // Any other agent→client request we don't implement: JSON-RPC method-not-found,
      // so the agent isn't left waiting on a reply.
      replyError(msg.id, -32601, `Method not found: ${String(msg.method)}`);
      return;
    }
    if (isNotification(msg)) {
      if (msg.method === 'session/update') {
        const params = (msg.params ?? {}) as Record<string, unknown>;
        const update = (params.update ?? {}) as Record<string, unknown>;
        const kind = asString(update.sessionUpdate);
        const { known } = classifyUpdate(kind);
        callbacks.onBusy?.(kind, known);
      }
      return;
    }
    callbacks.onNotice?.('unclassifiable message');
  };

  const receive = (chunk: string): void => {
    for (const msg of decoder.push(chunk)) route(msg);
  };

  const runPrompt = async (cwd: string, promptText: string): Promise<{ sessionId: string; stopReason: string }> => {
    let ended = false;
    const end = (outcome: 'completed' | 'stopped' | 'error', stopReason: string): void => {
      if (ended) return;
      ended = true;
      callbacks.onTurnEnd?.(outcome, stopReason);
    };
    try {
      await sendRequest('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: 'hotsheet', version: '1' },
      });
      const session = await sendRequest('session/new', {
        cwd,
        mcpServers: [buildHotsheetMcpServerEntry()],
      });
      const sessionId = asString(session.sessionId);
      const promptResult = await sendRequest('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: promptText }],
      });
      const stopReason = asString(promptResult.stopReason) || 'end_turn';
      end(turnEndOutcome(stopReason), stopReason);
      return { sessionId, stopReason };
    } catch (e) {
      // A protocol/session failure still ENDS the turn so busy never sticks.
      end('error', 'error');
      throw e instanceof Error ? e : new Error(String(e));
    }
  };

  return {
    receive,
    runPrompt,
    close: () => { transport.close(); },
  };
}
