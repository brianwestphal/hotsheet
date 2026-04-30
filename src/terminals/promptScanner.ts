/**
 * HS-8029 Phase 1 — server-side terminal prompt scanner.
 *
 * One scanner per `TerminalSession`. Owns a small `@xterm/headless` instance
 * sized for the visible-prompt region only (`SCANNER_COLS` × `SCANNER_ROWS`)
 * and feeds it every PTY chunk that flows through the session. After a
 * 100 ms debounce post-chunk, runs the shared parser registry over the last
 * `SCAN_ROW_COUNT` visible rows; on a fresh match (signature differs from
 * the last dispatched) calls `hooks.onMatch`.
 *
 * Per HS-8030 the user picked **option 2** — "light VT parser, off-the-shelf
 * first". `@xterm/headless` is xterm.js's official Node build with no
 * renderer / DOM (zero-dep, ~2 MB unpacked). Reuses the parser registry
 * verbatim with the existing 32 unit tests still applying.
 *
 * The scanner deliberately keeps a small back-buffer (`scrollback: 50`)
 * because per the user, "we shouldn't need much back buffer -- just
 * probably enough to handle the longest questions that claude can show".
 * Claude-Ink prompts top out around 25 rows (HS-7980 diff-prompt context);
 * 50 visible rows + 50 scrollback gives us comfortable headroom.
 */

// `@xterm/headless`'s package.json `main` points to a CJS bundle and there's
// no `exports` field, so Node's ESM loader can't reach the named `Terminal`
// export with `import { Terminal } from '@xterm/headless'`. Use a default
// import + destructure — Node ESM exposes a CJS module's `module.exports`
// as the default export. TypeScript's `esModuleInterop` makes the syntax
// work for both compile-time + runtime.
import xtermHeadless from '@xterm/headless';
const { Terminal } = xtermHeadless;

import type { MatchResult } from '../shared/terminalPrompt/parsers.js';
import { runParserRegistry } from '../shared/terminalPrompt/parsers.js';

/** Debounce window — match the client detector (`src/client/terminalPrompt/detector.ts::SCAN_DEBOUNCE_MS`). */
export const SCAN_DEBOUNCE_MS = 100;

/** How many rows from the bottom of the visible buffer to scan. Match the
 *  client detector's `SCAN_ROW_COUNT` (30). */
export const SCAN_ROW_COUNT = 30;

/** Visible rows in the headless terminal. Match `SCAN_ROW_COUNT` so the
 *  visible viewport IS the scan region — output beyond `SCAN_ROW_COUNT`
 *  scrolls into scrollback, keeping the most recent rows in view. Per the
 *  user's HS-8030 directive: "we shouldn't need much back buffer". */
export const SCANNER_ROWS = SCAN_ROW_COUNT;

/** Visible cols in the headless terminal. Most real terminals are 80-200
 *  cols; we pick a generous 200 so wrapped prompt text doesn't lose its
 *  trailing characters. */
export const SCANNER_COLS = 200;

/** Tiny scrollback — just enough for line-wrap reflow on resize, NOT for
 *  the parser (the parser reads viewport rows only). */
export const SCANNER_SCROLLBACK = 50;

export interface PromptScannerHooks {
  /** Fire when a new match is found that differs from the last-dispatched
   *  signature. The scanner's own dedup means this only fires on truly new
   *  prompts, not on repeated scans of the same buffer state. */
  onMatch: (match: MatchResult) => void;
}

export interface PromptScanner {
  /** Feed a PTY data chunk into the headless terminal + schedule a scan. */
  ingest: (chunk: Buffer | Uint8Array | string) => void;
  /** Clear "user said this isn't a prompt" suppression — call when the
   *  client forwards a real PTY input (the user typed into the terminal). */
  notifyUserKeystroke: () => void;
  /** Mark the scanner as suppressed (matches client detector's
   *  `markDetectorSuppressed`). Phase 1 doesn't expose this from the wire
   *  yet — Phase 2 (HS-8029 follow-up) wires the "Resume" toolbar chip to
   *  toggle it via a thin endpoint. */
  setSuppressed: (suppressed: boolean) => void;
  /** Resize the headless terminal so prompt content reflows like the live
   *  terminal does. The PTY is independently sized by the registry. */
  resize: (cols: number, rows: number) => void;
  /** Tear down — clear pending timer + dispose the headless terminal. */
  dispose: () => void;
  /** **TEST ONLY** — flush queued writes + run the scan. Returns a promise
   *  that resolves after the (potential) `onMatch` dispatch. */
  _runScanNowForTesting: () => Promise<void>;
  /** **TEST ONLY** — read the current visible buffer rows for assertions
   *  (after flushing any pending writes). */
  _readRowsForTesting: (rowCount: number) => Promise<string[]>;
}

