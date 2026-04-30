/**
 * HS-7971 Phase 1 — terminal prompt parser registry.
 *
 * Pure (no DOM, no xterm) so the parsing logic is unit-testable in isolation
 * from the live terminal. The detector calls `runParserRegistry(rows)` with
 * the last visible buffer rows from `term.buffer.active`; the first parser
 * whose `match()` returns non-null wins. Parser order in the registry is the
 * priority order — `claude-numbered` first because its match shape is the
 * most specific.
 *
 * See docs/52-terminal-prompt-overlay.md §52.4 for the design.
 */

/** A clickable choice within a numbered-list prompt. */
export interface ChoiceOption {
  /** 0-based index in the rendered list (the digit minus 1). */
  index: number;
  /** Display label, with the leading number / cursor stripped. */
  label: string;
  /** True when this option is the one the `>` cursor currently sits on. */
  highlighted: boolean;
}

/** Result of a parser match — what the detector hands to the overlay. */
export type MatchResult =
  | NumberedMatch
  | YesNoMatch
  | GenericMatch;

interface BaseMatch {
  /** Parser id — `claude-numbered` | `yesno` | `generic`. */
  parserId: string;
  /** Single-line summary used in the overlay title bar. Lines joined with
   *  spaces; short version of `questionLines`. */
  question: string;
  /** Multi-line preserved view of the question region — diff rows, the
   *  question itself, etc. The overlay renders this in a monospaced `<pre>`
   *  when it has more than one non-empty line so Claude's edit-diff prompts
   *  (HS-7980) keep their visual structure. */
  questionLines: string[];
  /**
   * Canonical signature for always-allow keying — `parser_id + ":" + hash(question) + ":" + chosenIndex`.
   * Phase 3 (HS-7971 follow-up) consumes this; Phase 1 still computes it so the
   * shape is stable from day one.
   */
  signature: string;
}

export interface NumberedMatch extends BaseMatch {
  shape: 'numbered';
  choices: ChoiceOption[];
}

export interface YesNoMatch extends BaseMatch {
  shape: 'yesno';
  /** True when the surface form was capitalised (`Y/n` or `[Y/n]`). The
   *  payload preserves the user-visible case so a `Y/n` prompt gets `Y\r` /
   *  `n\r` answers (some shells care about default semantics). */
  yesIsCapital: boolean;
  noIsCapital: boolean;
}

export interface GenericMatch extends BaseMatch {
  shape: 'generic';
  /** Verbatim last visible rows for the monospaced reproduction in the
   *  overlay. The overlay clamps to a max-height; we keep the full slice
   *  here so the user can see the entire prompt context. */
  rawText: string;
}

