import { describe, expect, it } from 'vitest';

import {
  type BrokerMessage,
  type ClientMessage,
  encodeFrame,
  FrameSplitter,
  parseBrokerMessage,
  parseClientMessage,
  PROTOCOL_VERSION,
} from './protocol.js';

describe('broker protocol framing', () => {
  it('encodeFrame produces one newline-terminated JSON line', () => {
    const msg: ClientMessage = { t: 'ping' };
    const frame = encodeFrame(msg);
    expect(frame.endsWith('\n')).toBe(true);
    expect(frame.indexOf('\n')).toBe(frame.length - 1);
    expect(JSON.parse(frame.trimEnd())).toEqual(msg);
  });

  it('round-trips a client spawn message', () => {
    const msg: ClientMessage = {
      t: 'spawn',
      spec: { sessionId: 'sec::term', command: 'echo hi', cwd: '/tmp', cols: 80, rows: 24, env: { A: '1' }, meta: { origin: 'dynamic' } },
    };
    const parsed = parseClientMessage(encodeFrame(msg).trimEnd());
    expect(parsed).toEqual(msg);
  });

  it('round-trips a broker data message with base64 payload', () => {
    const payload = Buffer.from('héllo \x1b[31m', 'utf8').toString('base64');
    const msg: BrokerMessage = { t: 'data', sessionId: 'sec::term', data: payload };
    const parsed = parseBrokerMessage(encodeFrame(msg).trimEnd());
    expect(parsed).toEqual(msg);
    // and the payload decodes back to the original bytes
    expect(Buffer.from((parsed as { data: string }).data, 'base64').toString('utf8')).toBe('héllo \x1b[31m');
  });

  it('FrameSplitter reassembles a frame split across chunks', () => {
    const s = new FrameSplitter();
    const frame = encodeFrame({ t: 'pong' });
    const mid = Math.floor(frame.length / 2);
    expect(s.push(frame.slice(0, mid))).toEqual([]);
    const out = s.push(frame.slice(mid));
    expect(out).toEqual([frame.trimEnd()]);
  });

  it('FrameSplitter yields multiple frames from one chunk and buffers a partial tail', () => {
    const s = new FrameSplitter();
    const a = encodeFrame({ t: 'ping' });
    const b = encodeFrame({ t: 'list' });
    const c = encodeFrame({ t: 'shutdown' });
    // a + b complete, c partial (no trailing newline yet)
    const chunk = a + b + c.slice(0, c.length - 1);
    expect(s.push(chunk)).toEqual([a.trimEnd(), b.trimEnd()]);
    // the newline completes c
    expect(s.push('\n')).toEqual([c.trimEnd()]);
  });

  it('FrameSplitter skips empty lines', () => {
    const s = new FrameSplitter();
    expect(s.push('\n\n' + encodeFrame({ t: 'ping' }))).toEqual([JSON.stringify({ t: 'ping' })]);
  });

  it('FrameSplitter throws if the buffer grows past the cap without a newline', () => {
    const s = new FrameSplitter(16);
    expect(() => s.push('x'.repeat(17))).toThrow(/buffer exceeded/);
  });

  it('parse* return null on malformed JSON', () => {
    expect(parseClientMessage('{not json')).toBeNull();
    expect(parseBrokerMessage('')).toBeNull();
  });

  it('parse* return null when the frame is not a tagged object', () => {
    expect(parseClientMessage('42')).toBeNull();
    expect(parseClientMessage('{"noTag":true}')).toBeNull();
    expect(parseBrokerMessage('[1,2,3]')).toBeNull();
  });

  it('PROTOCOL_VERSION is a positive integer', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});
