/**
 * OSC 133 shell-integration glue extracted out of `terminal.tsx` per
 * HS-8396 Phase 1. Owns the prompt/command/output/end event handlers,
 * gutter glyph decoration management, the bounded ring buffer, the
 * shell-integration UI gating, jump-to-prompt navigation, and the
 * copy-last-output flow.
 *
 * The pure helpers this glue depends on (`parseOsc133ExitCode`,
 * `exitCodeGutterClass`, `findPromptLine`, `computeLastOutputRange`)
 * already live in `terminalOsc133.ts`. The hover popover lives in
 * `terminal/gutterPopover.tsx`. This module is the connective tissue
 * between those helpers and the drawer terminal's `TerminalInstance`.
 *
 * Cross-module type loop: `TerminalInstance` (defined in `terminal.tsx`)
 * carries a `shellIntegration: ShellIntegrationState` field whose type
 * is now defined here. The `terminal.tsx` interface imports that type
 * back from this module — a pure type-only cycle that TS resolves at
 * compile time without runtime impact.
 *
 * See docs/26-shell-integration-osc133.md + the HS-7267 / HS-7268 /
 * HS-7269 / HS-7270 ticket history for the design + UI contract.
 */

import type { IDecoration, IMarker, Terminal as XTerm } from '@xterm/xterm';

import type { SafeHtml } from '../jsx-runtime.js';
import { toElement } from './dom.js';
import { state } from './state.js';
import type { TerminalInstance } from './terminal.js';
import { attachGutterHoverPopover } from './terminal/gutterPopover.js';
import { computeLastOutputRange, exitCodeGutterClass, findPromptLine, parseOsc133ExitCode } from './terminalOsc133.js';
import { COPIED_GLYPH_FLASH_MS, SHAKE_DURATION_MS } from './uiTimings.js';

/** Per-prompt record. One per OSC 133 A → D cycle (or a dangling A
 *  retroactively closed by the next A with `exitCode = -1`). */
export interface CommandRecord {
  id: number;
  promptStart: IMarker | null;
  commandStart: IMarker | null;
  outputStart: IMarker | null;
  commandEnd: IMarker | null;
  exitCode: number | null;
  /** Decoration attached at promptStart to render the gutter glyph.
   *  Disposed on record eviction. */
  decoration: IDecoration | null;
}

/** Per-instance shell-integration state. `enabled` flips true once the
 *  first OSC 133 escape is seen; the gutter only renders while enabled
 *  so users who haven't opted into shell integration see no layout
 *  change. `commands` is a bounded ring (500) of per-prompt records;
 *  `current` is the in-flight record between A and D. */
export interface ShellIntegrationState {
  enabled: boolean;
  commands: CommandRecord[];
  current: CommandRecord | null;
  nextId: number;
}

const SHELL_INTEGRATION_RING_SIZE = 500;

/** Factory for the initial state slot — used at instance creation
 *  and at PTY restart (via `resetShellIntegration`). */
export function freshShellIntegrationState(): ShellIntegrationState {
  return { enabled: false, commands: [], current: null, nextId: 1 };
}

// Inline SVG constants — duplicated from `terminal.tsx` rather than
// imported to avoid a runtime cycle (`terminal.tsx` imports functions
// from this module; importing the icon constants back the other way
// works at runtime but the cycle becomes fragile if any consumer is
// promoted to a module-init-time reference). The strings are tiny so
// the duplication cost is negligible.
const CHECK_ICON: SafeHtml = <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>;
const CLIPBOARD_ICON: SafeHtml = <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M16 14h-6"/><path d="M10 18h.01"/></svg>;

// Compact 10×10 gutter glyphs — distinct from the 14×14 toolbar icons
// above. `_OK` for exit code 0, `_FAIL` for a non-zero exit, `_PENDING`
// (a filled dot) for a still-running command.
const GUTTER_GLYPH_OK: SafeHtml = <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>;
const GUTTER_GLYPH_PENDING: SafeHtml = <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>;
const GUTTER_GLYPH_FAIL: SafeHtml = <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>;

