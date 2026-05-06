/**
 * HS-8220 — Tests for `oscScanner.ts`.
 *
 * The scanner runs on every PTY chunk in `registry.ts::spawnIntoSession`'s
 * `pty.onData` handler, so a regression here breaks the bell + OSC 9
 * notification + OSC 7 CWD UIs at once. Pre-HS-8220 there was no test
 * coverage on the module — this suite locks the documented behaviour
 * (HS-6766 cross-chunk OSC tracking, HS-7264 OSC 9 notification, HS-7278
 * OSC 7 CWD push) plus the iTerm2 numeric sub-command rejection and the
 * `MAX_OSC_PAYLOAD_LEN` heap cap.
 */
import { describe, expect, it } from 'vitest';

import { MAX_OSC_PAYLOAD_LEN, type OscScanState, scanPtyChunk } from './oscScanner.js';

function freshState(): OscScanState {
  return {
    bellScanInString: false,
    bellScanAfterEsc: false,
    oscAccumulator: null,
  };
}

const BEL = '\x07';
const ESC = '\x1b';
const ST = `${ESC}\\`; // String Terminator: ESC + backslash

describe('scanPtyChunk — bell detection', () => {
  it('returns bell=true for a plain `\\x07` byte', () => {
    const state = freshState();
    const result = scanPtyChunk(state, Buffer.from(BEL));
    expect(result.bell).toBe(true);
    expect(result.osc9Message).toBeNull();
    expect(result.osc7Cwd).toBeNull();
  });

  it('returns bell=false for an empty chunk', () => {
    const result = scanPtyChunk(freshState(), Buffer.from(''));
    expect(result.bell).toBe(false);
  });

  it('returns bell=false for plain text', () => {
    const result = scanPtyChunk(freshState(), Buffer.from('hello world\n'));
    expect(result.bell).toBe(false);
  });

  it('detects bell among other text', () => {
    const result = scanPtyChunk(freshState(), Buffer.from(`abc${BEL}def`));
    expect(result.bell).toBe(true);
  });
});

describe('scanPtyChunk — OSC-string BEL is not a bell (HS-6766)', () => {
  it('treats `\\x1b]0;TITLE\\x07` as a title push, NOT a bell', () => {
    const result = scanPtyChunk(freshState(), Buffer.from(`${ESC}]0;My Title${BEL}`));
    expect(result.bell).toBe(false);
  });

  it('treats `\\x1b]7;file:///cwd\\x07` as a CWD push, NOT a bell', () => {
    const result = scanPtyChunk(freshState(), Buffer.from(`${ESC}]7;file:///Users/foo${BEL}`));
    expect(result.bell).toBe(false);
    expect(result.osc7Cwd).toBe('/Users/foo');
  });

  it('treats real bell BEFORE an OSC sequence as a bell', () => {
    const result = scanPtyChunk(freshState(), Buffer.from(`${BEL}${ESC}]0;Title${BEL}`));
    expect(result.bell).toBe(true);
  });

  it('treats real bell AFTER an OSC sequence as a bell', () => {
    const result = scanPtyChunk(freshState(), Buffer.from(`${ESC}]0;Title${BEL}${BEL}`));
    expect(result.bell).toBe(true);
  });
});

describe('scanPtyChunk — ST terminator (ESC \\\\)', () => {
  it('closes an OSC string with `ESC\\\\` (ST) instead of BEL', () => {
    const result = scanPtyChunk(freshState(), Buffer.from(`${ESC}]9;Hello${ST}`));
    expect(result.bell).toBe(false);
    expect(result.osc9Message).toBe('Hello');
  });

  it('a real bell after an ST-terminated OSC is still a bell', () => {
    const result = scanPtyChunk(freshState(), Buffer.from(`${ESC}]0;Title${ST}${BEL}`));
    expect(result.bell).toBe(true);
  });
});

