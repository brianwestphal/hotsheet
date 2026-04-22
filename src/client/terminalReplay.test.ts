import { describe, expect, it } from 'vitest';

import { type ReplayableTerm,replayHistoryToTerm } from './terminalReplay.js';

/**
 * `replayHistoryToTerm` is the extracted history-replay helper at the heart
 * of the HS-6799 fix. It must resize the receiving xterm to the history's
 * origin dims BEFORE writing the bytes — the reverse order is what produced
 * the stray glyphs at the top of production-build terminals.
 */
describe('replayHistoryToTerm (HS-6799)', () => {
  function makeFakeTerm() {
    const operations: { op: 'resize' | 'write'; payload: unknown }[] = [];
    const term: ReplayableTerm = {
      resize(cols, rows) { operations.push({ op: 'resize', payload: [cols, rows] }); },
      write(data) { operations.push({ op: 'write', payload: data }); },
    };
    return { term, operations };
  }

  it('resizes the terminal BEFORE writing the history bytes', () => {
    const { term, operations } = makeFakeTerm();
    // Base64 for the literal string 'hi' — any non-empty payload works; the
    // order of operations is what matters.
    replayHistoryToTerm(term, { bytes: 'aGk=', cols: 120, rows: 40 });
    expect(operations).toHaveLength(2);
    expect(operations[0].op).toBe('resize');
    expect(operations[0].payload).toEqual([120, 40]);
    expect(operations[1].op).toBe('write');
  });

  it('uses the exact cols/rows from the history frame (no defaulting to xterm 80×24)', () => {
    const { term, operations } = makeFakeTerm();
    replayHistoryToTerm(term, { bytes: 'aGk=', cols: 200, rows: 60 });
    const resizeOp = operations.find(o => o.op === 'resize');
    expect(resizeOp?.payload).toEqual([200, 60]);
  });

  it('skips resize when cols/rows are missing or non-finite', () => {
    const { term, operations } = makeFakeTerm();
    replayHistoryToTerm(term, { bytes: 'aGk=', cols: NaN, rows: 40 });
    expect(operations.some(o => o.op === 'resize')).toBe(false);
    expect(operations.some(o => o.op === 'write')).toBe(true);
  });

  it('skips resize when cols/rows are zero or negative (no-op rather than crashing xterm)', () => {
    const { term, operations } = makeFakeTerm();
    replayHistoryToTerm(term, { bytes: 'aGk=', cols: 0, rows: 0 });
    expect(operations.some(o => o.op === 'resize')).toBe(false);
  });

  it('skips write when the history payload is empty but still resizes', () => {
    const { term, operations } = makeFakeTerm();
    replayHistoryToTerm(term, { bytes: '', cols: 100, rows: 30 });
    expect(operations).toHaveLength(1);
    expect(operations[0].op).toBe('resize');
    expect(operations[0].payload).toEqual([100, 30]);
  });

  it('decodes base64 history payload as raw bytes and forwards to write()', () => {
    const { term, operations } = makeFakeTerm();
    // 'hello' → base64 = 'aGVsbG8='
    replayHistoryToTerm(term, { bytes: 'aGVsbG8=', cols: 80, rows: 24 });
    const writeOp = operations.find(o => o.op === 'write');
    expect(writeOp).toBeDefined();
    const bytes = writeOp!.payload as Uint8Array;
    expect(Array.from(bytes)).toEqual([0x68, 0x65, 0x6c, 0x6c, 0x6f]);
  });
});
