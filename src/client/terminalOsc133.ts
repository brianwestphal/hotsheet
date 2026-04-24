/**
 * Pure helpers for the OSC 133 shell-integration feature (HS-7267,
 * docs/26-shell-integration-osc133.md). Extracted from `terminal.tsx` so
 * they can be unit-tested without pulling in xterm / JSX deps.
 */

/** Parse the numeric exit code from the `D;<code>` form of the OSC 133
 *  command-end escape. Missing codes (bare `D`) return null so the caller
 *  can still close the record with a neutral gutter glyph. VS Code's 633
 *  superset appends `;key=value` metadata after the code; we truncate at
 *  the first `;` and parse only the numeric prefix. Invalid / non-numeric
 *  codes also return null. */
export function parseOsc133ExitCode(payload: string): number | null {
  if (!payload.startsWith('D')) return null;
  if (payload.length === 1) return null;
  if (payload[1] !== ';') return null;
  const rest = payload.slice(2);
  const end = rest.indexOf(';');
  const codeStr = end < 0 ? rest : rest.slice(0, end);
  const n = Number.parseInt(codeStr, 10);
  return Number.isFinite(n) && codeStr !== '' && /^-?\d+$/.test(codeStr) ? n : null;
}

/** Map an exit code to the gutter CSS modifier class. Exported so the
 *  renderer in terminal.tsx and any future tests share one source of truth. */
export function exitCodeGutterClass(code: number | null): 'success' | 'failure' | 'neutral' {
  if (code === 0) return 'success';
  if (code === null) return 'neutral';
  return 'failure';
}

/**
 * Phase 1b (HS-7268) — compute the absolute [start, end) buffer-line range of
 * the most recent command's output, suitable for copying to the clipboard.
 *
 * The helper is pure (takes a plain data view of `shellIntegration` + the
 * current cursor's absolute line number, returns a range or null) so it can
 * be unit-tested without pulling in xterm. The caller in `terminal.tsx`
 * reads the range via `term.buffer.active.getLine(y).translateToString(true)`
 * and joins with `\n` — simple loop, not worth abstracting behind this helper.
 *
 * Rules, in priority order:
 *   1. If an in-flight record (A seen, D not yet) exists and its `outputStart`
 *      (C) marker is alive, prefer it: the user is mid-output and wants the
 *      bytes printed so far. End = current cursor line + 1 (exclusive) so the
 *      cursor's line is included.
 *   2. Otherwise fall back to the most recent completed record. End =
 *      `commandEnd.line` when D is alive, else current cursor position.
 *   3. Return null when:
 *      - no in-flight record AND no completed records,
 *      - the chosen record has no C marker (shell emits only A/D — output
 *        range is ambiguous),
 *      - the C marker has been disposed (scrollback trimmed past it),
 *      - the resulting range is empty or inverted.
 *
 * The C marker's line itself is INCLUDED in the range. Most shells place C on
 * the line immediately after the user's `Enter` keypress, so the line holds
 * either the first output byte or is blank — trimming trailing blanks in the
 * caller handles the blank case cleanly.
 */
export interface Osc133CommandRange {
  /** Inclusive start line in the absolute xterm buffer (`ybase` + relative row). */
  start: number;
  /** Exclusive end line. */
  end: number;
}

interface MarkerView {
  line: number;
  isDisposed: boolean;
}

interface CommandRecordView {
  outputStart: MarkerView | null;
  commandEnd: MarkerView | null;
}

export interface Osc133RangeInput {
  /** The in-flight record — A has fired, D has not. Null when the shell is
   *  sitting at an idle prompt. */
  current: { outputStart: MarkerView | null } | null;
  /** Completed records, oldest first. Only the last element is consulted for
   *  the fallback path — older records are for historical navigation (Phase 2). */
  commands: ReadonlyArray<CommandRecordView>;
  /** Current cursor's absolute line (`buffer.active.baseY + buffer.active.cursorY`).
   *  Used as the end for running commands and for completed records whose D
   *  marker has been disposed. */
  cursorLine: number;
}

/**
 * Phase 2 (HS-7269) — find the previous or next prompt marker relative to a
 * cursor position. Used by the Cmd/Ctrl+Up / Cmd/Ctrl+Down jump shortcuts
 * (`term.scrollToLine(marker.line)`) to move the viewport between commands.
 *
 * - `direction: 'prev'` — the newest marker whose line is strictly LESS than
 *   `fromLine`. If we're currently at or above the oldest prompt, returns null.
 * - `direction: 'next'` — the oldest marker whose line is strictly GREATER
 *   than `fromLine`. If we're at or below the newest prompt, returns null.
 *
 * Only alive, non-null `promptStart` markers are considered. The helper is
 * pure (takes plain line numbers in, returns a number or null) so tests can
 * exercise it without xterm.
 */