describe('scanPtyChunk — OSC 9 desktop notification (HS-7264)', () => {
  it('extracts the message from `\\x1b]9;<text>\\x07`', () => {
    const result = scanPtyChunk(freshState(), Buffer.from(`${ESC}]9;Build complete${BEL}`));
    expect(result.osc9Message).toBe('Build complete');
  });

  it('rejects iTerm2 numeric sub-commands like `9;1;50` (progress notifications)', () => {
    const result = scanPtyChunk(freshState(), Buffer.from(`${ESC}]9;1;50${BEL}`));
    expect(result.osc9Message).toBeNull();
  });

  it('rejects `9;4;...` numeric sub-command form', () => {
    const result = scanPtyChunk(freshState(), Buffer.from(`${ESC}]9;4;abc${BEL}`));
    expect(result.osc9Message).toBeNull();
  });

  it('accepts a message that starts with a digit but is not `<digit>;<rest>`', () => {
    const result = scanPtyChunk(freshState(), Buffer.from(`${ESC}]9;42 errors found${BEL}`));
    expect(result.osc9Message).toBe('42 errors found');
  });

  it('returns the LAST OSC 9 message when a chunk contains multiple', () => {
    const chunk = `${ESC}]9;First${BEL}${ESC}]9;Second${BEL}${ESC}]9;Third${BEL}`;
    const result = scanPtyChunk(freshState(), Buffer.from(chunk));
    expect(result.osc9Message).toBe('Third');
  });

  /** HS-8220 — the scanner accumulates payload bytes via
   *  `String.fromCharCode(b)`, which treats each byte as a Latin-1 code
   *  point and mojibake-corrupts multi-byte UTF-8 sequences. Filed
   *  HS-8230 as a follow-up. The test below pins the current ASCII
   *  behaviour; multi-byte UTF-8 is documented as unsupported. */
  it('preserves ASCII content in the notification message', () => {
    const result = scanPtyChunk(freshState(), Buffer.from(`${ESC}]9;Build PASSED${BEL}`));
    expect(result.osc9Message).toBe('Build PASSED');
  });
});

describe('scanPtyChunk — OSC 7 CWD push (HS-7278)', () => {
  it('extracts the path from `\\x1b]7;file:///Users/foo\\x07`', () => {
    const result = scanPtyChunk(freshState(), Buffer.from(`${ESC}]7;file:///Users/foo${BEL}`));
    expect(result.osc7Cwd).toBe('/Users/foo');
  });

  it('extracts the path with a host prefix like `file://localhost/Users/foo`', () => {
    const result = scanPtyChunk(freshState(), Buffer.from(`${ESC}]7;file://localhost/Users/foo${BEL}`));
    expect(result.osc7Cwd).toBe('/Users/foo');
  });

  it('decodes percent-encoded bytes in the path', () => {
    const result = scanPtyChunk(freshState(), Buffer.from(`${ESC}]7;file:///Users/foo%20bar${BEL}`));
    expect(result.osc7Cwd).toBe('/Users/foo bar');
  });

  it('rejects an OSC 7 payload that does NOT start with `file://`', () => {
    const result = scanPtyChunk(freshState(), Buffer.from(`${ESC}]7;notafile${BEL}`));
    expect(result.osc7Cwd).toBeNull();
  });

  it('rejects an OSC 7 payload with no path component', () => {
    const result = scanPtyChunk(freshState(), Buffer.from(`${ESC}]7;file://host${BEL}`));
    expect(result.osc7Cwd).toBeNull();
  });

  it('rejects an OSC 7 payload with malformed percent-encoding', () => {
    // `%XX` where X isn't hex — `decodeURIComponent` throws, caught and returns null.
    const result = scanPtyChunk(freshState(), Buffer.from(`${ESC}]7;file:///foo%ZZbar${BEL}`));
    expect(result.osc7Cwd).toBeNull();
  });

  it('returns the LAST OSC 7 CWD when a chunk contains multiple', () => {
    const chunk = `${ESC}]7;file:///a${BEL}${ESC}]7;file:///b${BEL}${ESC}]7;file:///c${BEL}`;
    const result = scanPtyChunk(freshState(), Buffer.from(chunk));
    expect(result.osc7Cwd).toBe('/c');
  });
});

