/**
 * HS-8346 — unit tests for the MCP tool surface exposed by the channel
 * server. Each test exercises a single tool's happy path, validation
 * rejection, HTTP error propagation, and the missing-settings.json
 * case. The `fetchFn` parameter on `callTool` is injected so every
 * branch can be driven without a real HTTP server.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _toolsForTesting,
  callTool,
  errorResult,
  type FetchLike,
  listTools,
  loadChannelSettings,
} from './channel.tools.js';

let tmpDataDir: string;

beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'hotsheet-channel-tools-'));
  // Seed a valid settings.json by default; tests that target the
  // missing-settings branch overwrite it or delete it.
  writeFileSync(
    join(tmpDataDir, 'settings.json'),
    JSON.stringify({ port: 4174, secret: 'test-secret-abc' }),
    'utf-8',
  );
});

afterEach(() => {
  rmSync(tmpDataDir, { recursive: true, force: true });
});

function fakeFetch(handler: (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string | FormData }) => { ok: boolean; status: number; text: string } | Error): FetchLike {
  return async (input, init) => {
    const result = handler(input, init);
    if (result instanceof Error) throw result;
    return await Promise.resolve({
      ok: result.ok,
      status: result.status,
      text: () => Promise.resolve(result.text),
    });
  };
}

// ---------------------------------------------------------------------------
// Catalog + listTools()
// ---------------------------------------------------------------------------

describe('listTools (HS-8346 + HS-8347)', () => {
  it('returns the 23 tools by name (Phase 1 + Phase 2 + HS-8771 announce + HS-8862 claim/lease + HS-8865 blocked_by + HS-9031 worker-pool)', () => {
    const tools = listTools();
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual([
      'hotsheet_add_attachment',
      'hotsheet_announce',
      'hotsheet_batch',
      'hotsheet_claim_next',
      'hotsheet_create_ticket',
      'hotsheet_delete_note',
      'hotsheet_delete_ticket',
      'hotsheet_dispatch_tickets',
      'hotsheet_drain_workers',
      'hotsheet_duplicate_tickets',
      'hotsheet_edit_note',
      'hotsheet_get_ticket',
      'hotsheet_get_worker_pool',
      'hotsheet_query_tickets',
      'hotsheet_release',
      'hotsheet_renew_lease',
      'hotsheet_request_feedback',
      'hotsheet_restore_ticket',
      'hotsheet_set_blocked_by',
      'hotsheet_set_worker_target',
      'hotsheet_signal_done',
      'hotsheet_toggle_up_next',
      'hotsheet_update_ticket',
    ]);
  });

  it('every tool ships with a non-empty description and a JSON Schema input shape', () => {
    for (const tool of listTools()) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeTypeOf('object');
      // Every tool's input schema is an object schema (or empty for signal_done).
      // z.toJSONSchema produces `{type: 'object', ...}` for z.object(...).
      expect((tool.inputSchema as { type?: string }).type).toBe('object');
    }
  });

  it('the catalog count matches the internal `TOOLS` array', () => {
    expect(listTools()).toHaveLength(_toolsForTesting.length);
    expect(_toolsForTesting).toHaveLength(23);
  });

  // HS-8771 — the announce tool proxies to the announcer endpoint.
  it('hotsheet_announce proxies title + highlight to /api/announcer/announce', async () => {
    let captured: { url: string; init?: { method?: string; body?: string | FormData } } | undefined;
    const fetchFn = fakeFetch((url, init) => { captured = { url, init }; return { ok: true, status: 200, text: '{"inserted":1}' }; });
    const result = await callTool('hotsheet_announce', { title: 'Shipped export', highlight: 'CSV export is live.' }, tmpDataDir, fetchFn);
    expect(result.isError).toBeFalsy();
    expect(captured?.url).toContain('/api/announcer/announce');
    expect(captured?.init?.method).toBe('POST');
    expect(JSON.parse(captured?.init?.body as string)).toEqual({ title: 'Shipped export', highlight: 'CSV export is live.' });
  });

  it('hotsheet_announce rejects a missing highlight', async () => {
    const result = await callTool('hotsheet_announce', { title: 'x' }, tmpDataDir, vi.fn());
    expect(result.isError).toBe(true);
  });

  // HS-8772 — the optional diff is forwarded to the route.
  it('hotsheet_announce forwards an optional diff', async () => {
    let captured: { init?: { body?: string | FormData } } | undefined;
    const fetchFn = fakeFetch((_url, init) => { captured = { init }; return { ok: true, status: 200, text: '{"inserted":1}' }; });
    const diff = { oldStr: 'let x', newStr: 'const x', filePath: 'a.ts' };
    const result = await callTool('hotsheet_announce', { title: 'T', highlight: 'H', diff }, tmpDataDir, fetchFn);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(captured?.init?.body as string)).toEqual({ title: 'T', highlight: 'H', diff });
  });

  it('hotsheet_announce rejects a diff missing newStr', async () => {
    const result = await callTool('hotsheet_announce', { title: 'T', highlight: 'H', diff: { oldStr: 'a' } }, tmpDataDir, vi.fn());
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadChannelSettings
// ---------------------------------------------------------------------------

describe('loadChannelSettings (HS-8346)', () => {
  it('parses a valid settings.json and returns {port, secret}', () => {
    expect(loadChannelSettings(tmpDataDir)).toEqual({ port: 4174, secret: 'test-secret-abc' });
  });

  it('returns null when settings.json is missing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'hotsheet-empty-'));
    try {
      expect(loadChannelSettings(empty)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('returns null on malformed JSON', () => {
    writeFileSync(join(tmpDataDir, 'settings.json'), '{not json', 'utf-8');
    expect(loadChannelSettings(tmpDataDir)).toBeNull();
  });

  it('returns null when port is missing', () => {
    writeFileSync(join(tmpDataDir, 'settings.json'), JSON.stringify({ secret: 'x' }), 'utf-8');
    expect(loadChannelSettings(tmpDataDir)).toBeNull();
  });

  it('returns null when port is non-positive', () => {
    writeFileSync(join(tmpDataDir, 'settings.json'), JSON.stringify({ port: 0, secret: 'x' }), 'utf-8');
    expect(loadChannelSettings(tmpDataDir)).toBeNull();
  });

  it('returns null when secret is empty', () => {
    writeFileSync(join(tmpDataDir, 'settings.json'), JSON.stringify({ port: 4174, secret: '' }), 'utf-8');
    expect(loadChannelSettings(tmpDataDir)).toBeNull();
  });

  // HS-9007 — the real-world failure: after HS-9002 relocated `port` into the
  // gitignored settings.local.json and HS-8999 moved the secret into the
  // secret.json sidecar, settings.json carries NEITHER. Reading settings.json
  // alone (the old behavior) returned null on every migrated project. The fix
  // resolves `port` from the merged file settings + `secret` from the sidecar.
  it('resolves port from settings.local.json + secret from the secret.json sidecar (post-HS-9002/HS-8999 state)', () => {
    writeFileSync(join(tmpDataDir, 'settings.json'), JSON.stringify({ appName: 'Hot Sheet', auto_order: 'true' }), 'utf-8');
    writeFileSync(join(tmpDataDir, 'settings.local.json'), JSON.stringify({ port: 4190 }), 'utf-8');
    writeFileSync(join(tmpDataDir, 'secret.json'), JSON.stringify({ secret: 'sidecar-secret-xyz' }), 'utf-8');
    expect(loadChannelSettings(tmpDataDir)).toEqual({ port: 4190, secret: 'sidecar-secret-xyz' });
  });

  it('lets settings.local.json override the settings.json port (local wins)', () => {
    writeFileSync(join(tmpDataDir, 'settings.json'), JSON.stringify({ port: 4174, secret: 'shared-secret' }), 'utf-8');
    writeFileSync(join(tmpDataDir, 'settings.local.json'), JSON.stringify({ port: 4200 }), 'utf-8');
    expect(loadChannelSettings(tmpDataDir)).toEqual({ port: 4200, secret: 'shared-secret' });
  });

  it('returns null when port lives nowhere (neither settings.json nor settings.local.json)', () => {
    writeFileSync(join(tmpDataDir, 'settings.json'), JSON.stringify({ appName: 'X' }), 'utf-8');
    writeFileSync(join(tmpDataDir, 'secret.json'), JSON.stringify({ secret: 'sidecar-secret' }), 'utf-8');
    expect(loadChannelSettings(tmpDataDir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Top-level dispatch — unknown tool + missing settings.
// ---------------------------------------------------------------------------

describe('callTool — dispatcher errors (HS-8346)', () => {
  it('returns an isError result for an unknown tool name', async () => {
    const result = await callTool('hotsheet_does_not_exist', {}, tmpDataDir, vi.fn());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown MCP tool');
    expect(result.content[0].text).toContain('hotsheet_does_not_exist');
  });

  it('returns an isError result when settings.json is missing', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'hotsheet-empty-'));
    try {
      const result = await callTool('hotsheet_signal_done', {}, empty, vi.fn());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('settings.json');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// hotsheet_update_ticket
// ---------------------------------------------------------------------------

describe('hotsheet_update_ticket (HS-8346)', () => {
  it('happy path — PATCHes /api/tickets/:id with the payload, returns the echoed JSON', async () => {
    const ticketJson = JSON.stringify({ id: 42, status: 'started' });
    const fetchSpy = vi.fn();
    const fetchFn = fakeFetch((url, init) => {
      fetchSpy(url, init);
      return { ok: true, status: 200, text: ticketJson };
    });
    const result = await callTool('hotsheet_update_ticket', { id: 42, status: 'started' }, tmpDataDir, fetchFn);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(ticketJson);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const call = fetchSpy.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(call[0]).toBe('http://localhost:4174/api/tickets/42');
    expect(call[1].method).toBe('PATCH');
    expect(call[1].headers['X-Hotsheet-Secret']).toBe('test-secret-abc');
    expect(call[1].headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(call[1].body)).toEqual({ status: 'started' });
  });

  it('HS-9045 — forwards the pending_integration flag in the PATCH body', async () => {
    const fetchSpy = vi.fn();
    const fetchFn = fakeFetch((url, init) => {
      fetchSpy(url, init);
      return { ok: true, status: 200, text: JSON.stringify({ id: 42, pending_integration: true }) };
    });
    const result = await callTool('hotsheet_update_ticket', { id: 42, status: 'completed', pending_integration: true }, tmpDataDir, fetchFn);
    expect(result.isError).toBeUndefined();
    const call = fetchSpy.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(call[1].body)).toEqual({ status: 'completed', pending_integration: true });
  });

  it('Zod rejection — invalid status enum value returns isError with the validation message', async () => {
    const result = await callTool('hotsheet_update_ticket', { id: 42, status: 'banana' }, tmpDataDir, vi.fn());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('validation failed');
    expect(result.content[0].text).toContain('status');
  });

  it('Zod rejection — missing id returns isError', async () => {
    const result = await callTool('hotsheet_update_ticket', { status: 'started' }, tmpDataDir, vi.fn());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('validation failed');
    expect(result.content[0].text).toContain('id');
  });

  it('HTTP error propagation — 404 from server surfaces as an isError result', async () => {
    const fetchFn = fakeFetch(() => ({ ok: false, status: 404, text: 'Ticket not found' }));
    const result = await callTool('hotsheet_update_ticket', { id: 99999, status: 'started' }, tmpDataDir, fetchFn);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('HTTP 404');
    expect(result.content[0].text).toContain('Ticket not found');
  });

  it('network error propagation — fetch throws, the tool returns isError', async () => {
    const fetchFn = fakeFetch(() => new Error('ECONNREFUSED'));
    const result = await callTool('hotsheet_update_ticket', { id: 1, status: 'started' }, tmpDataDir, fetchFn);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('network error');
    expect(result.content[0].text).toContain('ECONNREFUSED');
  });
});

// ---------------------------------------------------------------------------
// hotsheet_create_ticket
// ---------------------------------------------------------------------------

describe('hotsheet_create_ticket (HS-8346)', () => {
  it('happy path — POSTs /api/tickets with the nested {title, defaults} shape', async () => {
    const fetchSpy = vi.fn();
    const fetchFn = fakeFetch((url, init) => {
      fetchSpy(url, init);
      return { ok: true, status: 200, text: JSON.stringify({ id: 100, title: 'Test', category: 'bug', up_next: true }) };
    });
    const result = await callTool('hotsheet_create_ticket', {
      title: 'Test',
      category: 'bug',
      up_next: true,
    }, tmpDataDir, fetchFn);
    expect(result.isError).toBeUndefined();
    const call = fetchSpy.mock.calls[0] as [string, { method: string; body: string }];
    expect(call[0]).toBe('http://localhost:4174/api/tickets');
    expect(call[1].method).toBe('POST');
    // Tool's flat input shape gets mapped to the REST API's nested
    // `{title, defaults: {...}}` shape.
    expect(JSON.parse(call[1].body)).toEqual({
      title: 'Test',
      defaults: { category: 'bug', up_next: true },
    });
  });

  it('happy path with title only — sends just {title}, no defaults block', async () => {
    const fetchSpy = vi.fn();
    const fetchFn = fakeFetch((url, init) => {
      fetchSpy(url, init);
      return { ok: true, status: 200, text: '{}' };
    });
    await callTool('hotsheet_create_ticket', { title: 'Just a title' }, tmpDataDir, fetchFn);
    const call = fetchSpy.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(call[1].body)).toEqual({ title: 'Just a title' });
  });

  it('Zod rejection — empty title fails the `min(1)` constraint', async () => {
    const result = await callTool('hotsheet_create_ticket', { title: '' }, tmpDataDir, vi.fn());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('validation failed');
    expect(result.content[0].text).toContain('title');
  });
});

// ---------------------------------------------------------------------------
// hotsheet_signal_done
// ---------------------------------------------------------------------------

describe('hotsheet_signal_done (HS-8346)', () => {
  it('happy path — POSTs /api/channel/done with no body', async () => {
    const fetchSpy = vi.fn();
    const fetchFn = fakeFetch((url, init) => {
      fetchSpy(url, init);
      return { ok: true, status: 200, text: '{"ok":true}' };
    });
    const result = await callTool('hotsheet_signal_done', {}, tmpDataDir, fetchFn);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('{"ok":true}');
    const call = fetchSpy.mock.calls[0] as [string, { method: string; body: string | undefined }];
    expect(call[0]).toBe('http://localhost:4174/api/channel/done');
    expect(call[1].method).toBe('POST');
    expect(call[1].body).toBeUndefined();
  });

  it('accepts the empty object as input', async () => {
    const fetchFn = fakeFetch(() => ({ ok: true, status: 200, text: '{}' }));
    const result = await callTool('hotsheet_signal_done', {}, tmpDataDir, fetchFn);
    expect(result.isError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// hotsheet_request_feedback
// ---------------------------------------------------------------------------

describe('hotsheet_request_feedback (HS-8346)', () => {
  it('happy path — prepends FEEDBACK NEEDED: by default and PATCHes the ticket', async () => {
    const fetchSpy = vi.fn();
    const fetchFn = fakeFetch((url, init) => {
      fetchSpy(url, init);
      return { ok: true, status: 200, text: '{}' };
    });
    await callTool('hotsheet_request_feedback', {
      ticket_id: 7,
      question: 'Should I proceed with option A or option B?',
    }, tmpDataDir, fetchFn);
    const call = fetchSpy.mock.calls[0] as [string, { method: string; body: string }];
    expect(call[0]).toBe('http://localhost:4174/api/tickets/7');
    expect(call[1].method).toBe('PATCH');
    expect(JSON.parse(call[1].body)).toEqual({
      notes: 'FEEDBACK NEEDED: Should I proceed with option A or option B?',
    });
  });

  it('urgent=true uses IMMEDIATE FEEDBACK NEEDED: prefix', async () => {
    const fetchSpy = vi.fn();
    const fetchFn = fakeFetch((url, init) => {
      fetchSpy(url, init);
      return { ok: true, status: 200, text: '{}' };
    });
    await callTool('hotsheet_request_feedback', {
      ticket_id: 7,
      question: 'Critical: rolling back?',
      urgent: true,
    }, tmpDataDir, fetchFn);
    const call = fetchSpy.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(call[1].body)).toEqual({
      notes: 'IMMEDIATE FEEDBACK NEEDED: Critical: rolling back?',
    });
  });

  it('Zod rejection — empty question fails the `min(1)` constraint', async () => {
    const result = await callTool('hotsheet_request_feedback', { ticket_id: 1, question: '' }, tmpDataDir, vi.fn());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('validation failed');
  });
});

// ---------------------------------------------------------------------------
// hotsheet_add_attachment
// ---------------------------------------------------------------------------

describe('hotsheet_add_attachment (HS-8346)', () => {
  it('happy path — reads the file from disk and POSTs multipart to /api/tickets/:id/attachments', async () => {
    const filePath = join(tmpDataDir, 'attachment.txt');
    writeFileSync(filePath, 'hello world', 'utf-8');
    const fetchSpy = vi.fn();
    const fetchFn = fakeFetch((url, init) => {
      fetchSpy(url, init);
      return { ok: true, status: 200, text: JSON.stringify({ id: 1, filename: 'attachment.txt' }) };
    });
    const result = await callTool('hotsheet_add_attachment', {
      ticket_id: 7,
      path: filePath,
    }, tmpDataDir, fetchFn);
    expect(result.isError).toBeUndefined();
    const call = fetchSpy.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: FormData }];
    expect(call[0]).toBe('http://localhost:4174/api/tickets/7/attachments');
    expect(call[1].method).toBe('POST');
    expect(call[1].headers['X-Hotsheet-Secret']).toBe('test-secret-abc');
    // Content-Type is NOT set — the global `fetch` (and our FetchLike
    // type's `FormData` body branch) auto-generates the multipart
    // boundary header.
    expect(call[1].headers['Content-Type']).toBeUndefined();
    expect(call[1].body).toBeInstanceOf(FormData);
  });

  it('Zod rejection — missing path returns isError', async () => {
    const result = await callTool('hotsheet_add_attachment', { ticket_id: 1 }, tmpDataDir, vi.fn());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('validation failed');
  });

  it('missing file on disk returns a clear isError result', async () => {
    const result = await callTool('hotsheet_add_attachment', {
      ticket_id: 7,
      path: '/nonexistent/path/abc.txt',
    }, tmpDataDir, vi.fn());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('could not read file');
    expect(result.content[0].text).toContain('/nonexistent/path/abc.txt');
  });
});

// ---------------------------------------------------------------------------
// errorResult helper (used by callers + tests)
// ---------------------------------------------------------------------------

describe('errorResult (HS-8346)', () => {
  it('wraps a message into the standard MCP error-result shape', () => {
    const r = errorResult('boom');
    expect(r.isError).toBe(true);
    expect(r.content).toHaveLength(1);
    expect(r.content[0]).toEqual({ type: 'text', text: 'boom' });
  });
});

// ---------------------------------------------------------------------------
// HS-8347 — Phase 2 tools.
// ---------------------------------------------------------------------------

describe('hotsheet_get_ticket (HS-8347)', () => {
  it('happy path — GETs /api/tickets/:id and returns the JSON', async () => {
    const ticketJson = JSON.stringify({ id: 7, title: 'Hello' });
    const fetchSpy = vi.fn();
    const fetchFn = fakeFetch((url, init) => {
      fetchSpy(url, init);
      return { ok: true, status: 200, text: ticketJson };
    });
    const result = await callTool('hotsheet_get_ticket', { id: 7 }, tmpDataDir, fetchFn);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(ticketJson);
    const call = fetchSpy.mock.calls[0] as [string, { method: string }];
    expect(call[0]).toBe('http://localhost:4174/api/tickets/7');
    expect(call[1].method).toBe('GET');
  });

  it('Zod rejection — missing id', async () => {
    const result = await callTool('hotsheet_get_ticket', {}, tmpDataDir, vi.fn());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('validation failed');
  });

  it('HTTP 404 propagation', async () => {
    const fetchFn = fakeFetch(() => ({ ok: false, status: 404, text: 'Not found' }));
    const result = await callTool('hotsheet_get_ticket', { id: 9999 }, tmpDataDir, fetchFn);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('HTTP 404');
  });
});

describe('hotsheet_delete_ticket (HS-8347)', () => {
  it('happy path — DELETEs /api/tickets/:id', async () => {
    const fetchSpy = vi.fn();
    const fetchFn = fakeFetch((url, init) => {
      fetchSpy(url, init);
      return { ok: true, status: 200, text: '{"ok":true}' };
    });
    await callTool('hotsheet_delete_ticket', { id: 5 }, tmpDataDir, fetchFn);
    const call = fetchSpy.mock.calls[0] as [string, { method: string }];
    expect(call[0]).toBe('http://localhost:4174/api/tickets/5');
    expect(call[1].method).toBe('DELETE');
  });

  it('Zod rejection — non-integer id', async () => {
    const result = await callTool('hotsheet_delete_ticket', { id: 'abc' }, tmpDataDir, vi.fn());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('validation failed');
  });
});

describe('hotsheet_restore_ticket (HS-8347)', () => {
  it('happy path — POSTs /api/tickets/:id/restore', async () => {
    const fetchSpy = vi.fn();
    const fetchFn = fakeFetch((url, init) => {
      fetchSpy(url, init);
      return { ok: true, status: 200, text: '{"ok":true}' };
    });
    await callTool('hotsheet_restore_ticket', { id: 5 }, tmpDataDir, fetchFn);
    const call = fetchSpy.mock.calls[0] as [string, { method: string }];
    expect(call[0]).toBe('http://localhost:4174/api/tickets/5/restore');
    expect(call[1].method).toBe('POST');
  });
});

describe('hotsheet_toggle_up_next (HS-8347)', () => {
  it('happy path — POSTs /api/tickets/:id/up-next', async () => {
    const fetchSpy = vi.fn();
    const fetchFn = fakeFetch((url, init) => {
      fetchSpy(url, init);
      return { ok: true, status: 200, text: '{"ok":true,"up_next":true}' };
    });
    await callTool('hotsheet_toggle_up_next', { id: 42 }, tmpDataDir, fetchFn);
    const call = fetchSpy.mock.calls[0] as [string, { method: string }];
    expect(call[0]).toBe('http://localhost:4174/api/tickets/42/up-next');
    expect(call[1].method).toBe('POST');
  });
});

describe('hotsheet_duplicate_tickets (HS-8347)', () => {
  it('happy path — POSTs /api/tickets/duplicate with {ids}', async () => {
    const fetchSpy = vi.fn();
    const fetchFn = fakeFetch((url, init) => {
      fetchSpy(url, init);
      return { ok: true, status: 200, text: '[{"id":101},{"id":102}]' };
    });
    await callTool('hotsheet_duplicate_tickets', { ids: [1, 2] }, tmpDataDir, fetchFn);
    const call = fetchSpy.mock.calls[0] as [string, { method: string; body: string }];
    expect(call[0]).toBe('http://localhost:4174/api/tickets/duplicate');
    expect(call[1].method).toBe('POST');
    expect(JSON.parse(call[1].body)).toEqual({ ids: [1, 2] });
  });

  it('Zod rejection — empty ids array', async () => {
    const result = await callTool('hotsheet_duplicate_tickets', { ids: [] }, tmpDataDir, vi.fn());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('validation failed');
  });
});

describe('hotsheet_batch (HS-8347)', () => {
  it('happy path — POSTs /api/tickets/batch with the full payload', async () => {
    const fetchSpy = vi.fn();
    const fetchFn = fakeFetch((url, init) => {
      fetchSpy(url, init);
      return { ok: true, status: 200, text: '{"ok":true}' };
    });
    await callTool('hotsheet_batch', {
      ids: [1, 2, 3],
      action: 'status',
      value: 'completed',
    }, tmpDataDir, fetchFn);
    const call = fetchSpy.mock.calls[0] as [string, { method: string; body: string }];
    expect(call[0]).toBe('http://localhost:4174/api/tickets/batch');
    expect(call[1].method).toBe('POST');
    expect(JSON.parse(call[1].body)).toEqual({
      ids: [1, 2, 3],
      action: 'status',
      value: 'completed',
    });
  });

  it('accepts boolean values for up_next action', async () => {
    const fetchSpy = vi.fn();
    const fetchFn = fakeFetch((url, init) => {
      fetchSpy(url, init);
      return { ok: true, status: 200, text: '{}' };
    });
    await callTool('hotsheet_batch', {
      ids: [1],
      action: 'up_next',
      value: true,
    }, tmpDataDir, fetchFn);
    const call = fetchSpy.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(call[1].body) as { value: boolean };
    expect(body.value).toBe(true);
  });

  it('Zod rejection — invalid action enum', async () => {
    const result = await callTool('hotsheet_batch', {
      ids: [1],
      action: 'invalid_action',
    }, tmpDataDir, vi.fn());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('validation failed');
    expect(result.content[0].text).toContain('action');
  });

  it('Zod rejection — empty ids array', async () => {
    const result = await callTool('hotsheet_batch', {
      ids: [],
      action: 'delete',
    }, tmpDataDir, vi.fn());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('validation failed');
  });
});

describe('hotsheet_edit_note (HS-8347)', () => {
  it('happy path — PATCHes /api/tickets/:id/notes/:noteId with {text}', async () => {
    const fetchSpy = vi.fn();
    const fetchFn = fakeFetch((url, init) => {
      fetchSpy(url, init);
      return { ok: true, status: 200, text: '{"ok":true}' };
    });
    await callTool('hotsheet_edit_note', {
      ticket_id: 42,
      note_id: 'cn_abc123',
      text: 'Updated note body',
    }, tmpDataDir, fetchFn);
    const call = fetchSpy.mock.calls[0] as [string, { method: string; body: string }];
    expect(call[0]).toBe('http://localhost:4174/api/tickets/42/notes/cn_abc123');
    expect(call[1].method).toBe('PATCH');
    expect(JSON.parse(call[1].body)).toEqual({ text: 'Updated note body' });
  });

  it('URL-encodes special characters in note_id', async () => {
    const fetchSpy = vi.fn();
    const fetchFn = fakeFetch((url, init) => {
      fetchSpy(url, init);
      return { ok: true, status: 200, text: '{}' };
    });
    await callTool('hotsheet_edit_note', {
      ticket_id: 42,
      note_id: 'has spaces & weird/chars',
      text: 'x',
    }, tmpDataDir, fetchFn);
    const call = fetchSpy.mock.calls[0] as [string, unknown];
    expect(call[0]).toBe('http://localhost:4174/api/tickets/42/notes/has%20spaces%20%26%20weird%2Fchars');
  });

  it('Zod rejection — missing note_id', async () => {
    const result = await callTool('hotsheet_edit_note', { ticket_id: 1, text: 'x' }, tmpDataDir, vi.fn());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('validation failed');
  });
});

describe('hotsheet_delete_note (HS-8347)', () => {
  it('happy path — DELETEs /api/tickets/:id/notes/:noteId', async () => {
    const fetchSpy = vi.fn();
    const fetchFn = fakeFetch((url, init) => {
      fetchSpy(url, init);
      return { ok: true, status: 200, text: '{"ok":true}' };
    });
    await callTool('hotsheet_delete_note', {
      ticket_id: 42,
      note_id: 'cn_xyz',
    }, tmpDataDir, fetchFn);
    const call = fetchSpy.mock.calls[0] as [string, { method: string }];
    expect(call[0]).toBe('http://localhost:4174/api/tickets/42/notes/cn_xyz');
    expect(call[1].method).toBe('DELETE');
  });
});

describe('hotsheet_query_tickets (HS-8347)', () => {
  it('happy path — POSTs /api/tickets/query with the full payload', async () => {
    const fetchSpy = vi.fn();
    const fetchFn = fakeFetch((url, init) => {
      fetchSpy(url, init);
      return { ok: true, status: 200, text: '[]' };
    });
    await callTool('hotsheet_query_tickets', {
      logic: 'all',
      conditions: [
        { field: 'category', operator: 'equals', value: 'bug' },
        { field: 'priority', operator: 'equals', value: 'highest' },
      ],
      sort_by: 'priority',
      sort_dir: 'desc',
    }, tmpDataDir, fetchFn);
    const call = fetchSpy.mock.calls[0] as [string, { method: string; body: string }];
    expect(call[0]).toBe('http://localhost:4174/api/tickets/query');
    expect(call[1].method).toBe('POST');
    const body = JSON.parse(call[1].body) as { logic: string; conditions: unknown[]; sort_by: string; sort_dir: string };
    expect(body.logic).toBe('all');
    expect(body.conditions).toHaveLength(2);
    expect(body.sort_by).toBe('priority');
    expect(body.sort_dir).toBe('desc');
  });

  it('Zod rejection — invalid logic enum', async () => {
    const result = await callTool('hotsheet_query_tickets', {
      logic: 'maybe',
      conditions: [],
    }, tmpDataDir, vi.fn());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('validation failed');
    expect(result.content[0].text).toContain('logic');
  });

  it('Zod rejection — invalid operator', async () => {
    const result = await callTool('hotsheet_query_tickets', {
      logic: 'all',
      conditions: [{ field: 'category', operator: 'unsupported', value: 'bug' }],
    }, tmpDataDir, vi.fn());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('validation failed');
  });

  it('include_archived defaults absent — body has no include_archived key', async () => {
    const fetchSpy = vi.fn();
    const fetchFn = fakeFetch((url, init) => {
      fetchSpy(url, init);
      return { ok: true, status: 200, text: '[]' };
    });
    await callTool('hotsheet_query_tickets', {
      logic: 'any',
      conditions: [{ field: 'status', operator: 'equals', value: 'started' }],
    }, tmpDataDir, fetchFn);
    const call = fetchSpy.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(call[1].body) as Record<string, unknown>;
    expect(body.include_archived).toBeUndefined();
  });
});

describe('hotsheet_claim_next / renew_lease / release (HS-8862)', () => {
  it('claim_next — POSTs /api/tickets/claim-next with the worker payload', async () => {
    const fetchSpy = vi.fn();
    const fetchFn = fakeFetch((url, init) => {
      fetchSpy(url, init);
      return { ok: true, status: 200, text: '{"ticket":null}' };
    });
    await callTool('hotsheet_claim_next', { worker: 'w1', label: 'W1' }, tmpDataDir, fetchFn);
    const call = fetchSpy.mock.calls[0] as [string, { method: string; body: string }];
    expect(call[0]).toBe('http://localhost:4174/api/tickets/claim-next');
    expect(call[1].method).toBe('POST');
    expect(JSON.parse(call[1].body)).toEqual({ worker: 'w1', label: 'W1' });
  });

  it('claim_next — Zod rejection when worker is missing', async () => {
    const result = await callTool('hotsheet_claim_next', {}, tmpDataDir, vi.fn());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('validation failed');
  });

  it('renew_lease — POSTs /api/tickets/:id/renew-lease', async () => {
    const fetchSpy = vi.fn();
    const fetchFn = fakeFetch((url, init) => {
      fetchSpy(url, init);
      return { ok: true, status: 200, text: '{"ok":true}' };
    });
    await callTool('hotsheet_renew_lease', { id: 7, worker: 'w1' }, tmpDataDir, fetchFn);
    const call = fetchSpy.mock.calls[0] as [string, { method: string }];
    expect(call[0]).toBe('http://localhost:4174/api/tickets/7/renew-lease');
    expect(call[1].method).toBe('POST');
  });

  it('release — POSTs /api/tickets/:id/release', async () => {
    const fetchSpy = vi.fn();
    const fetchFn = fakeFetch((url, init) => {
      fetchSpy(url, init);
      return { ok: true, status: 200, text: '{"ok":true}' };
    });
    await callTool('hotsheet_release', { id: 7, worker: 'w1' }, tmpDataDir, fetchFn);
    const call = fetchSpy.mock.calls[0] as [string, { method: string }];
    expect(call[0]).toBe('http://localhost:4174/api/tickets/7/release');
    expect(call[1].method).toBe('POST');
  });
});

describe('hotsheet_set_blocked_by (HS-8865)', () => {
  it('PUTs /api/tickets/:id/blocked-by with {blockerIds}', async () => {
    const fetchSpy = vi.fn();
    const fetchFn = fakeFetch((url, init) => {
      fetchSpy(url, init);
      return { ok: true, status: 200, text: '{"ok":true,"blockedBy":[2,3]}' };
    });
    await callTool('hotsheet_set_blocked_by', { ticket_id: 9, blocker_ids: [2, 3] }, tmpDataDir, fetchFn);
    const call = fetchSpy.mock.calls[0] as [string, { method: string; body: string }];
    expect(call[0]).toBe('http://localhost:4174/api/tickets/9/blocked-by');
    expect(call[1].method).toBe('PUT');
    expect(JSON.parse(call[1].body)).toEqual({ blockerIds: [2, 3] });
  });

  it('Zod rejection — missing ticket_id', async () => {
    const result = await callTool('hotsheet_set_blocked_by', { blocker_ids: [1] }, tmpDataDir, vi.fn());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('validation failed');
  });
});

describe('worker-pool management tools (HS-9031)', () => {
  it('hotsheet_get_worker_pool — GETs /api/workers/pool', async () => {
    const poolJson = JSON.stringify({ targetN: 2, workers: [] });
    const fetchSpy = vi.fn();
    const fetchFn = fakeFetch((url, init) => { fetchSpy(url, init); return { ok: true, status: 200, text: poolJson }; });
    const result = await callTool('hotsheet_get_worker_pool', {}, tmpDataDir, fetchFn);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(poolJson);
    const call = fetchSpy.mock.calls[0] as [string, { method: string }];
    expect(call[0]).toBe('http://localhost:4174/api/workers/pool');
    expect(call[1].method).toBe('GET');
  });

  it('hotsheet_set_worker_target — POSTs /api/workers/pool/target with {targetN}', async () => {
    const fetchSpy = vi.fn();
    const fetchFn = fakeFetch((url, init) => { fetchSpy(url, init); return { ok: true, status: 200, text: '{"ok":true}' }; });
    const result = await callTool('hotsheet_set_worker_target', { targetN: 3 }, tmpDataDir, fetchFn);
    expect(result.isError).toBeUndefined();
    const call = fetchSpy.mock.calls[0] as [string, { method: string; body: string }];
    expect(call[0]).toBe('http://localhost:4174/api/workers/pool/target');
    expect(call[1].method).toBe('POST');
    expect(JSON.parse(call[1].body)).toEqual({ targetN: 3 });
    // HS-9076 — after setting the target it reconciles server-side so the change
    // actually scales the pool with no UI open.
    const reconcileCall = fetchSpy.mock.calls[1] as [string, { method: string }];
    expect(reconcileCall[0]).toBe('http://localhost:4174/api/workers/pool/reconcile');
    expect(reconcileCall[1].method).toBe('POST');
  });

  it('hotsheet_set_worker_target — does NOT reconcile when the target POST fails', async () => {
    const fetchSpy = vi.fn();
    const fetchFn = fakeFetch((url, init) => { fetchSpy(url, init); return { ok: false, status: 400, text: 'bad target' }; });
    const result = await callTool('hotsheet_set_worker_target', { targetN: 3 }, tmpDataDir, fetchFn);
    expect(result.isError).toBe(true);
    // Only the /target call was made — no reconcile after a failed set.
    expect(fetchSpy.mock.calls).toHaveLength(1);
    expect((fetchSpy.mock.calls[0] as [string])[0]).toBe('http://localhost:4174/api/workers/pool/target');
  });

  it('hotsheet_set_worker_target — rejects an out-of-range target', async () => {
    const result = await callTool('hotsheet_set_worker_target', { targetN: 999 }, tmpDataDir, vi.fn());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('validation failed');
  });

  it('hotsheet_dispatch_tickets — claims each id and aggregates dispatched/failed', async () => {
    // Ticket 2 is already live-claimed elsewhere → 409 → lands in `failed`.
    const fetchFn = fakeFetch((url) =>
      url.endsWith('/api/tickets/2/claim')
        ? { ok: false, status: 409, text: 'already claimed' }
        : { ok: true, status: 200, text: '{"ok":true}' });
    const result = await callTool('hotsheet_dispatch_tickets', { worker: 'worker-2', ticket_ids: [1, 2, 3] }, tmpDataDir, fetchFn);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ worker: 'worker-2', dispatched: [1, 3], failed: [{ id: 2 }] });
  });

  it('hotsheet_drain_workers — drains one, drains all with all:true, errors on neither', async () => {
    const fetchSpy = vi.fn();
    const fetchFn = fakeFetch((url, init) => { fetchSpy(url, init); return { ok: true, status: 200, text: '{"ok":true}' }; });
    await callTool('hotsheet_drain_workers', { worker: 'worker-1' }, tmpDataDir, fetchFn);
    expect((fetchSpy.mock.calls[0] as [string])[0]).toBe('http://localhost:4174/api/workers/pool/drain');
    await callTool('hotsheet_drain_workers', { all: true }, tmpDataDir, fetchFn);
    expect((fetchSpy.mock.calls[1] as [string])[0]).toBe('http://localhost:4174/api/workers/pool/drain-all');
    const neither = await callTool('hotsheet_drain_workers', {}, tmpDataDir, vi.fn());
    expect(neither.isError).toBe(true);
  });
});
