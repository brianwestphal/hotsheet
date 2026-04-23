import { describe, expect, it } from 'vitest';

import { applyDedicatedHistoryFrame, type Fittable,type ReplayableTerm,replayHistoryToTerm } from './terminalReplay.js';

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

/**
 * HS-7063: the dashboard's dedicated view (terminalDashboard.tsx
 * `enterDedicatedView`) must re-fit after a history-frame replay. Replay
 * resizes xterm to the history's cols × rows (correct — the bytes were
 * formatted at those dims), which fires xterm's `onResize`; the dedicated
 * view relays that to the server, which shrinks the server-side PTY. For a
 * peek view (grid / centered tile) that is intentional, but in the dedicated
 * view the user wants TUIs like nano to fill the full pane. Without the
 * follow-up fit, nano stays at the prior attacher's dims and leaves the
 * bottom of the pane empty (observed in HS-7063 screenshots — nano's status
 * bar appeared in the middle of a half-empty dedicated view).
 */
describe('applyDedicatedHistoryFrame (HS-7063)', () => {
  function makeFakeTerm() {
    const operations: { op: 'resize' | 'write' | 'fit'; payload: unknown }[] = [];
    const term: ReplayableTerm = {
      resize(cols, rows) { operations.push({ op: 'resize', payload: [cols, rows] }); },
      write(data) { operations.push({ op: 'write', payload: data }); },
    };
    return { term, operations };
  }

  function makeFakeFit(operations: { op: string; payload: unknown }[], onFit?: () => void): Fittable {
    return {
      fit() {
        operations.push({ op: 'fit', payload: null });
        onFit?.();
      },
    };
  }

  it('calls fit() AFTER the history replay so the PTY grows back to the pane size', () => {
    const { term, operations } = makeFakeTerm();
    const fit = makeFakeFit(operations);

    applyDedicatedHistoryFrame(term, fit, { bytes: 'aGk=', cols: 195, rows: 13 });

    // Sequence: resize (history dims) → write (bytes) → fit (restore pane dims).
    // If fit fires BEFORE replay, xterm is at fit dims and then resized down to
    // history dims, leaving the PTY shrunken — the HS-7063 bug. If fit doesn't
    // fire at all (the pre-fix behavior), the PTY stays at the history dims.
    const seq = operations.map(o => o.op);
    expect(seq).toEqual(['resize', 'write', 'fit']);
    expect(operations[0].payload).toEqual([195, 13]);
  });

  it('swallows fit() errors so a mid-mount call does not break replay', () => {
    const { term, operations } = makeFakeTerm();
    const fit: Fittable = {
      fit() { throw new Error('body not laid out'); },
    };
    // Should not throw — the caller's replay has already succeeded.
    expect(() => applyDedicatedHistoryFrame(term, fit, { bytes: 'aGk=', cols: 100, rows: 30 })).not.toThrow();
    // History replay still fully completed.
    expect(operations.map(o => o.op)).toEqual(['resize', 'write']);
  });

  it('when fit() resizes xterm, the resize call happens AFTER the history bytes are written', () => {
    // Simulates the real fit addon — it would call term.resize(paneCols, paneRows)
    // synchronously inside fit(). Verifies the final resize call wins.
    const { term, operations } = makeFakeTerm();
    const fit: Fittable = {
      fit() {
        operations.push({ op: 'fit', payload: null });
        term.resize(187, 50);
      },
    };

    applyDedicatedHistoryFrame(term, fit, { bytes: 'aGk=', cols: 195, rows: 13 });

    const seq = operations.map(o => o.op);
    expect(seq).toEqual(['resize', 'write', 'fit', 'resize']);
    // The LAST resize is the fit-driven one — that's what gets relayed to the
    // server and survives as the terminal's final geometry.
    const resizes = operations.filter(o => o.op === 'resize');
    expect(resizes[resizes.length - 1].payload).toEqual([187, 50]);
  });
});