describe('scanPtyChunk — cross-chunk state', () => {
  it('carries an OSC string across chunks (HS-6766)', () => {
    const state = freshState();
    // First chunk: OSC introducer + part of payload.
    const r1 = scanPtyChunk(state, Buffer.from(`${ESC}]9;Build `));
    expect(r1.bell).toBe(false);
    expect(r1.osc9Message).toBeNull();
    expect(state.bellScanInString).toBe(true);

    // Second chunk: rest of payload + BEL terminator.
    const r2 = scanPtyChunk(state, Buffer.from(`complete${BEL}`));
    expect(r2.bell).toBe(false);
    expect(r2.osc9Message).toBe('Build complete');
    expect(state.bellScanInString).toBe(false);
  });

  it('carries the ESC introducer across chunks', () => {
    const state = freshState();
    const r1 = scanPtyChunk(state, Buffer.from(ESC));
    expect(r1.bell).toBe(false);
    expect(state.bellScanAfterEsc).toBe(true);

    const r2 = scanPtyChunk(state, Buffer.from(`]0;Title${BEL}`));
    expect(r2.bell).toBe(false);
    expect(state.bellScanInString).toBe(false);
    expect(state.bellScanAfterEsc).toBe(false);
  });

  it('carries the ST first byte (ESC) across chunks within an OSC string', () => {
    const state = freshState();
    // Open OSC.
    scanPtyChunk(state, Buffer.from(`${ESC}]9;Hello`));
    // First half of ST: ESC alone, ending the chunk.
    const r1 = scanPtyChunk(state, Buffer.from(ESC));
    expect(r1.osc9Message).toBeNull();
    expect(state.bellScanAfterEsc).toBe(true);
    expect(state.bellScanInString).toBe(true);
    // Second half: backslash terminator.
    const r2 = scanPtyChunk(state, Buffer.from('\\'));
    expect(r2.osc9Message).toBe('Hello');
    expect(state.bellScanInString).toBe(false);
  });

  it('a bell INSIDE an open OSC string is the terminator, not a bell', () => {
    const state = freshState();
    // Open OSC.
    scanPtyChunk(state, Buffer.from(`${ESC}]0;Title`));
    expect(state.bellScanInString).toBe(true);
    // Send the BEL alone — closes the string, NOT a bell.
    const r = scanPtyChunk(state, Buffer.from(BEL));
    expect(r.bell).toBe(false);
    expect(state.bellScanInString).toBe(false);
  });
});

describe('scanPtyChunk — DCS / APC / PM / SOS string escapes', () => {
  it('treats `ESC P ... BEL` (DCS) as a non-bell string with no payload tracking', () => {
    const state = freshState();
    const r = scanPtyChunk(state, Buffer.from(`${ESC}Psome dcs payload${BEL}`));
    expect(r.bell).toBe(false);
    expect(r.osc9Message).toBeNull();
    expect(r.osc7Cwd).toBeNull();
    expect(state.oscAccumulator).toBeNull(); // no payload allocation for DCS
  });

  it('treats `ESC _ ... BEL` (APC) as a non-bell string', () => {
    const r = scanPtyChunk(freshState(), Buffer.from(`${ESC}_apc payload${BEL}`));
    expect(r.bell).toBe(false);
  });

  it('treats `ESC ^ ... BEL` (PM) as a non-bell string', () => {
    const r = scanPtyChunk(freshState(), Buffer.from(`${ESC}^pm payload${BEL}`));
    expect(r.bell).toBe(false);
  });

  it('treats `ESC X ... BEL` (SOS) as a non-bell string', () => {
    const r = scanPtyChunk(freshState(), Buffer.from(`${ESC}Xsos payload${BEL}`));
    expect(r.bell).toBe(false);
  });
});

