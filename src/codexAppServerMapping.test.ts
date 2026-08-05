// HS-9383 — pure protocol core tests, pinned against the CAPTURED codex-cli 0.145.0
// contract (`docs/captured/codex-app-server-0.145.0/`).
import { describe, expect, it } from 'vitest';

import {
  appendTranscriptDetail,
  approvalAutoAcceptResponse,
  approvalDisplayFromRequest,
  approvalResponseFromReply,
  buildNotificationLine,
  buildRequestLine,
  buildResponseLine,
  buildThreadMcpOverride,
  classifyAppServerLine,
  driveEventFromNotification,
  elicitationDisplayFromRequest,
  elicitationResponseFromReply,
  type LoadedThreadEntry,
  loadedThreadIdsFromResponse,
  pickThreadForCwd,
  rolloutPathFromThreadPayload,
  threadIdFromResponse,
  threadReadEntry,
  TRANSCRIPT_TRUNCATION_MARKER,
  transcriptLineFromItem,
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
  // Note `availableDecisions` offers accept + a structured amendment + cancel —
  // and NO `decline`, which is why refusal has to fall back rather than assume.
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
    expect(d?.autoAllowCommand).toBe(CAPTURED.command);
    expect(d?.family).toBe('item-decision');
  });

  it('HS-9586 — hides "Allow for session" when the request does not offer it', () => {
    // The captured request has no `acceptForSession`. Offering the button anyway
    // is how the original bug felt to the user: a control whose token the
    // request rejects.
    const d = approvalDisplayFromRequest('item/commandExecution/requestApproval', CAPTURED);
    expect(d?.options.map(o => o.optionId)).toEqual(['allow', 'deny']);
  });

  it('offers the full set when the request does not constrain decisions', () => {
    const d = approvalDisplayFromRequest('item/fileChange/requestApproval', {});
    expect(d?.options.map(o => o.optionId)).toEqual(['allow', 'allow_session', 'deny']);
    expect(d?.tool_name).toBe('Codex: File change');
    expect(d?.autoAllowCommand).toBeNull();
  });

  it('HS-9586 — classifies each method into its response family', () => {
    // Getting this wrong is the whole bug: the v1 methods answer with a
    // different vocabulary than the v2 `item/*` ones, and permissions answers
    // with no `decision` field at all.
    const familyOf = (m: string): string | undefined => approvalDisplayFromRequest(m, {})?.family;
    expect(familyOf('execCommandApproval')).toBe('review-decision');
    expect(familyOf('applyPatchApproval')).toBe('review-decision');
    expect(familyOf('item/commandExecution/requestApproval')).toBe('item-decision');
    expect(familyOf('item/fileChange/requestApproval')).toBe('item-decision');
    expect(familyOf('item/permissions/requestApproval')).toBe('permissions');
  });

  it('HS-9586 — reads v1 argv commands, which arrive as string[]', () => {
    // `ExecCommandApprovalParams.command` is `string[]`; only the v2 methods
    // send a joined string. Before this, a v1 approval rendered with no command
    // and gave the auto-allow rule nothing to match on.
    const d = approvalDisplayFromRequest('execCommandApproval', {
      command: ['npm', 'install', 'motion'],
      cwd: '/tmp/proj',
    });
    expect(d?.input_preview).toContain('npm install motion');
    expect(d?.autoAllowCommand).toBe('npm install motion');
  });

  it('returns null for non-approval server requests', () => {
    expect(approvalDisplayFromRequest('item/tool/requestUserInput', {})).toBeNull();
    expect(approvalDisplayFromRequest('account/chatgptAuthTokens/refresh', {})).toBeNull();
  });
});

/**
 * HS-9586 — the reported bug: the user approved `npm install motion` and codex
 * ran nothing. The drive answered EVERY approval with `{decision:'accept'}`, but
 * `accept` is not a member of `ReviewDecision`, the type `execCommandApproval`
 * and `applyPatchApproval` answer with. Codex could not read it as an approval.
 *
 * `codexApprovalSchemaContract.test.ts` checks these payloads against codex's
 * OWN generated schema; these pin the intent.
 */