export interface PromptParser {
  id: string;
  match(rows: readonly string[]): MatchResult | null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Sub-string-stable signature hash. We don't need cryptographic strength —
 * it's a key for an exact-match allow-rule lookup. djb2 keeps the result
 * short (8 hex chars) and stable across browsers.
 */
export function hashQuestion(question: string): string {
  let hash = 5381;
  const trimmed = question.trim().toLowerCase();
  for (let i = 0; i < trimmed.length; i++) {
    hash = ((hash << 5) + hash) + trimmed.charCodeAt(i); // hash * 33 + c
    hash = hash & 0xffffffff;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Trim trailing whitespace + drop trailing empty rows. Keeps the leading
 * empty rows since they sometimes carry visual structure (Ink's centred
 * prompts). Exported for tests.
 */
export function trimRows(rows: readonly string[]): string[] {
  let end = rows.length;
  while (end > 0 && rows[end - 1].trim() === '') end--;
  return rows.slice(0, end).map(r => r.replace(/\s+$/, ''));
}

/**
 * HS-8037 — recognise lines that are *only* decoration (box-drawing
 * borders, horizontal rules) so the title-bar pick + the overlay's framed
 * `<pre>` context block don't echo them. Blank lines are NOT decorative —
 * they carry visual paragraph structure. Returns true only when the line
 * is non-empty AND every non-whitespace character is one of the listed
 * box-drawing / rule-style characters.
 */
export function isDecorativeLine(line: string): boolean {
  const t = line.trim();
  if (t === '') return false;
  return /^[─━═│┃┄┅┆┇┈┉┊┋╌╍╎╏┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬╭╮╯╰─\-=_*~ ]+$/.test(t);
}

/**
 * HS-8037 — pick a single useful title line out of the multi-line question
 * region. Pre-fix the title was every line joined with spaces, which read
 * as a wall of text whenever the prompt's question region was more than
 * one line — and the framed context block below repeated the same content
 * verbatim, so the user saw the same paragraph twice. Heuristic:
 *
 * 1. Last line ending in `?` wins — that's literally the question (covers
 *    HS-7980 Edit-tool diff prompts where the question lives below the
 *    diff).
 * 2. Otherwise first non-blank, non-decorative line wins — that's the
 *    heading (covers Claude's `--dangerously-load-development-channels`
 *    warning where the heading lives above the body).
 *
 * Returns `''` when no usable line is found; caller falls back to
 * `(unlabelled prompt)` rendering.
 */
export function pickTitleLine(lines: readonly string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t.length > 1 && t.endsWith('?') && !isDecorativeLine(t)) return t;
  }
  for (const l of lines) {
    const t = l.trim();
    if (t === '' || isDecorativeLine(t)) continue;
    return t;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Parser: claude-numbered
// ---------------------------------------------------------------------------

/**
 * Claude-Ink numbered choice list. Shape:
 *
 * ```
 * Loading development channels can pose a security risk
 *
 * > 1. I am using this for local development
 *   2. Exit
 *
 * Enter to confirm · Esc to cancel
 * ```
 *
 * Match rules:
 * - The trailing non-empty row equals one of the known footers.
 * - At least one row above it matches `^(\s*[>]?\s*)\d+\.\s+(.+)$`.
 * - The first row whose leading marker is `>` is the highlighted option.
 *
 * Multiple consecutive numbered rows are required (otherwise it's a list
 * inside docs / chatter, not a prompt). We require the digits to start at
 * 1 and be contiguous — Claude renders 1..N without skipping.
 */
const NUMBERED_FOOTERS: ReadonlySet<string> = new Set([
  'Enter to confirm · Esc to cancel',
  'Enter to confirm', // Some Ink builds drop the Esc clause
]);

/** Used by both the detection footer test (§52.3.3) and the parser. The
 *  trailing footer can be wrapped in faint colour or have trailing
 *  whitespace; normalise via `trim()` before comparison. */
export function isClaudeNumberedFooter(line: string): boolean {
  const t = line.trim();
  return NUMBERED_FOOTERS.has(t);
}

/**
 * HS-8050 — hard cap on the number of rows we'll capture as the prompt's
 * "question region" above the numbered options. Longer captures almost
 * always pull in unrelated claude code TUI decorations / status lines
 * because the headless scanner's viewport overlaps with the prompt's
 * surrounding rendered TUI. Inline diff prompts (HS-7980) cap at ~12
 * rows; this gives us margin while still rejecting runaway captures.
 */
export const MAX_QUESTION_CONTEXT_ROWS = 15;

// HS-7995 — Recent Claude Code builds render the highlighted-row cursor as
// `❯` (U+276F HEAVY RIGHT-POINTING ANGLE QUOTATION MARK ORNAMENT) rather
// than the older ASCII `>`. Other CLIs occasionally use the box-drawing
// triangles `▶` / `►`. Accept any of these so we don't lose the
// highlight signal — pre-fix the parser still matched the second
// (non-highlighted) option line, but rejected the prompt because only one
// of the two rows parsed and the registry requires ≥ 2 contiguous choices.
const CURSOR_CHARS: ReadonlySet<string> = new Set(['>', '❯', '▶', '►']);
const NUMBERED_OPTION_RX = /^(\s*)([>❯▶►])?\s*(\d+)\.\s+(.+?)\s*$/;

export const claudeNumberedParser: PromptParser = {
  id: 'claude-numbered',
  match(rows) {
    const trimmed = trimRows(rows);
    if (trimmed.length === 0) return null;
    if (!isClaudeNumberedFooter(trimmed[trimmed.length - 1])) return null;

    // Walk upward gathering numbered rows.
    const choices: ChoiceOption[] = [];
    let highlightedIndex = -1;
    const questionLines: string[] = [];
    let questionStartIdx = -1;
    for (let i = trimmed.length - 2; i >= 0; i--) {
      const line = trimmed[i];
      const m = NUMBERED_OPTION_RX.exec(line);
      if (m !== null) {
        // RegExpExecArray indexes are typed as `string`, but optional
        // capture groups are actually `undefined` at runtime when the
        // group didn't match. Set.has() short-circuits the type / runtime
        // mismatch without needing a non-null assertion.
        const isHighlighted = CURSOR_CHARS.has(m[2]);
        const digit = parseInt(m[3], 10);
        const label = m[4];
        // Push at the head so final order is top-to-bottom.
        choices.unshift({ index: digit - 1, label, highlighted: isHighlighted });
        if (isHighlighted) highlightedIndex = digit - 1;
        continue;
      }
      // First non-numbered row above the numbered block: remember where the
      // question region might start. If choices is still empty, we haven't
      // entered the numbered block yet (e.g. trailing blank between numbers
      // and footer — claude renders this), so keep scanning upward.
      if (choices.length === 0) continue;
      questionStartIdx = i;
      break;
    }

    if (questionStartIdx >= 0) {
      // HS-7980 — preserve blank-row separators so the overlay's monospaced
      // context block keeps the structure of an inline diff (which Claude
      // renders separated from the actual question line by a blank).
      //
      // HS-8050 (2026-05-01) — but DON'T walk all the way to the top of the
      // visible window. The user's claude code session can render its TUI
      // decorations (status bars, "Listening for channel messages..." /
      // "Experimental: ..." pre-amble lines, the `?` for shortcuts help
      // line, etc.) in the same buffer that contains the prompt; pulling
      // every row back to row 0 captured all of that as framed context and
      // made the popup body show "everything after the prompt header is
      // just the claude code prompt decorations and input" (user's own
      // words). Two stopping conditions:
      //   1. A run of 2+ consecutive blank rows — that's almost always a
      //      visual section break separating unrelated content above from
      //      the prompt's own body. Inline diffs inside a single prompt
      //      use exactly one blank as a separator (HS-7980 fixture), so
      //      requiring two-in-a-row keeps that case working.
      //   2. A hard cap of `MAX_QUESTION_CONTEXT_ROWS` rows (defensive —
      //      a legitimate prompt body shouldn't exceed this; longer
      //      captures are almost always pulling unrelated TUI noise).
      let j = questionStartIdx;
      // Skip trailing blank rows immediately before the numbered block —
      // they aren't useful context.
      while (j >= 0 && trimmed[j].trim() === '') j--;
      const accumulated: string[] = [];
      let consecutiveBlanks = 0;
      for (let k = j; k >= 0 && accumulated.length < MAX_QUESTION_CONTEXT_ROWS; k--) {
        const isBlank = trimmed[k].trim() === '';
        if (isBlank) {
          consecutiveBlanks++;
          if (consecutiveBlanks >= 2) break;
        } else {
          consecutiveBlanks = 0;
        }
        accumulated.unshift(trimmed[k]);
      }
      while (accumulated.length > 0 && accumulated[0].trim() === '') accumulated.shift();
      questionLines.push(...accumulated);
    }

    if (choices.length < 2) return null;
    // Sanity: digits must start at 1 and be contiguous + unique.
    const sorted = [...choices].sort((a, b) => a.index - b.index);
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].index !== i) return null;
    }

    // HS-8037 — single-line title used in the overlay's title bar. Pre-fix
    // this joined every line in `questionLines` with spaces, which (a) read
    // as a wall of text in the title and (b) duplicated the same content
    // already rendered verbatim in the framed `<pre>` context block below.
    // `pickTitleLine` picks one useful line — the trailing `?` line for
    // diff-shape prompts, otherwise the first non-decorative heading.
    const title = pickTitleLine(questionLines);
    const question = title !== '' ? title : '(unlabelled prompt)';
    // Use the highlighted index as the canonical "default" choice; if no row
    // is highlighted, fall back to index 0.
    const defaultIdx = highlightedIndex >= 0 ? highlightedIndex : 0;
    const signature = `claude-numbered:${hashQuestion(question)}:${defaultIdx}`;

    return {
      parserId: 'claude-numbered',
      shape: 'numbered',
      question,
      questionLines,
      choices,
      signature,
    };
  },
};