/** HS-7269 — read the per-project "Enable shell integration UI" setting.
 *  Default true (setting absent → on). Reads from the shared
 *  `state.settings` object which is reloaded on project switch, so the
 *  check is always scoped to the active project. */
export function shellIntegrationUiEnabled(): boolean {
  return state.settings.shell_integration_ui;
}

/** OSC 133 entry point — called from `terminal.tsx::attachDrawerTermHandlers`
 *  on each OSC 133 escape. Dispatches by subcommand letter. */
export function handleOsc133(inst: TerminalInstance, term: XTerm, payload: string): void {
  if (typeof payload !== 'string' || payload === '') return;
  const subcommand = payload[0];
  if (subcommand === 'A') {
    onShellIntegrationPromptStart(inst, term);
  } else if (subcommand === 'B') {
    onShellIntegrationCommandStart(inst, term);
  } else if (subcommand === 'C') {
    onShellIntegrationOutputStart(inst, term);
  } else if (subcommand === 'D') {
    // "D" alone or "D;<exitCode>".
    const code = parseOsc133ExitCode(payload);
    onShellIntegrationCommandEnd(inst, term, code);
  }
}

function onShellIntegrationPromptStart(inst: TerminalInstance, term: XTerm): void {
  const si = inst.shellIntegration;
  if (!si.enabled) {
    si.enabled = true;
    // HS-7268 — reveal the copy-last-output toolbar button the first time we
    // see an OSC 133 escape. The button was rendered with `display:none` so
    // users who never opt into shell integration see no extra toolbar icon.
    applyShellIntegrationToolbarVisibility(inst);
  }
  // If there's a current record (previous A never got a D — shell crashed
  // mid-command), flush it into the ring with exitCode=-1 so its glyph
  // survives in the gutter rather than vanishing on next A.
  if (si.current !== null) {
    si.current.exitCode = -1;
    attachGutterDecoration(inst, term, si.current);
    pushAndEvict(si, si.current);
    si.current = null;
  }
  const marker = term.registerMarker(0);
  si.current = {
    id: si.nextId++,
    promptStart: marker,
    commandStart: null,
    outputStart: null,
    commandEnd: null,
    exitCode: null,
    decoration: null,
  };
}

function onShellIntegrationCommandStart(inst: TerminalInstance, term: XTerm): void {
  const si = inst.shellIntegration;
  if (si.current === null) return;
  si.current.commandStart = term.registerMarker(0);
}

function onShellIntegrationOutputStart(inst: TerminalInstance, term: XTerm): void {
  const si = inst.shellIntegration;
  if (si.current === null) return;
  si.current.outputStart = term.registerMarker(0);
}

function onShellIntegrationCommandEnd(inst: TerminalInstance, term: XTerm, code: number | null): void {
  const si = inst.shellIntegration;
  if (si.current === null) return;
  si.current.commandEnd = term.registerMarker(0);
  si.current.exitCode = code;
  attachGutterDecoration(inst, term, si.current);
  pushAndEvict(si, si.current);
  si.current = null;
}

function pushAndEvict(si: ShellIntegrationState, record: CommandRecord): void {
  si.commands.push(record);
  while (si.commands.length > SHELL_INTEGRATION_RING_SIZE) {
    const evicted = si.commands.shift();
    if (evicted !== undefined) disposeCommandRecord(evicted);
  }
}

function disposeCommandRecord(r: CommandRecord): void {
  try { r.decoration?.dispose(); } catch { /* ignore */ }
  try { r.promptStart?.dispose(); } catch { /* ignore */ }
  try { r.commandStart?.dispose(); } catch { /* ignore */ }
  try { r.outputStart?.dispose(); } catch { /* ignore */ }
  try { r.commandEnd?.dispose(); } catch { /* ignore */ }
}

/** Render the exit-code gutter glyph for a completed command (green check /
 *  red x / neutral dot depending on exitCode). Idempotent — a second call
 *  on the same record re-attaches after disposing the previous decoration
 *  (used when a dangling A record is retroactively finalized as exitCode=-1
 *  by the NEXT prompt's A handler).
 *
 *  HS-7269 — gated on `shell_integration_ui`: when the setting is off we
 *  don't create the decoration at all so the gutter glyph + Phase 2 hover
 *  popover (attached below) never render. Toggling the setting back on
 *  re-runs this path for every record via `reapplyShellIntegrationDecorations`. */
