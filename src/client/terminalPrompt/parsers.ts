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

const NUMBERED_OPTION_RX = /^(\s*)([>])?\s*(\d+)\.\s+(.+?)\s*$/;

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
        const isHighlighted = m[2] === '>';
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
      // HS-7980 — Walk upward gathering ALL rows from `questionStartIdx`
      // back to the top of the scan window. We preserve blank-row
      // separators so the overlay's monospaced context block keeps the
      // structure of an inline diff (which Claude renders separated from
      // the actual question line by a blank). Pre-fix the loop stopped at
      // the first blank, so a diff above the question vanished.
      let j = questionStartIdx;
      // Skip trailing blank rows immediately before the numbered block —
      // they aren't useful context.
      while (j >= 0 && trimmed[j].trim() === '') j--;
      // Snapshot all rows from here back to the top, dropping leading
      // blanks (rows whose ONLY content is whitespace at the start of the
      // scan window).
      const accumulated: string[] = [];
      for (let k = j; k >= 0; k--) {
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

    // Single-line summary — used in the overlay's title bar (chrome is
    // narrow, so multi-line diffs would overflow). Long lines truncated by
    // CSS via `overflow: hidden; text-overflow: ellipsis`.
    const summary = questionLines.length > 0
      ? questionLines.map(l => l.trim()).filter(l => l.length > 0).join(' ').trim()
      : '';
    const question = summary !== '' ? summary : '(unlabelled prompt)';
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
