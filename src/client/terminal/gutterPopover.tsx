/**
 * HS-8194 — OSC 133 gutter-glyph hover popover, extracted from `terminal.tsx`.
 *
 * Each completed prompt record (B/C/D markers from `terminalOsc133.ts`) gets a
 * gutter glyph decoration. Hovering the glyph mounts a small popover offering
 * four actions scoped to that record:
 *
 * - **Copy command** — reads the B→C range (typically the typed command line).
 * - **Copy output** — reads the C→D range (or C→cursor if still running).
 * - **Rerun** — pastes `command + '\r'` through the xterm input path.
 * - **Ask Claude** — gated on `isChannelAlive()` at popover-open time;
 *   dispatches the §33 `buildAskClaudePrompt` template via
 *   `triggerChannelAndMarkBusy`.
 *
 * The popover closes on `mouseleave` from BOTH the glyph AND the popover
 * itself (so the user can move the cursor onto the popover without it
 * disappearing first). A single shared element is reused — only one popover
 * is visible at a time.
 *
 * ### Module-level state
 * Only two slots: `gutterPopoverEl` and `gutterPopoverCloseTimer`. Both are
 * cleared by `closeGutterPopover()`, which `releaseGutterPopover()` exposes
 * for module teardown (the drawer doesn't currently call it; the popover is
 * naturally cleared on mouse-out, on action click, or on a sibling
 * `showGutterPopover` mount).
 *
 * ### Cross-references
 * - Call site: `terminal.tsx::attachGutterDecoration` / `mountInstanceViaCheckout`.
 * - Action helpers (`readRecordCommand` / `readRecordOutput`) live here too —
 *   they're pure xterm-buffer readers and not used outside this popover.
 */
import type { IDecoration, IMarker, Terminal as XTerm } from '@xterm/xterm';

import { raw } from '../../jsx-runtime.js';
import { isChannelAlive, triggerChannelAndMarkBusy } from '../channelUI.js';
import { toElement } from '../dom.js';
import { buildAskClaudePrompt } from '../terminalOsc133.js';
import { POPOVER_CLOSE_DELAY_MS } from '../uiTimings.js';

/** OSC 133 per-prompt record. Mirrors the interface in `terminal.tsx` —
 *  duplicated here intentionally to keep this module dependency-free of the
 *  `TerminalInstance` blob. */
export interface CommandRecord {
  id: number;
  promptStart: IMarker | null;
  commandStart: IMarker | null;
  outputStart: IMarker | null;
  commandEnd: IMarker | null;
  exitCode: number | null;
  /** Decoration attached at promptStart to render the gutter glyph. */
  decoration: IDecoration | null;
}

/** Narrow context for the Ask-Claude action. The popover only needs the
 *  current shell CWD (so the prompt template can omit / include the
 *  `working directory` clause). Caller passes a getter so the popover reads
 *  the live value at click time. */
export interface GutterPopoverContext {
  /** Returns the shell's current OSC 7 CWD, or null if none has been pushed. */
  getCwd: () => string | null;
}

let gutterPopoverEl: HTMLElement | null = null;
let gutterPopoverCloseTimer: number | null = null;

/** Mount the hover popover anchored to a gutter-glyph DOM element. The
 *  popover closes when the mouse leaves the glyph AND the popover, or when
 *  any action button is clicked. */
function showGutterPopover(
  anchor: HTMLElement,
  term: XTerm,
  record: CommandRecord,
  ctx: GutterPopoverContext,
): void {
  if (gutterPopoverCloseTimer !== null) {
    window.clearTimeout(gutterPopoverCloseTimer);
    gutterPopoverCloseTimer = null;
  }
  if (gutterPopoverEl !== null) gutterPopoverEl.remove();

  // HS-7270 — the "Ask Claude" entry only renders when the Claude Channel is
  // alive. Checking at popover open time (not on click) keeps the popover
  // small for users without the channel and matches the gate pattern other
  // channel-dependent affordances use (see channelUI.tsx checkAndTrigger).
  const askClaudeHtml = isChannelAlive()
    ? '<button class="terminal-osc133-popover-btn terminal-osc133-popover-ask" data-action="ask-claude">Ask Claude</button>'
    : '';
  const popover = toElement(
    <div className="terminal-osc133-popover">
      <button className="terminal-osc133-popover-btn" data-action="copy-command">Copy command</button>
      <button className="terminal-osc133-popover-btn" data-action="copy-output">Copy output</button>
      <button className="terminal-osc133-popover-btn" data-action="rerun">Rerun</button>
      {raw(askClaudeHtml)}
    </div>
  );
  document.body.appendChild(popover);

  popover.addEventListener('mouseenter', () => {
    if (gutterPopoverCloseTimer !== null) {
      window.clearTimeout(gutterPopoverCloseTimer);
      gutterPopoverCloseTimer = null;
    }
  });
  popover.addEventListener('mouseleave', () => { scheduleGutterPopoverClose(); });
  popover.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.terminal-osc133-popover-btn');
    if (btn === null) return;
    const action = btn.dataset.action;
    if (action === 'copy-command') void copyCommandOfRecord(term, record);
    else if (action === 'copy-output') void copyOutputOfRecord(term, record);
    else if (action === 'rerun') rerunCommandOfRecord(term, record);
    else if (action === 'ask-claude') askClaudeAboutRecord(term, record, ctx);
    closeGutterPopover();
  });

  // Position flush-left of the gutter glyph, vertically centered on it.
  const rect = anchor.getBoundingClientRect();
  popover.style.position = 'fixed';
  popover.style.left = `${rect.right + 6}px`;
  popover.style.top = `${rect.top + rect.height / 2}px`;
  popover.style.transform = 'translateY(-50%)';
  popover.style.zIndex = '600';

  gutterPopoverEl = popover;
}