function attachGutterDecoration(inst: TerminalInstance, term: XTerm, record: CommandRecord): void {
  if (record.promptStart === null) return;
  if (!shellIntegrationUiEnabled()) return;
  try { record.decoration?.dispose(); } catch { /* ignore */ }
  const deco = term.registerDecoration({
    marker: record.promptStart,
    x: 0,
    width: 1,
    height: 1,
  });
  if (deco === undefined) return;
  record.decoration = deco;
  deco.onRender((el) => {
    el.className = `terminal-osc133-gutter terminal-osc133-gutter-${exitCodeGutterClass(record.exitCode)}`;
    el.replaceChildren(toElement(<span>{gutterGlyphSvg(record.exitCode)}</span>));
    el.title = record.exitCode === null
      ? 'Command (no exit code reported)'
      : `Command (exit ${record.exitCode})`;
    // HS-7269 — hover popover on the gutter glyph with Copy command / Copy
    // output / Rerun / Ask Claude (HS-7270) actions. Attached per-decoration
    // so each command's popover targets its own record (closed-over); the
    // popover is mounted lazily on first hover so we don't allocate 500 DOM
    // trees up front.
    attachGutterHoverPopover(el, term, record, { getCwd: () => inst.runtimeCwd });
  });
}

/** HS-7267 §26.9 edge case "runaway C without D" — when the PTY exits
 *  while an OSC 133 A record is still in-flight (no D seen), flush the
 *  in-flight record with `exitCode = -1` so its gutter glyph stays
 *  visible rather than being silently dropped. Called from
 *  `handleControlMessage` on receipt of an exit-control-frame. No-op
 *  when no in-flight record exists. */
export function closeDanglingCommand(inst: TerminalInstance, term: XTerm): void {
  const si = inst.shellIntegration;
  if (si.current === null) return;
  si.current.exitCode = -1;
  attachGutterDecoration(inst, term, si.current);
  pushAndEvict(si, si.current);
  si.current = null;
}

/** HS-7269 — re-attach (or dispose) gutter decorations on every tracked
 *  record in response to a `shell_integration_ui` setting flip. We can't
 *  just toggle CSS visibility because `registerDecoration` has already
 *  committed the marker → DOM binding; we dispose and re-register instead. */
export function reapplyShellIntegrationDecorations(inst: TerminalInstance): void {
  const term = inst.term;
  if (term === null) return;
  if (shellIntegrationUiEnabled()) {
    for (const r of inst.shellIntegration.commands) attachGutterDecoration(inst, term, r);
  } else {
    for (const r of inst.shellIntegration.commands) {
      try { r.decoration?.dispose(); } catch { /* ignore */ }
      r.decoration = null;
    }
  }
}

/** Compact inline SVG so the glyph renders at 10×10 in the gutter column.
 *  Lucide check / x / circle minimalized to reduce DOM weight per record. */
function gutterGlyphSvg(code: number | null): SafeHtml {
  if (code === 0) return GUTTER_GLYPH_OK;
  if (code === null) return GUTTER_GLYPH_PENDING;
  return GUTTER_GLYPH_FAIL;
}

/** Dispose every shell-integration record + reset state. Called on PTY
 *  restart and project switch (implicitly via removeTerminalInstance).
 *  HS-7267. */
export function resetShellIntegration(inst: TerminalInstance): void {
  for (const r of inst.shellIntegration.commands) disposeCommandRecord(r);
  if (inst.shellIntegration.current !== null) disposeCommandRecord(inst.shellIntegration.current);
  inst.shellIntegration = freshShellIntegrationState();
  // HS-7268 — re-hide the copy-last-output button; it'll reappear on the next
  // OSC 133 A seen (if the user's shell integration survives the restart).
  applyShellIntegrationToolbarVisibility(inst);
}

