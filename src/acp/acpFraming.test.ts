import { describe, expect, it } from 'vitest';

import {
  createIdCounter,
  createNdjsonDecoder,
  encodeMessage,
  isNotification,
  isRequest,
  isResponse,
} from './acpFraming.js';

// HS-9330 — the ACP wire framing (newline-delimited JSON-RPC), validated shape
// per the opencode spike (docs/114 §114.11).

describe('encodeMessage', () => {
  it('serializes to a single newline-terminated JSON line', () => {
    expect(encodeMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' }))
      .toBe('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
  });
});

describe('createNdjsonDecoder', () => {
  it('returns each complete JSON object on a chunk', () => {
    const d = createNdjsonDecoder();
    const msgs = d.push('{"id":0,"result":{}}\n{"method":"session/update"}\n');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ id: 0, result: {} });
    expect(msgs[1]).toEqual({ method: 'session/update' });
  });

  it('buffers a partial trailing line until its newline arrives', () => {
    const d = createNdjsonDecoder();
    expect(d.push('{"id":0,')).toEqual([]); // incomplete — nothing yet
    expect(d.push('"result":{}}\n')).toEqual([{ id: 0, result: {} }]);
  });

  it('reassembles an object split across three chunks', () => {
    const d = createNdjsonDecoder();
    expect(d.push('{"a"')).toEqual([]);
    expect(d.push(':1')).toEqual([]);
    expect(d.push('}\n')).toEqual([{ a: 1 }]);
  });

  it('ignores blank lines and skips non-JSON lines without derailing', () => {
    const d = createNdjsonDecoder();
    const msgs = d.push('\n  \nthis is a stray log line\n{"ok":true}\n');
    expect(msgs).toEqual([{ ok: true }]);
  });

  it('skips a JSON array/primitive line (only objects are messages)', () => {
    const d = createNdjsonDecoder();
    expect(d.push('[1,2,3]\n42\n{"m":1}\n')).toEqual([{ m: 1 }]);
  });
});

describe('message discriminators', () => {
  it('isResponse: has id + result/error', () => {
    expect(isResponse({ id: 1, result: {} })).toBe(true);
    expect(isResponse({ id: 1, error: { code: -1 } })).toBe(true);
    expect(isResponse({ id: 1, method: 'x' })).toBe(false); // a request
    expect(isResponse({ method: 'x' })).toBe(false); // a notification
  });

  it('isRequest: has id + method', () => {
    expect(isRequest({ id: 5, method: 'session/request_permission' })).toBe(true);
    expect(isRequest({ id: 5, result: {} })).toBe(false);
    expect(isRequest({ method: 'session/update' })).toBe(false);
  });

  it('isNotification: method with no id', () => {
    expect(isNotification({ method: 'session/update' })).toBe(true);
    expect(isNotification({ id: 1, method: 'x' })).toBe(false);
    expect(isNotification({ id: 1, result: {} })).toBe(false);
  });
});

describe('createIdCounter', () => {
  it('starts at 0 and increments', () => {
    const c = createIdCounter();
    expect([c.next(), c.next(), c.next()]).toEqual([0, 1, 2]);
  });
});