describe('approvalResponseFromReply (HS-9586)', () => {
  it('approves a v1 exec approval with `approved`, not `accept`', () => {
    expect(approvalResponseFromReply('review-decision', { optionId: 'allow' }))
      .toEqual({ decision: 'approved' });
  });

  it('approves a v2 item approval with `accept`', () => {
    expect(approvalResponseFromReply('item-decision', { optionId: 'allow' }))
      .toEqual({ decision: 'accept' });
  });

  it('uses the STRUCTURED denied variant for v1, never the bare string', () => {
    // `{decision:'denied'}` would fail to deserialize the same way `'accept'`
    // did — `denied` carries a rejection message.
    const r = approvalResponseFromReply('review-decision', { optionId: 'deny' });
    const decision = (r as { decision: { denied?: { rejection?: unknown } } }).decision;
    expect(typeof decision.denied?.rejection).toBe('string');
  });

  it('falls back to `cancel` when the request offers no `decline`', () => {
    // The captured request's availableDecisions are accept + amendment + cancel.
    const r = approvalResponseFromReply('item-decision', { optionId: 'deny' }, {
      availableDecisions: ['accept', 'cancel'],
    });
    expect(r).toEqual({ decision: 'cancel' });
  });

  it('prefers `decline` over `cancel` when both are offered', () => {
    const r = approvalResponseFromReply('item-decision', { optionId: 'deny' }, {
      availableDecisions: ['accept', 'decline', 'cancel'],
    });
    expect(r).toEqual({ decision: 'decline' });
  });

  it('downgrades allow-for-session to a plain allow when unsupported', () => {
    const r = approvalResponseFromReply('item-decision', { optionId: 'allow_session' }, {
      availableDecisions: ['accept', 'cancel'],
    });
    expect(r).toEqual({ decision: 'accept' });
  });

  it('a dismissed popup denies, and never approves', () => {
    const denied = approvalResponseFromReply('review-decision', { cancelled: true });
    expect(Object.keys((denied as { decision: object }).decision)).toEqual(['denied']);
    expect(approvalResponseFromReply('item-decision', { cancelled: true }))
      .toEqual({ decision: 'decline' });
  });

  it('an unrecognized option id denies rather than approving by accident', () => {
    expect(approvalResponseFromReply('item-decision', { optionId: 'yolo' }))
      .toEqual({ decision: 'decline' });
  });

  it('answers a permissions request with a GRANT, which has no decision field', () => {
    const requested = { fileSystem: { readRoots: ['/tmp'] } };
    expect(approvalResponseFromReply('permissions', { optionId: 'allow' }, { permissions: requested }))
      .toEqual({ permissions: requested, scope: 'turn' });
    expect(approvalResponseFromReply('permissions', { optionId: 'allow_session' }, { permissions: requested }))
      .toEqual({ permissions: requested, scope: 'session' });
    // Denying grants nothing rather than omitting the required field.
    expect(approvalResponseFromReply('permissions', { optionId: 'deny' }, { permissions: requested }))
      .toEqual({ permissions: {}, scope: 'turn' });
  });

  it('the auto-accept path uses the same translation as the interactive one', () => {
    // The opt-out path (docs/121 O4) and the allow-rule path both used to send a
    // hard-coded `{decision:'accept'}`, so they carried the identical bug.
    for (const family of ['review-decision', 'item-decision'] as const) {
      expect(approvalAutoAcceptResponse(family))
        .toEqual(approvalResponseFromReply(family, { optionId: 'allow' }));
    }
  });
});

describe('transcriptLineFromItem (HS-9385)', () => {
  it('renders an agent message as its text; empty/partial messages are skipped', () => {
    expect(transcriptLineFromItem({ item: { type: 'agentMessage', text: 'pong', phase: 'final_answer' } })).toBe('pong');
    expect(transcriptLineFromItem({ item: { type: 'agentMessage', text: '', phase: 'final_answer' } })).toBeNull();
  });

  it('renders the captured commandExecution shape with output; flags non-zero exits', () => {
    const item = { type: 'commandExecution', command: "/bin/zsh -lc 'echo hi'", aggregatedOutput: 'hi\n', exitCode: 0 };
    expect(transcriptLineFromItem({ item })).toBe("$ /bin/zsh -lc 'echo hi'\nhi");
    expect(transcriptLineFromItem({ item: { ...item, exitCode: 2 } })).toBe("$ /bin/zsh -lc 'echo hi'  (exit 2)\nhi");
    expect(transcriptLineFromItem({ item: { type: 'commandExecution', command: 'x' } })).toBe('$ x');
  });

  it('skips reasoning, userMessage (already logged as the trigger), and shapeless params', () => {
    expect(transcriptLineFromItem({ item: { type: 'reasoning', summary: [] } })).toBeNull();
    expect(transcriptLineFromItem({ item: { type: 'userMessage', content: [] } })).toBeNull();
    expect(transcriptLineFromItem({})).toBeNull();
  });
});