// ---------------------------------------------------------------------------
// Parser: yesno
// ---------------------------------------------------------------------------

/**
 * Matches the trailing line of a generic Unix-style yes/no prompt. Common
 * shapes accepted:
 *   - `Are you sure? [y/n]`
 *   - `Continue? [Y/n]:`
 *   - `Delete this file (y/N)?`
 *   - `Overwrite? [yes/no]`
 *
 * Conservative — the marker MUST appear on the last visible non-empty row.
 * False-positive defence: skip when the line looks like a markdown list /
 * comment / numbered code block. Generic-fallback responses are NEVER
 * allow-listable in Phase 3 (`docs/52-terminal-prompt-overlay.md` §52.1) —
 * the same caution would apply if anyone tried to extend allow-rules to the
 * yesno shape; today they're not on the auto-allow list either.
 */
const YESNO_MARKER_RX = /[[(]\s*(y(?:es)?)\s*\/\s*(n(?:o)?)\s*[\])]/i;

function isUpperCase(letter: string): boolean {
  return letter.length > 0 && letter === letter.toUpperCase() && letter !== letter.toLowerCase();
}

export const yesNoParser: PromptParser = {
  id: 'yesno',
  match(rows) {
    const trimmed = trimRows(rows);
    if (trimmed.length === 0) return null;
    const last = trimmed[trimmed.length - 1];
    const m = YESNO_MARKER_RX.exec(last);
    if (m === null) return null;
    // Skip lines that look like docs / code rather than prompts.
    if (looksLikeDocsLine(last)) return null;

    const yesIsCapital = isUpperCase(m[1][0]);
    const noIsCapital = isUpperCase(m[2][0]);

    // Strip the marker + trailing punctuation for the title-bar summary.
    const summary = last
      .replace(YESNO_MARKER_RX, '')
      .replace(/[?:]\s*$/, '')
      .trim();
    const question = summary !== '' ? summary : 'Yes / No?';
    const questionLines = [last];
    const signature = `yesno:${hashQuestion(question)}:0`;

    return {
      parserId: 'yesno',
      shape: 'yesno',
      question,
      questionLines,
      yesIsCapital,
      noIsCapital,
      signature,
    };
  },
};