export interface PromptMarkerInput {
  promptLines: ReadonlyArray<number>;
  fromLine: number;
  direction: 'prev' | 'next';
}

export function findPromptLine(input: PromptMarkerInput): number | null {
  const { promptLines, fromLine, direction } = input;
  if (promptLines.length === 0) return null;
  // Promise: callers pre-filter out disposed markers and pass `.line` values.
  // The list is expected to be in chronological order (commands pushed in
  // prompt order) which is also line-increasing — but we don't rely on that
  // and compute min/max explicitly.
  if (direction === 'prev') {
    let best: number | null = null;
    for (const line of promptLines) {
      if (line < fromLine && (best === null || line > best)) best = line;
    }
    return best;
  }
  let best: number | null = null;
  for (const line of promptLines) {
    if (line > fromLine && (best === null || line < best)) best = line;
  }
  return best;
}

/**
 * Phase 3 (HS-7270) — build the Claude Channel prompt asking Claude to
 * diagnose a failing command. Pure template assembly so the caller can test
 * the output without spinning up the channel or a terminal.
 *
 * Template (from docs/26-shell-integration-osc133.md §26.6 Phase 3):
 *
 *     The command `$CMD` exited with code $N in `$CWD`. Output:
 *
 *     $OUTPUT
 *
 *     Please diagnose and propose a fix.
 *
 * Variations:
 * - `cwd` null or empty: drop the "in `$CWD`" clause entirely.
 * - `exitCode` null: say "exited (no exit code reported)" instead of "exited
 *   with code N" — the command completed but the shell didn't emit D;N (rare,
 *   covered by HS-7267 neutral-glyph path).
 * - `output` empty: replace the fenced block with *(no output captured)* so
 *   Claude knows the output was empty, not just that we failed to read it.
 * - `output` over `maxOutputChars`: truncate to the LAST `maxOutputChars`
 *   characters and prepend `[output truncated to last $N chars]` so Claude
 *   sees the failing tail rather than the successful startup. Default cap is
 *   8 000 chars (about 2 000 tokens), comfortable for triage prompts without
 *   ballooning the channel request.
 */
export interface AskClaudePromptInput {
  command: string;
  exitCode: number | null;
  cwd: string | null;
  output: string;
  maxOutputChars?: number;
}

export function buildAskClaudePrompt(input: AskClaudePromptInput): string {
  const { command, exitCode, cwd, output } = input;
  const maxOutputChars = input.maxOutputChars ?? 8000;

  const codePart = exitCode === null
    ? 'exited (no exit code reported)'
    : `exited with code ${exitCode.toString()}`;
  const cwdPart = cwd === null || cwd === '' ? '' : ` in \`${cwd}\``;

  let outputBlock: string;
  if (output === '') {
    outputBlock = '*(no output captured)*';
  } else if (output.length > maxOutputChars) {
    const tail = output.slice(-maxOutputChars);
    outputBlock = `[output truncated to last ${maxOutputChars.toString()} chars]\n\n\`\`\`\n${tail}\n\`\`\``;
  } else {
    outputBlock = `\`\`\`\n${output}\n\`\`\``;
  }

  return [
    `The command \`${command}\` ${codePart}${cwdPart}. Output:`,
    '',
    outputBlock,
    '',
    'Please diagnose and propose a fix.',
  ].join('\n');
}

export function computeLastOutputRange(input: Osc133RangeInput): Osc133CommandRange | null {
  const { current, commands, cursorLine } = input;

  // Rule 1 — prefer the running command when C is alive.
  if (current !== null && current.outputStart !== null && !current.outputStart.isDisposed) {
    const start = current.outputStart.line;
    const end = cursorLine + 1;
    if (end <= start) return null;
    return { start, end };
  }

  // Rule 2 — fall back to the most recent completed record.
  if (commands.length === 0) return null;
  const latest = commands[commands.length - 1];
  if (latest.outputStart === null || latest.outputStart.isDisposed) return null;
  const start = latest.outputStart.line;
  const end = (latest.commandEnd !== null && !latest.commandEnd.isDisposed)
    ? latest.commandEnd.line
    : cursorLine + 1;
  if (end <= start) return null;
  return { start, end };
}