describe('appendTranscriptDetail (HS-9385)', () => {
  it('joins lines with blank separators under the cap', () => {
    const a = appendTranscriptDetail('', 'one', 100);
    expect(a).toEqual({ detail: 'one', truncated: false });
    expect(appendTranscriptDetail(a.detail, 'two', 100).detail).toBe('one\n\ntwo');
  });

  it('caps with a single marker and freezes afterward', () => {
    const capped = appendTranscriptDetail('x'.repeat(90), 'y'.repeat(30), 100);
    expect(capped.truncated).toBe(true);
    expect(capped.detail.endsWith(TRANSCRIPT_TRUNCATION_MARKER)).toBe(true);
    // Further appends are no-ops — the marker appears exactly once.
    const frozen = appendTranscriptDetail(capped.detail, 'more', 100);
    expect(frozen.detail).toBe(capped.detail);
    expect(frozen.detail.match(/\[transcript truncated\]/g)).toHaveLength(1);
  });
});

describe('elicitationDisplayFromRequest (HS-9395)', () => {
  // The CAPTURED 0.145.0 shape for an MCP tool-call elicitation.
  const params = {
    threadId: 'th-1',
    turnId: 'turn-1',
    serverName: 'hotsheet-channel',
    mode: 'form',
    _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: { id: 9388 } },
    message: 'Allow the hotsheet-channel MCP server to run tool "hotsheet_get_ticket"?',
    requestedSchema: { type: 'object', properties: {} },
  };

  it('maps the captured mcp_tool_call shape: server name, tool name from the message, params preview, allow/deny options', () => {
    const d = elicitationDisplayFromRequest('mcpServer/elicitation/request', params);
    expect(d).not.toBeNull();
    expect(d?.serverName).toBe('hotsheet-channel');
    expect(d?.tool_name).toBe('Codex: MCP tool (hotsheet_get_ticket)');
    expect(d?.description).toContain('hotsheet_get_ticket');
    expect(d?.input_preview).toBe('{"id":9388}');
    expect(d?.options.map(o => o.optionId)).toEqual(['accept', 'decline']);
  });

  it('tolerates a message without the tool-name quote and missing _meta', () => {
    const d = elicitationDisplayFromRequest('mcpServer/elicitation/request', { serverName: 's', message: 'Allow?' });
    expect(d?.tool_name).toBe('Codex: MCP tool');
    expect(d?.input_preview).toBe('');
  });

  it('returns null for non-elicitation methods (the requestApproval family keeps its own path)', () => {
    expect(elicitationDisplayFromRequest('item/commandExecution/requestApproval', params)).toBeNull();
    expect(elicitationDisplayFromRequest('item/tool/requestUserInput', params)).toBeNull();
  });
});

describe('elicitationResponseFromReply (HS-9395)', () => {
  it('accept carries the REQUIRED action plus empty content (the old `{}` reply read as a decline)', () => {
    expect(elicitationResponseFromReply({ optionId: 'accept' })).toEqual({ action: 'accept', content: {} });
  });

  it('decline and dismissed popups decline without content', () => {
    expect(elicitationResponseFromReply({ optionId: 'decline' })).toEqual({ action: 'decline' });
    expect(elicitationResponseFromReply({ cancelled: true })).toEqual({ action: 'decline' });
  });
});

describe('buildThreadMcpOverride (HS-9388)', () => {
  it('pins the channel server to the project: absolute --data-dir appended + the HS-9380 drive marker env', () => {
    expect(buildThreadMcpOverride('hotsheet-channel', { command: 'npx', args: ['tsx', '/repo/src/channel.ts'] }, '/repo/.hotsheet')).toEqual({
      mcp_servers: {
        'hotsheet-channel': {
          command: 'npx',
          args: ['tsx', '/repo/src/channel.ts', '--data-dir', '/repo/.hotsheet'],
          env: { HOTSHEET_DRIVE_SPAWNED: '1' },
        },
      },
    });
  });
});

describe('loadedThreadIdsFromResponse (HS-9428)', () => {
  it('extracts the string ids from { data: [...] }', () => {
    expect(loadedThreadIdsFromResponse({ data: ['a', 'b'], nextCursor: null })).toEqual(['a', 'b']);
  });
  it('drops non-strings/empties and tolerates shapeless input', () => {
    expect(loadedThreadIdsFromResponse({ data: ['a', '', 3, null] })).toEqual(['a']);
    expect(loadedThreadIdsFromResponse({})).toEqual([]);
    expect(loadedThreadIdsFromResponse(null)).toEqual([]);
    expect(loadedThreadIdsFromResponse({ data: 'nope' })).toEqual([]);
  });
});