// ---------------------------------------------------------------------------
// Parser: generic
// ---------------------------------------------------------------------------

/**
 * Conservative trailing-`?` heuristic for prompts the registry doesn't
 * specifically recognise. Last visible non-empty line must end with `?` (an
 * optional trailing `:` or `>` is allowed for prompt cosmetics). Skip lines
 * that start with markdown / comment / list markers since those are
 * almost always documentation, not prompts.
 *
 * Generic-fallback responses are NEVER allow-listed in Phase 3 — see
 * `docs/52-terminal-prompt-overlay.md` §52.1. Free-text answers are too
 * risky to auto-respond.
 */
const GENERIC_TRAILING_RX = /\?\s*[:>]?\s*$/;
const NUMBERED_LIST_RX = /^\s*\d+[.)]\s/;

function looksLikeDocsLine(line: string): boolean {
  const trimmedLeft = line.replace(/^\s+/, '');
  if (trimmedLeft === '') return true;
  const first = trimmedLeft[0];
  if (first === '#' || first === '>' || first === '-' || first === '*' || first === '|') return true;
  if (NUMBERED_LIST_RX.test(trimmedLeft)) return true;
  return false;
}

export const genericParser: PromptParser = {
  id: 'generic',
  match(rows) {
    const trimmed = trimRows(rows);
    if (trimmed.length === 0) return null;
    const last = trimmed[trimmed.length - 1];
    if (!GENERIC_TRAILING_RX.test(last)) return null;
    if (looksLikeDocsLine(last)) return null;

    const summary = last.replace(/[?:>]\s*$/, '').trim();
    const question = summary !== '' ? summary : '(unlabelled prompt)';
    // Keep the full visible context for the monospaced reproduction in the
    // overlay. The last 10 rows are usually enough but we cap by what we
    // were given.
    const rawText = trimmed.join('\n');
    const signature = `generic:${hashQuestion(question)}:0`;

    return {
      parserId: 'generic',
      shape: 'generic',
      question,
      questionLines: trimmed,
      rawText,
      signature,
    };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Registry order is priority order. Parsers are tried in array order; first
 *  non-null match wins. `claude-numbered` is most specific so it goes first;
 *  `yesno` is next; `generic` is the heuristic fallback that catches
 *  everything else. */
export const PROMPT_PARSERS: readonly PromptParser[] = [
  claudeNumberedParser,
  yesNoParser,
  genericParser,
];

/** Run every registered parser against the visible rows; return the first
 *  match, or null when nothing parses. */
export function runParserRegistry(rows: readonly string[]): MatchResult | null {
  for (const parser of PROMPT_PARSERS) {
    const m = parser.match(rows);
    if (m !== null) return m;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

/**
 * Pure: build the keystroke byte-string that answers a numbered prompt.
 *
 * Strategy: navigate from the highlighted index to the chosen index using
 * `\x1b[B` (down) / `\x1b[A` (up), then send `\r` (Enter) to confirm. For a
 * just-confirm-the-default click, this collapses to a bare `\r`.
 *
 * Exported as a string (not a Uint8Array) for testability; the detector /
 * overlay encodes via `TextEncoder` before `ws.send`.
 */
export function buildNumberedPayload(choices: readonly ChoiceOption[], chosenIndex: number): string {
  const highlighted = choices.find(c => c.highlighted);
  const fromIdx = highlighted !== undefined ? highlighted.index : 0;
  const delta = chosenIndex - fromIdx;
  if (delta === 0) return '\r';
  const arrow = delta > 0 ? '\x1b[B' : '\x1b[A';
  return arrow.repeat(Math.abs(delta)) + '\r';
}

/** Pure: build the cancel payload for a numbered prompt — sends Esc. */
export function buildNumberedCancelPayload(): string {
  return '\x1b';
}

/**
 * Pure: build the keystroke payload for a yes/no prompt. Always returns
 * lowercase `y\r` / `n\r` since virtually every CLI accepts either case.
 * The match's `yesIsCapital` / `noIsCapital` flags are preserved on the
 * `MatchResult` for future use (e.g. exact-case echo of the marker), but
 * the response stays simple here.
 */
export function buildYesNoPayload(_match: YesNoMatch, choice: 'yes' | 'no'): string {
  return (choice === 'yes' ? 'y' : 'n') + '\r';
}

/** Pure: build the cancel payload for yes/no prompts — sends Esc. Some
 *  shells treat Esc as cancel; others ignore it and the prompt stays open
 *  until the user responds. Returning Esc is the least-bad default. */
export function buildYesNoCancelPayload(): string {
  return '\x1b';
}

/** Pure: build the keystroke payload for the generic fallback. Caller
 *  collects free-form text from the overlay's textarea and passes it here.
 *  We always append `\r` so the shell processes it as a complete line. */
export function buildGenericPayload(text: string): string {
  return text + '\r';
}

/** Pure: cancel payload for the generic fallback. */
export function buildGenericCancelPayload(): string {
  return '\x1b';
}
