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
// Registry
// ---------------------------------------------------------------------------

/** Registry order is priority order. Parsers are tried in array order; first
 *  non-null match wins. Phase 1 ships only `claude-numbered`; HS-7971
 *  Phase 2 will add `yesno` and the `generic` fallback. */
export const PROMPT_PARSERS: readonly PromptParser[] = [claudeNumberedParser];

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