describe('threadReadEntry (HS-9431)', () => {
  it('extracts {id, cwd, recencyAt, rolloutPath} from a thread/read response', () => {
    expect(threadReadEntry('t1', { thread: { cwd: '/proj', recencyAt: 42, path: '/sessions/r.jsonl' } }))
      .toEqual({ id: 't1', cwd: '/proj', recencyAt: 42, rolloutPath: '/sessions/r.jsonl' });
  });
  it('falls back updatedAt → recencyAt, defaults recency to 0, tolerates missing cwd', () => {
    expect(threadReadEntry('t1', { thread: { cwd: '/proj', updatedAt: 7 } })).toEqual({ id: 't1', cwd: '/proj', recencyAt: 7, rolloutPath: null });
    expect(threadReadEntry('t1', { thread: { cwd: '/proj' } })).toEqual({ id: 't1', cwd: '/proj', recencyAt: 0, rolloutPath: null });
    expect(threadReadEntry('t1', { thread: {} })).toEqual({ id: 't1', cwd: null, recencyAt: 0, rolloutPath: null });
  });
  it('HS-9438 — reports a rollout path the daemon names even before the file exists', () => {
    // The daemon reports `thread.path` for a fresh `codex --remote` session whose
    // rollout has NOT been written yet; existence is checked separately (on disk).
    expect(threadReadEntry('t1', { thread: { cwd: '/proj', path: '/sessions/not-yet.jsonl' } })?.rolloutPath)
      .toBe('/sessions/not-yet.jsonl');
    expect(threadReadEntry('t1', { thread: { cwd: '/proj', path: '' } })?.rolloutPath).toBeNull();
  });
  it('returns null for a shapeless payload', () => {
    expect(threadReadEntry('t1', {})).toBeNull();
    expect(threadReadEntry('t1', null)).toBeNull();
    expect(threadReadEntry('t1', { thread: 'nope' })).toBeNull();
  });
});

describe('pickThreadForCwd (HS-9428/HS-9431 model-B selection)', () => {
  const entry = (id: string, cwd: string | null, recencyAt: number): LoadedThreadEntry =>
    ({ id, cwd, recencyAt, rolloutPath: `/sessions/${id}.jsonl` });
  const entries = [
    entry('old-cwd', '/proj', 100),
    entry('new-cwd', '/proj', 200),
    entry('other-cwd', '/elsewhere', 999),
  ];
  it('picks the entry matching the cwd, most-recent by recencyAt', () => {
    expect(pickThreadForCwd(entries, '/proj')?.id).toBe('new-cwd');
  });
  it('returns the whole entry so the caller can persist its rollout path', () => {
    expect(pickThreadForCwd(entries, '/proj')?.rolloutPath).toBe('/sessions/new-cwd.jsonl');
  });
  it('ignores entries whose cwd differs', () => {
    expect(pickThreadForCwd([entry('other-cwd', '/elsewhere', 999)], '/proj')).toBeNull();
  });
  it('returns null when nothing matches (→ caller falls back to model-A)', () => {
    expect(pickThreadForCwd([], '/proj')).toBeNull();
    expect(pickThreadForCwd([entry('x', null, 1)], '/proj')).toBeNull();
  });
  it('HS-9438 — excludes the drive-owned model-A thread even when it is the most recent', () => {
    // The drive's own turns bump its thread's recencyAt, so without the exclusion it
    // would keep re-electing its own off-screen thread over the terminal's live one.
    expect(pickThreadForCwd(entries, '/proj', 'new-cwd')?.id).toBe('old-cwd');
    expect(pickThreadForCwd([entry('only-mine', '/proj', 500)], '/proj', 'only-mine')).toBeNull();
  });
});

describe('rolloutPathFromThreadPayload (HS-9394)', () => {
  it('reads thread.path from both response results and thread/started notification params', () => {
    expect(rolloutPathFromThreadPayload({ thread: { id: 't', path: '/sessions/r.jsonl' } })).toBe('/sessions/r.jsonl');
  });
  it('returns null when the path is absent, empty, or the payload is shapeless', () => {
    expect(rolloutPathFromThreadPayload({ thread: { id: 't' } })).toBeNull();
    expect(rolloutPathFromThreadPayload({ thread: { path: '' } })).toBeNull();
    expect(rolloutPathFromThreadPayload({})).toBeNull();
    expect(rolloutPathFromThreadPayload(null)).toBeNull();
  });
});
