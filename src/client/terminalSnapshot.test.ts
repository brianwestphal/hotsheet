// @vitest-environment happy-dom
/**
 * HS-7999 — `terminalSnapshot.ts` covers the freeze + temp-resize +
 * serialize + restore + replay dance against a `terminalCheckout`
 * entry's PTY. happy-dom doesn't ship a WebSocket so the full
 * end-to-end orchestration is hard to drive — these tests focus on
 * the pure helper (`dropBeforeSecondClear`) plus the surface-level
 * "no entry / no socket" early-return paths.
 *
 * The interesting integration test (real WS, real PTY, capture the
 * actual 200×80 redraw) belongs in a Playwright e2e — out of scope
 * for the v1 ticket but filed as a follow-up.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { _resetForTesting } from './terminalCheckout.js';
import { captureTerminalSnapshot, dropBeforeSecondClear, streamHasVisibleContent } from './terminalSnapshot.js';

afterEach(() => {
  _resetForTesting();
  document.body.innerHTML = '';
});

describe('dropBeforeSecondClear (HS-7999)', () => {
  const ESC = 0x1b;
  const SEQ = new Uint8Array([ESC, 0x5b, 0x32, 0x4a, ESC, 0x5b, 0x48]); // \x1b[2J\x1b[H

  function concat(...arrays: Uint8Array[]): Uint8Array {
    const total = arrays.reduce((s, a) => s + a.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) { out.set(a, offset); offset += a.byteLength; }
    return out;
  }

  it('returns empty when no clear-and-home is present', () => {
    const bytes = new TextEncoder().encode('plain text with no clear sequence');
    expect(dropBeforeSecondClear(bytes).byteLength).toBe(0);
  });

  it('returns empty when only one clear-and-home is present', () => {
    const bytes = concat(
      new TextEncoder().encode('first redraw '),
      SEQ,
      new TextEncoder().encode(' contents'),
    );
    expect(dropBeforeSecondClear(bytes).byteLength).toBe(0);
  });

  it('returns everything from the second clear-and-home onwards', () => {
    const bytes = concat(
      new TextEncoder().encode('pre-first '),
      SEQ,
      new TextEncoder().encode('mid-content '),
      SEQ,
      new TextEncoder().encode('post-second tail'),
    );
    const out = dropBeforeSecondClear(bytes);
    // The output should start at the second SEQ.
    expect(out.byteLength).toBe(SEQ.byteLength + 'post-second tail'.length);
    // First 7 bytes should be the SEQ itself.
    for (let i = 0; i < SEQ.byteLength; i += 1) {
      expect(out[i]).toBe(SEQ[i]);
    }
    // Tail content survives.
    const tail = new TextDecoder().decode(out.subarray(SEQ.byteLength));
    expect(tail).toBe('post-second tail');
  });

  it('handles back-to-back clear sequences (treats the second occurrence as the boundary)', () => {
    const bytes = concat(SEQ, SEQ, new TextEncoder().encode('after'));
    const out = dropBeforeSecondClear(bytes);
    // Output starts at the second SEQ and includes everything from there.
    expect(out.byteLength).toBe(SEQ.byteLength + 'after'.length);
    const tail = new TextDecoder().decode(out.subarray(SEQ.byteLength));
    expect(tail).toBe('after');
  });

  it('handles the second SEQ at the very end of the buffer', () => {
    const bytes = concat(SEQ, new TextEncoder().encode('mid '), SEQ);
    const out = dropBeforeSecondClear(bytes);
    expect(out.byteLength).toBe(SEQ.byteLength);
  });

  it('partial SEQ-prefix overlap is NOT a false-positive match', () => {
    // \x1b[2J followed by some unrelated bytes should NOT match the
    // full SEQ.
    const partial = new Uint8Array([ESC, 0x5b, 0x32, 0x4a]); // \x1b[2J only
    const bytes = concat(SEQ, partial, new TextEncoder().encode(' filler '), partial);
    expect(dropBeforeSecondClear(bytes).byteLength).toBe(0);
  });
});

describe('streamHasVisibleContent (HS-8158)', () => {
  it('returns false for an empty stream', () => {
    expect(streamHasVisibleContent('')).toBe(false);
  });

  it('returns false for a stream of only whitespace', () => {
    expect(streamHasVisibleContent('   \n\t\r  ')).toBe(false);
  });

  it('returns false for a stream of only ANSI CSI escape sequences', () => {
    // Common Claude-Code-style structural redraw: clear screen + cursor home + colour reset.
    const stream = '\x1b[2J\x1b[H\x1b[0m\x1b[?25l\x1b[?25h\x1b[39;49m';
    expect(streamHasVisibleContent(stream)).toBe(false);
  });

  it('returns false for ANSI CSI sequences interspersed with whitespace', () => {
    const stream = '\x1b[2J\x1b[H   \x1b[1;1H\n\n\x1b[2;1H\t\x1b[0m';
    expect(streamHasVisibleContent(stream)).toBe(false);
  });

  it('returns false for OSC sequences (BEL terminator)', () => {
    const stream = '\x1b]0;Window Title\x07\x1b]2;Other\x07';
    expect(streamHasVisibleContent(stream)).toBe(false);
  });

  it('returns false for OSC sequences (ST terminator)', () => {
    const stream = '\x1b]52;c;abc\x1b\\';
    expect(streamHasVisibleContent(stream)).toBe(false);
  });

  it('returns true when a printable character escapes the stripping', () => {
    const stream = '\x1b[2J\x1b[Hhello\x1b[0m';
    expect(streamHasVisibleContent(stream)).toBe(true);
  });

  it('returns true for a stream where the only printable char is wedged between sequences', () => {
    const stream = '\x1b[1;1H\x1b[31mX\x1b[0m\x1b[2;1H';
    expect(streamHasVisibleContent(stream)).toBe(true);
  });

  it('returns true for plain text with no escape sequences', () => {
    expect(streamHasVisibleContent('Do you want to overwrite ascii-art.py?')).toBe(true);
  });

  it('treats non-breaking space + other unicode whitespace as not visible', () => {
    expect(streamHasVisibleContent('  　')).toBe(false);
  });

  it('returns true even when most bytes are control sequences (one printable suffices)', () => {
    // The user's 2026-05-04 HS-8158 repro: a redraw that almost entirely
    // consists of cursor / colour resets, with ONE meaningful char.
    const stream = '\x1b[2J\x1b[H\x1b[?25l' + 'A'.repeat(1) + '\x1b[?25h';
    expect(streamHasVisibleContent(stream)).toBe(true);
  });
});

describe('captureTerminalSnapshot — early-return paths (HS-7999)', () => {
  it('returns null when no entry exists for the (secret, terminalId)', async () => {
    const result = await captureTerminalSnapshot('nonexistent-secret', 'no-such-terminal', {
      tempCols: 200,
      tempRows: 80,
    });
    expect(result).toBeNull();
  });

  // Note: testing the "ws is null" path requires an entry to exist,
  // which in turn requires a real `checkout(...)` call. Under happy-dom
  // `WebSocket` is undefined so checkout creates the entry with `ws:null`
  // — exactly the path we want to assert on. The test is a touch
  // indirect: drive `checkout` via dynamic import + capture, drive
  // `captureTerminalSnapshot`, assert null.
  it('returns null when the entry has no open WebSocket (happy-dom path)', async () => {
    const { checkout } = await import('./terminalCheckout.js');
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const handle = checkout({ projectSecret: 's', terminalId: 't', cols: 80, rows: 24, mountInto: mount });
    try {
      const result = await captureTerminalSnapshot('s', 't', { tempCols: 200, tempRows: 80 });
      expect(result).toBeNull();
    } finally {
      handle.release();
    }
  });
});