/** Show or hide shell-integration-specific toolbar affordances based on
 *  whether we've ever seen an OSC 133 escape on this terminal (HS-7268)
 *  AND the user's `shell_integration_ui` setting (HS-7269). When the
 *  setting is off the button stays hidden even after the OSC handler
 *  fires — the handler still runs so markers are tracked, but no UI
 *  surfaces. */
export function applyShellIntegrationToolbarVisibility(inst: TerminalInstance): void {
  const btn = inst.header.querySelector<HTMLButtonElement>('.terminal-copy-output-btn');
  if (btn === null) return;
  const visible = inst.shellIntegration.enabled && shellIntegrationUiEnabled();
  btn.style.display = visible ? '' : 'none';
}

/** HS-7269 — scroll the xterm viewport to the previous or next command's
 *  prompt row. Uses `term.scrollToLine(line)` which takes the absolute
 *  buffer line (our markers already store this). Pulls the active buffer's
 *  cursor position as the anchor so "next" from the middle of a
 *  scrolled-back view jumps to the first prompt below the viewport, not
 *  the first prompt below some stale cursor. No-op when there's no marker
 *  in the chosen direction (caller already swallowed the keystroke to
 *  prevent `\e[1;5A` leaks). */
export function jumpToPromptMarker(inst: TerminalInstance, direction: 'prev' | 'next'): void {
  const term = inst.term;
  if (term === null) return;
  const buf = term.buffer.active;
  const fromLine = buf.viewportY;
  const promptLines: number[] = [];
  for (const r of inst.shellIntegration.commands) {
    if (r.promptStart !== null && !r.promptStart.isDisposed) {
      promptLines.push(r.promptStart.line);
    }
  }
  const target = findPromptLine({ promptLines, fromLine, direction });
  if (target === null) return;
  term.scrollToLine(target);
}

/** HS-7268 — copy the most recent command's output to the clipboard.
 *  Reads the [start, end) range from `computeLastOutputRange` via
 *  xterm's live buffer, joins rows with `\n`, trims trailing blank
 *  lines, and writes via `navigator.clipboard.writeText` (Tauri
 *  WKWebView supports this natively). Flashes the button glyph to a
 *  check on success so the user gets visual feedback without a toast
 *  — the click was a direct action on the button, so a toast would
 *  feel redundant. On empty / no-range / clipboard error, the button
 *  briefly shakes to signal the no-op. */
export async function copyLastOutput(inst: TerminalInstance): Promise<void> {
  const term = inst.term;
  if (term === null) { shakeCopyOutputBtn(inst); return; }
  const buf = term.buffer.active;
  const cursorLine = buf.baseY + buf.cursorY;
  const range = computeLastOutputRange({
    current: inst.shellIntegration.current,
    commands: inst.shellIntegration.commands,
    cursorLine,
  });
  if (range === null) { shakeCopyOutputBtn(inst); return; }

  const lines: string[] = [];
  for (let y = range.start; y < range.end; y++) {
    const line = buf.getLine(y);
    if (line === undefined) continue;
    lines.push(line.translateToString(true));
  }
  // Trim trailing blank rows so a command whose output doesn't fill the
  // full buffer range (common — the D marker lands on a blank precmd line)
  // doesn't paste dangling newlines.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) { shakeCopyOutputBtn(inst); return; }

  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    flashCopyOutputBtnSuccess(inst);
  } catch {
    shakeCopyOutputBtn(inst);
  }
}

function flashCopyOutputBtnSuccess(inst: TerminalInstance): void {
  const btn = inst.header.querySelector<HTMLButtonElement>('.terminal-copy-output-btn');
  if (btn === null) return;
  btn.replaceChildren(toElement(<span>{CHECK_ICON}</span>));
  btn.classList.add('copied');
  window.setTimeout(() => {
    btn.replaceChildren(toElement(<span>{CLIPBOARD_ICON}</span>));
    btn.classList.remove('copied');
  }, COPIED_GLYPH_FLASH_MS);
}

function shakeCopyOutputBtn(inst: TerminalInstance): void {
  const btn = inst.header.querySelector<HTMLButtonElement>('.terminal-copy-output-btn');
  if (btn === null) return;
  btn.classList.add('shake');
  window.setTimeout(() => btn.classList.remove('shake'), SHAKE_DURATION_MS);
}
