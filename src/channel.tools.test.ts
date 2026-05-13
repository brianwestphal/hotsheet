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

describe('listTools (HS-8346)', () => {
  it('returns the five Phase-1 tools by name', () => {
    const tools = listTools();
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual([
      'hotsheet_add_attachment',
      'hotsheet_create_ticket',
      'hotsheet_request_feedback',
      'hotsheet_signal_done',
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
    expect(_toolsForTesting).toHaveLength(5);
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