function scheduleGutterPopoverClose(): void {
  if (gutterPopoverCloseTimer !== null) return;
  gutterPopoverCloseTimer = window.setTimeout(closeGutterPopover, POPOVER_CLOSE_DELAY_MS);
}

function closeGutterPopover(): void {
  if (gutterPopoverEl !== null) {
    gutterPopoverEl.remove();
    gutterPopoverEl = null;
  }
  if (gutterPopoverCloseTimer !== null) {
    window.clearTimeout(gutterPopoverCloseTimer);
    gutterPopoverCloseTimer = null;
  }
}

/** HS-7269 — read the B→C range of a specific record (not necessarily the
 *  latest). Returns null when either marker is missing or disposed. */
function readRecordCommand(term: XTerm, record: CommandRecord): string | null {
  const b = record.commandStart;
  const c = record.outputStart;
  if (b === null || c === null || b.isDisposed || c.isDisposed) return null;
  if (c.line <= b.line) return null;
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let y = b.line; y < c.line; y++) {
    const line = buf.getLine(y);
    if (line === undefined) continue;
    lines.push(line.translateToString(true));
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length === 0 ? null : lines.join('\n');
}

/** HS-7269 — read the C→D range of a specific record (or C→cursor if D is
 *  missing, i.e. the command is still running). */
function readRecordOutput(term: XTerm, record: CommandRecord): string | null {
  const c = record.outputStart;
  if (c === null || c.isDisposed) return null;
  const buf = term.buffer.active;
  const endLine = record.commandEnd !== null && !record.commandEnd.isDisposed
    ? record.commandEnd.line
    : buf.baseY + buf.cursorY + 1;
  if (endLine <= c.line) return null;
  const lines: string[] = [];
  for (let y = c.line; y < endLine; y++) {
    const line = buf.getLine(y);
    if (line === undefined) continue;
    lines.push(line.translateToString(true));
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length === 0 ? null : lines.join('\n');
}

async function copyCommandOfRecord(term: XTerm, record: CommandRecord): Promise<void> {
  const text = readRecordCommand(term, record);
  if (text === null) return;
  try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
}

async function copyOutputOfRecord(term: XTerm, record: CommandRecord): Promise<void> {
  const text = readRecordOutput(term, record);
  if (text === null) return;
  try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
}

/** HS-7269 — re-send the record's captured B→C command text through the
 *  terminal's input path, followed by `\r` so the shell runs it. Uses the
 *  public `term.paste` API which routes through the same onData path that
 *  normal typing uses. Silently no-ops when the command text isn't readable. */
function rerunCommandOfRecord(term: XTerm, record: CommandRecord): void {
  const text = readRecordCommand(term, record);
  if (text === null) return;
  // Strip any trailing newline (B→C region typically contains just the
  // command line); the `\r` below fires the shell's Enter handler.
  term.paste(text.replace(/\n+$/, '') + '\r');
}

/** HS-7270 — ask the Claude Channel to diagnose a failing (or successful)
 *  command. Reads the command text + output + cwd off the record, runs it
 *  through `buildAskClaudePrompt` for the canonical template (see docs/33),
 *  and fires `triggerChannelAndMarkBusy(message)`. The popover already
 *  gated the button on `isChannelAlive()` at open time, but we re-check
 *  here to cover the rare case of the channel going down between popover
 *  open and click. Command text unavailable → silent no-op. */
function askClaudeAboutRecord(term: XTerm, record: CommandRecord, ctx: GutterPopoverContext): void {
  if (!isChannelAlive()) return;
  const command = readRecordCommand(term, record);
  if (command === null) return;
  const output = readRecordOutput(term, record) ?? '';
  const prompt = buildAskClaudePrompt({
    command,
    exitCode: record.exitCode,
    cwd: ctx.getCwd(),
    output,
  });
  triggerChannelAndMarkBusy(prompt);
}

/** Public entry point — mount mouseenter / mouseleave handlers on a gutter
 *  glyph element so hovering reveals the popover. */
export function attachGutterHoverPopover(
  el: HTMLElement,
  term: XTerm,
  record: CommandRecord,
  ctx: GutterPopoverContext,
): void {
  el.style.cursor = 'pointer';
  el.addEventListener('mouseenter', () => { showGutterPopover(el, term, record, ctx); });
  el.addEventListener('mouseleave', () => { scheduleGutterPopoverClose(); });
}
