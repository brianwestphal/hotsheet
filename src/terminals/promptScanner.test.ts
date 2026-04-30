/**
 * HS-8029 Phase 1 — server-side prompt scanner tests.
 *
 * Drives the scanner with synthetic chunks (mirroring what the PTY would
 * emit) and asserts the parser registry runs against the headless xterm's
 * resolved buffer rows. Uses the test-only `_runScanNowForTesting()` to
 * skip the 100 ms debounce; the helper awaits xterm.js's internal write
 * callback so the parser sees fully-digested bytes (xterm.js queues writes
 * and only updates `buffer.active` after the parser callback fires).
 */
import { describe, expect, it, vi } from 'vitest';

import type { MatchResult } from '../shared/terminalPrompt/parsers.js';
import { createPromptScanner, SCAN_DEBOUNCE_MS, SCAN_ROW_COUNT, SCANNER_COLS, SCANNER_ROWS } from './promptScanner.js';

/** A real-world Claude-Ink dev-channels prompt — same shape covered by
 *  parsers.test.ts. Carriage returns + line feeds emulate the raw PTY
 *  byte stream Claude Code emits. */
const CLAUDE_DEV_CHANNELS_PROMPT = [
  '\r\n',
  'Loading development channels can pose a security risk\r\n',
  '\r\n',
  '> 1. I am using this for local development\r\n',
  '  2. I am not sure, exit\r\n',
  '\r\n',
  'Enter to confirm · Esc to cancel\r\n',
].join('');

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('createPromptScanner — basics', () => {
  it('exposes the documented module constants', () => {
    expect(SCAN_DEBOUNCE_MS).toBe(100);
    expect(SCAN_ROW_COUNT).toBe(30);
    expect(SCANNER_ROWS).toBe(SCAN_ROW_COUNT);
    expect(SCANNER_COLS).toBe(200);
  });

  it('matches a Claude-Ink numbered prompt after ingest', async () => {
    const onMatch = vi.fn();
    const scanner = createPromptScanner({ onMatch });
    scanner.ingest(CLAUDE_DEV_CHANNELS_PROMPT);
    await scanner._runScanNowForTesting();
    expect(onMatch).toHaveBeenCalledTimes(1);
    const dispatched = onMatch.mock.calls[0];
    expect(dispatched).toBeDefined();
    const match = (dispatched as [MatchResult])[0];
    expect(match.parserId).toBe('claude-numbered');
    expect(match.shape).toBe('numbered');
    if (match.shape === 'numbered') {
      expect(match.choices).toHaveLength(2);
      const [first] = match.choices;
      expect(first.highlighted).toBe(true);
      expect(first.label).toBe('I am using this for local development');
    }
    scanner.dispose();
  });

  it('does not re-fire on identical signature', async () => {
    const onMatch = vi.fn();
    const scanner = createPromptScanner({ onMatch });
    scanner.ingest(CLAUDE_DEV_CHANNELS_PROMPT);
    await scanner._runScanNowForTesting();
    // A second scan against the same buffer state must not re-dispatch.
    await scanner._runScanNowForTesting();
    expect(onMatch).toHaveBeenCalledTimes(1);
    scanner.dispose();
  });

  it('does not fire on non-prompt output', async () => {
    const onMatch = vi.fn();
    const scanner = createPromptScanner({ onMatch });
    scanner.ingest('hello world\r\n$ ls\r\nfile.txt\r\n');
    await scanner._runScanNowForTesting();
    expect(onMatch).not.toHaveBeenCalled();
    scanner.dispose();
  });
});

describe('createPromptScanner — debounce', () => {
  it('schedules a scan after the debounce window elapses', async () => {
    const onMatch = vi.fn();
    const scanner = createPromptScanner({ onMatch });
    scanner.ingest(CLAUDE_DEV_CHANNELS_PROMPT);
    // Pre-debounce — scan hasn't run yet (give some real-time buffer to be
    // sure we're not racing the debounce edge).
    await sleep(SCAN_DEBOUNCE_MS / 2);
    expect(onMatch).not.toHaveBeenCalled();
    await sleep(SCAN_DEBOUNCE_MS + 50);
    expect(onMatch).toHaveBeenCalledTimes(1);
    scanner.dispose();
  });

  it('coalesces multiple ingests into a single scan', async () => {
    const onMatch = vi.fn();
    const scanner = createPromptScanner({ onMatch });
    // Three ingests inside the debounce window should produce one scan.
    scanner.ingest('chunk-1\r\n');
    await sleep(20);
    scanner.ingest('chunk-2\r\n');
    await sleep(20);
    scanner.ingest(CLAUDE_DEV_CHANNELS_PROMPT);
    await sleep(SCAN_DEBOUNCE_MS + 50);
    expect(onMatch).toHaveBeenCalledTimes(1);
    scanner.dispose();
  });
});