export function createPromptScanner(hooks: PromptScannerHooks): PromptScanner {
  const term = new Terminal({
    cols: SCANNER_COLS,
    rows: SCANNER_ROWS,
    scrollback: SCANNER_SCROLLBACK,
    // `buffer.active` is a proposed API in @xterm/headless v6 — we need it
    // to read the resolved row contents for the parser registry.
    allowProposedApi: true,
  });

  let pending: ReturnType<typeof setTimeout> | null = null;
  let suppressed = false;
  let lastDispatchedSignature: string | null = null;
  let disposed = false;

  function readRows(rowCount: number): string[] {
    const buf = term.buffer.active;
    const baseY = buf.viewportY;
    const visibleRows = term.rows;
    const out: string[] = [];
    const start = Math.max(0, visibleRows - rowCount);
    for (let i = start; i < visibleRows; i++) {
      const line = buf.getLine(baseY + i);
      out.push(line === undefined ? '' : line.translateToString(true));
    }
    return out;
  }

  /** Run the scan AFTER the xterm parser has digested all queued writes.
   *  xterm.js's `write(data, cb)` queues bytes and only calls `cb` once the
   *  parser has consumed them — without that wait, `buffer.active.getLine()`
   *  reads stale rows. We pass an empty payload so the callback fires
   *  cleanly behind any pending real writes. */
  function runScanAfterFlush(): void {
    if (disposed) return;
    term.write('', () => {
      if (disposed || suppressed) return;
      const rows = readRows(SCAN_ROW_COUNT);
      const match = runParserRegistry(rows);
      if (match === null) {
        lastDispatchedSignature = null;
        return;
      }
      if (match.signature === lastDispatchedSignature) return;
      lastDispatchedSignature = match.signature;
      try { hooks.onMatch(match); } catch { /* subscriber errors don't break the scanner */ }
    });
  }

  function scheduleScan(): void {
    if (disposed) return;
    if (pending !== null) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      runScanAfterFlush();
    }, SCAN_DEBOUNCE_MS);
  }

  return {
    ingest(chunk) {
      if (disposed) return;
      // xterm.js v6 `write` accepts string | Uint8Array directly. Pass raw
      // bytes when possible so xterm's internal UTF-8 decoder handles
      // multi-byte sequences split across chunk boundaries.
      if (typeof chunk === 'string') {
        term.write(chunk);
      } else {
        // Buffer is a subclass of Uint8Array — pass it through directly.
        term.write(chunk);
      }
      scheduleScan();
    },
    notifyUserKeystroke() {
      suppressed = false;
    },
    setSuppressed(value) {
      suppressed = value;
    },
    resize(cols, rows) {
      try { term.resize(Math.max(1, cols), Math.max(1, rows)); } catch { /* ignore */ }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (pending !== null) clearTimeout(pending);
      pending = null;
      try { term.dispose(); } catch { /* ignore */ }
    },
    _runScanNowForTesting() {
      if (pending !== null) { clearTimeout(pending); pending = null; }
      return new Promise<void>((resolve) => {
        if (disposed) { resolve(); return; }
        term.write('', () => {
          if (!disposed && !suppressed) {
            const rows = readRows(SCAN_ROW_COUNT);
            const match = runParserRegistry(rows);
            if (match === null) {
              lastDispatchedSignature = null;
            } else if (match.signature !== lastDispatchedSignature) {
              lastDispatchedSignature = match.signature;
              try { hooks.onMatch(match); } catch { /* swallow */ }
            }
          }
          resolve();
        });
      });
    },
    _readRowsForTesting(rowCount) {
      // For tests — flush the write queue first so callers reading rows see
      // post-parse state. Returns a promise of the rows.
      return new Promise<string[]>((resolve) => {
        if (disposed) { resolve([]); return; }
        term.write('', () => { resolve(readRows(rowCount)); });
      });
    },
  };
}