describe('scanPtyChunk — non-string ESC sequences', () => {
  it('a CSI sequence followed by a BEL still registers the BEL as a bell', () => {
    // ESC[31m = "set fg red" (CSI), then BEL.
    const r = scanPtyChunk(freshState(), Buffer.from(`${ESC}[31m${BEL}`));
    expect(r.bell).toBe(true);
  });

  it('a charset-switch escape (ESC ( 0) followed by a BEL still registers a bell', () => {
    const r = scanPtyChunk(freshState(), Buffer.from(`${ESC}(0${BEL}`));
    expect(r.bell).toBe(true);
  });
});

describe('scanPtyChunk — OSC payload heap cap', () => {
  it(`stops accumulating payload past MAX_OSC_PAYLOAD_LEN (${MAX_OSC_PAYLOAD_LEN}) bytes`, () => {
    const state = freshState();
    // A pathological OSC 9 stream that's far longer than the cap.
    const oversized = 'a'.repeat(MAX_OSC_PAYLOAD_LEN + 1000);
    const r = scanPtyChunk(state, Buffer.from(`${ESC}]9;${oversized}${BEL}`));
    expect(r.bell).toBe(false);
    // The cap kicks in mid-payload, so the recovered message is at most
    // MAX_OSC_PAYLOAD_LEN chars (minus the `9;` prefix consumed by
    // finishOscString). We just assert the soft bound — the precise
    // truncation point isn't part of the contract.
    expect(r.osc9Message).not.toBeNull();
    expect(r.osc9Message!.length).toBeLessThanOrEqual(MAX_OSC_PAYLOAD_LEN);
  });

  it('a normal-length OSC 9 message is preserved exactly', () => {
    const message = 'a normal notification message';
    const r = scanPtyChunk(freshState(), Buffer.from(`${ESC}]9;${message}${BEL}`));
    expect(r.osc9Message).toBe(message);
  });
});

describe('scanPtyChunk — title / hyperlink OSCs that pass through', () => {
  it('returns no osc9/osc7 for a title OSC (`\\x1b]0;...\\x07`)', () => {
    const r = scanPtyChunk(freshState(), Buffer.from(`${ESC}]0;Title${BEL}`));
    expect(r.bell).toBe(false);
    expect(r.osc9Message).toBeNull();
    expect(r.osc7Cwd).toBeNull();
  });

  it('returns no osc9/osc7 for an OSC 8 hyperlink (`\\x1b]8;;https://...\\x07`)', () => {
    const r = scanPtyChunk(freshState(), Buffer.from(`${ESC}]8;;https://example.com${BEL}link${ESC}]8;;${BEL}`));
    expect(r.bell).toBe(false);
    expect(r.osc9Message).toBeNull();
    expect(r.osc7Cwd).toBeNull();
  });

  it('returns no osc9/osc7 for an unknown OSC number (`\\x1b]42;payload\\x07`)', () => {
    const r = scanPtyChunk(freshState(), Buffer.from(`${ESC}]42;custom${BEL}`));
    expect(r.bell).toBe(false);
    expect(r.osc9Message).toBeNull();
    expect(r.osc7Cwd).toBeNull();
  });
});

describe('scanPtyChunk — mixed-content chunks', () => {
  it('returns bell + osc9 + osc7 from a single chunk that contains all three', () => {
    const chunk =
      `${ESC}]7;file:///cwd${BEL}` +
      `prompt $ ` +
      BEL +
      `${ESC}]9;notify${BEL}`;
    const r = scanPtyChunk(freshState(), Buffer.from(chunk));
    expect(r.bell).toBe(true);
    expect(r.osc9Message).toBe('notify');
    expect(r.osc7Cwd).toBe('/cwd');
  });
});