describe('createPromptScanner — suppression', () => {
  it('skips dispatch while suppressed', async () => {
    const onMatch = vi.fn();
    const scanner = createPromptScanner({ onMatch });
    scanner.setSuppressed(true);
    scanner.ingest(CLAUDE_DEV_CHANNELS_PROMPT);
    await scanner._runScanNowForTesting();
    expect(onMatch).not.toHaveBeenCalled();
    scanner.dispose();
  });

  it('resumes dispatch after notifyUserKeystroke', async () => {
    const onMatch = vi.fn();
    const scanner = createPromptScanner({ onMatch });
    scanner.setSuppressed(true);
    scanner.ingest(CLAUDE_DEV_CHANNELS_PROMPT);
    await scanner._runScanNowForTesting();
    expect(onMatch).not.toHaveBeenCalled();
    scanner.notifyUserKeystroke();
    await scanner._runScanNowForTesting();
    expect(onMatch).toHaveBeenCalledTimes(1);
    scanner.dispose();
  });
});

describe('createPromptScanner — disposal', () => {
  it('clears pending scans on dispose', async () => {
    const onMatch = vi.fn();
    const scanner = createPromptScanner({ onMatch });
    scanner.ingest(CLAUDE_DEV_CHANNELS_PROMPT);
    scanner.dispose();
    await sleep(SCAN_DEBOUNCE_MS + 50);
    expect(onMatch).not.toHaveBeenCalled();
  });

  it('ignores ingests after dispose', async () => {
    const onMatch = vi.fn();
    const scanner = createPromptScanner({ onMatch });
    scanner.dispose();
    // Should not throw + should not record any state.
    scanner.ingest(CLAUDE_DEV_CHANNELS_PROMPT);
    await scanner._runScanNowForTesting();
    expect(onMatch).not.toHaveBeenCalled();
  });
});

describe('createPromptScanner — chunk shapes', () => {
  it('accepts Buffer chunks', async () => {
    const onMatch = vi.fn();
    const scanner = createPromptScanner({ onMatch });
    scanner.ingest(Buffer.from(CLAUDE_DEV_CHANNELS_PROMPT, 'utf8'));
    await scanner._runScanNowForTesting();
    expect(onMatch).toHaveBeenCalledTimes(1);
    scanner.dispose();
  });

  it('accepts Uint8Array chunks', async () => {
    const onMatch = vi.fn();
    const scanner = createPromptScanner({ onMatch });
    scanner.ingest(new TextEncoder().encode(CLAUDE_DEV_CHANNELS_PROMPT));
    await scanner._runScanNowForTesting();
    expect(onMatch).toHaveBeenCalledTimes(1);
    scanner.dispose();
  });

  it('handles a UTF-8 multi-byte glyph split across chunks', async () => {
    const onMatch = vi.fn();
    const scanner = createPromptScanner({ onMatch });
    // The prompt uses `·` (U+00B7) in the footer — split that byte sequence
    // across two ingest calls. xterm's internal decoder must reassemble it.
    const idx = CLAUDE_DEV_CHANNELS_PROMPT.indexOf('·');
    expect(idx).toBeGreaterThan(0);
    const bytes = new TextEncoder().encode(CLAUDE_DEV_CHANNELS_PROMPT);
    // Find the byte offset of the multi-byte glyph by walking utf-8 code points.
    let byteSplit = 0;
    let codepoints = 0;
    while (codepoints < idx) {
      const b = bytes[byteSplit] ?? 0;
      byteSplit += b < 0x80 ? 1 : b < 0xc0 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
      codepoints += 1;
    }
    // Split the · bytes (2 bytes for U+00B7) across two writes.
    scanner.ingest(bytes.slice(0, byteSplit + 1));
    scanner.ingest(bytes.slice(byteSplit + 1));
    await scanner._runScanNowForTesting();
    expect(onMatch).toHaveBeenCalledTimes(1);
    scanner.dispose();
  });
});

describe('createPromptScanner — buffer reads', () => {
  it('returns the trailing visible rows after ingest', async () => {
    const scanner = createPromptScanner({ onMatch: vi.fn() });
    scanner.ingest('line A\r\nline B\r\nline C\r\n');
    const rows = await scanner._readRowsForTesting(SCAN_ROW_COUNT);
    expect(rows.some(r => r.trim() === 'line A')).toBe(true);
    expect(rows.some(r => r.trim() === 'line B')).toBe(true);
    expect(rows.some(r => r.trim() === 'line C')).toBe(true);
    scanner.dispose();
  });
});

describe('createPromptScanner — onMatch error containment', () => {
  it('swallows subscriber errors so the scanner survives', async () => {
    const scanner = createPromptScanner({
      onMatch() { throw new Error('subscriber blew up'); },
    });
    scanner.ingest(CLAUDE_DEV_CHANNELS_PROMPT);
    // The await must not throw — the scanner internally try/catches the
    // subscriber callback so a downstream error doesn't kill the scan loop.
    await expect(scanner._runScanNowForTesting()).resolves.toBeUndefined();
    scanner.dispose();
  });
});
