// HS-9383 — pure protocol core tests, pinned against the CAPTURED codex-cli 0.145.0
// contract (`docs/captured/codex-app-server-0.145.0/`).
import { describe, expect, it } from 'vitest';

import {
  approvalDisplayFromRequest,
  buildNotificationLine,
  buildRequestLine,
  buildResponseLine,
  classifyAppServerLine,
  decisionFromReply,
  driveEventFromNotification,
  threadIdFromResponse,
} from './codexAppServerMapping.js';

describe('classifyAppServerLine', () => {
  it('classifies a response (id, no method)', () => {
    const msg = classifyAppServerLine('{"jsonrpc":"2.0","id":3,"result":{"ok":true}}');
    expect(msg).toEqual({ kind: 'response', id: 3, result: { ok: true }, error: undefined });
  });
  it('classifies an error response', () => {
    const msg = classifyAppServerLine('{"jsonrpc":"2.0","id":4,"error":{"code":-32600,"message":"missing field `turnId`"}}');
    expect(msg?.kind).toBe('response');
    expect(msg?.kind === 'response' ? msg.error?.message : null).toContain('turnId');
  });
  it('classifies a server request (id AND method — an approval)', () => {
    const msg = classifyAppServerLine('{"jsonrpc":"2.0","id":"req-1","method":"item/commandExecution/requestApproval","params":{"command":"x"}}');
    expect(msg).toEqual({ kind: 'server-request', id: 'req-1', method: 'item/commandExecution/requestApproval', params: { command: 'x' } });
  });
  it('classifies a notification (method, no id)', () => {
    const msg = classifyAppServerLine('{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"t"}}');
    expect(msg).toEqual({ kind: 'notification', method: 'turn/completed', params: { threadId: 't' } });
  });
  it('returns null for blank / non-JSON / shapeless lines', () => {
    expect(classifyAppServerLine('')).toBeNull();
    expect(classifyAppServerLine('WARNING: something')).toBeNull();
    expect(classifyAppServerLine('42')).toBeNull();
    expect(classifyAppServerLine('{"jsonrpc":"2.0"}')).toBeNull();
  });
});

describe('builders', () => {
  it('build JSONL lines with trailing newlines', () => {
    expect(buildRequestLine(1, 'initialize', { a: 1 })).toBe('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"a":1}}\n');
    expect(buildNotificationLine('initialized', {})).toBe('{"jsonrpc":"2.0","method":"initialized","params":{}}\n');
    expect(buildResponseLine('req-1', { decision: 'accept' })).toBe('{"jsonrpc":"2.0","id":"req-1","result":{"decision":"accept"}}\n');
  });
});

describe('threadIdFromResponse', () => {
  it('reads the captured `{ thread: { id } }` shape', () => {
    expect(threadIdFromResponse({ thread: { id: '019f8c9a-67ef', sessionId: 'x' } })).toBe('019f8c9a-67ef');
  });
  it('tolerates flat variants and returns null when absent', () => {
    expect(threadIdFromResponse({ threadId: 'flat' })).toBe('flat');
    expect(threadIdFromResponse({ id: 'flat2' })).toBe('flat2');
    expect(threadIdFromResponse({})).toBeNull();
    expect(threadIdFromResponse(null)).toBeNull();
  });
});

describe('driveEventFromNotification', () => {
  it('turn/started carries the turnId (needed for turn/interrupt)', () => {
    expect(driveEventFromNotification('turn/started', { turn: { id: 'turn-9', status: 'inProgress' } }))
      .toEqual({ type: 'turn-started', turnId: 'turn-9' });
  });
  it('turn/completed carries the terminal status (completed / interrupted)', () => {
    expect(driveEventFromNotification('turn/completed', { turn: { id: 't', status: 'interrupted' } }))
      .toEqual({ type: 'turn-ended', status: 'interrupted' });
  });
  it('thread/status/changed maps active/idle', () => {
    expect(driveEventFromNotification('thread/status/changed', { status: { type: 'active', activeFlags: [] } }))
      .toEqual({ type: 'thread-status', active: true });
    expect(driveEventFromNotification('thread/status/changed', { status: { type: 'idle' } }))
      .toEqual({ type: 'thread-status', active: false });
  });
  it('item/* notifications are activity (event-driven heartbeats)', () => {
    expect(driveEventFromNotification('item/completed', {})).toEqual({ type: 'activity' });
    expect(driveEventFromNotification('item/agentMessage/delta', {})).toEqual({ type: 'activity' });
  });
  it('ignores unrelated notifications', () => {
    expect(driveEventFromNotification('account/rateLimits/updated', {})).toBeNull();
    expect(driveEventFromNotification('thread/tokenUsage/updated', {})).toBeNull();
  });
});

describe('approvalDisplayFromRequest', () => {
  // The EXACT captured `item/commandExecution/requestApproval` params (HS-9382 probe,
  // docs/captured/codex-app-server-0.145.0/server-request-…json, $HOME sanitized).
  const CAPTURED = {
    threadId: '019f8c9b-9b73-7163-84fb-4104fd0b188a',
    turnId: '019f8c9b-9ba6-7830-9a50-71e320e7b77f',
    itemId: 'exec-863585b8-aa37-492e-a547-7fe0742575f0',
    command: "/bin/zsh -lc 'touch ~/.hs9382-escape-probe && echo escaped-ok'",
    cwd: '~/.hs9382-probe-project',
    availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch'] } }, 'cancel'],
  };

  it('maps the captured command approval to overlay display + options', () => {
    const d = approvalDisplayFromRequest('item/commandExecution/requestApproval', CAPTURED);
    expect(d).not.toBeNull();
    expect(d?.tool_name).toBe('Codex: Shell command');
    expect(d?.input_preview).toContain('touch ~/.hs9382-escape-probe');
    expect(d?.input_preview).toContain('cwd: ~/.hs9382-probe-project');
    // Only the plain string decisions become options (structured variants dropped).
    expect(d?.options.map(o => o.optionId)).toEqual(['accept', 'cancel']);
    expect(d?.autoAllowCommand).toBe(CAPTURED.command);
  });

  it('falls back to allow/deny when availableDecisions is absent', () => {
    const d = approvalDisplayFromRequest('item/fileChange/requestApproval', {});
    expect(d?.options.map(o => o.optionId)).toEqual(['accept', 'decline']);
    expect(d?.tool_name).toBe('Codex: File change');
    expect(d?.autoAllowCommand).toBeNull();
  });

  it('returns null for non-approval server requests', () => {
    expect(approvalDisplayFromRequest('item/tool/requestUserInput', {})).toBeNull();
    expect(approvalDisplayFromRequest('account/chatgptAuthTokens/refresh', {})).toBeNull();
  });
});

describe('decisionFromReply', () => {
  it('maps an option choice to its decision and a cancel to decline', () => {
    expect(decisionFromReply({ optionId: 'accept' })).toEqual({ decision: 'accept' });
    expect(decisionFromReply({ optionId: 'acceptForSession' })).toEqual({ decision: 'acceptForSession' });
    expect(decisionFromReply({ cancelled: true })).toEqual({ decision: 'decline' });
  });
});
