/**
 * Heuristic parser that splits a feedback-request prompt into intro text,
 * a sequence of individual "parts" (questions), and closing text so the
 * feedback dialog can render a dedicated response textarea next to each part
 * (HS-6998). When no clear multi-part pattern is detected, returns `null`
 * and the dialog falls back to its single-textarea UI.
 *
 * AI-generated feedback requests are almost always one of two shapes:
 *
 *   Pattern A — numbered list:
 *     Some intro context.
 *     1. First question / item / decision
 *     2. Second one
 *     3. Third
 *     Closing remarks.
 *
 *   Pattern B — bullet list:
 *     Some intro context.
 *     - First question
 *     - Second question
 *     Closing remarks.
 *
 * The parser uses marked's lexer so nested markdown inside each item (bold,
 * code, links) is preserved. We look for the first top-level list token with
 * **≥ 2 items**; single-item lists or zero-item prompts fall through.
 *
 * Multiple sibling lists are consolidated only when the first qualifying
 * list is found — trailing lists fold into the outro (they're rarely the
 * primary question set, and conservatively falling back avoids misclassifying
 * a closing "to-do" or "references" list as questions).
 */
import { marked, type Tokens } from 'marked';

export interface FeedbackPart {
  /** The raw markdown source of this part (what the AI wrote). Used as the
   *  question label rendered next to the response textarea. */
  markdown: string;
  /** Optional short label for the aria-label / heading — derived from the
   *  first 60 characters of the plain-text form, for screen-reader context. */
  shortLabel: string;
}

export interface ParsedFeedback {
  /** Markdown before the first qualifying list. May be empty. */
  intro: string;
  parts: FeedbackPart[];
  /** Markdown after the list. May be empty. */
  outro: string;
}

export function parseFeedbackPrompt(prompt: string): ParsedFeedback | null {
  if (typeof prompt !== 'string' || prompt.trim() === '') return null;

  let tokens: Tokens.Generic[];
  try {
    tokens = marked.lexer(prompt) as Tokens.Generic[];
  } catch {
    return null;
  }

  // Find the first list token with at least 2 items. Ordered or unordered.
  let listIndex = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'list') {
      const items = (t as Tokens.List).items;
      if (items.length >= 2) {
        listIndex = i;
        break;
      }
    }
  }
  if (listIndex < 0) return null;

  const listToken = tokens[listIndex] as Tokens.List;
  const parts: FeedbackPart[] = listToken.items.map((item) => {
    const md = extractItemMarkdown(item);
    return {
      markdown: md,
      shortLabel: md.replace(/\s+/g, ' ').trim().slice(0, 60),
    };
  });

  const intro = stitchTokens(tokens.slice(0, listIndex)).trim();
  const outro = stitchTokens(tokens.slice(listIndex + 1)).trim();

  return { intro, parts, outro };
}

/**
 * Combine the user's per-part response strings back into a single markdown
 * blob that preserves the original numbering, so downstream consumers (the
 * AI reading the note) can re-align responses to questions. Uses the SAME
 * number / bullet scheme marked detected in the prompt (ordered → `1.`,
 * unordered → `-`).
 *
 * Empty responses are preserved as blank answers so the numbering stays
 * aligned; they DO contribute a "(no response)" placeholder so the reader
 * sees what the user intentionally skipped vs. what they missed.
 */
export function combineResponses(responses: string[], ordered: boolean): string {
  const pieces: string[] = [];
  for (let i = 0; i < responses.length; i++) {
    const marker = ordered ? `${i + 1}.` : '-';
    const text = responses[i].trim();
    const body = text === '' ? '*(no response)*' : text;
    pieces.push(`${marker} ${body}`);
  }
  return pieces.join('\n\n');
}

// --- Internals ---

function extractItemMarkdown(item: Tokens.ListItem): string {
  // `item.raw` is "1. Foo\n   continuation\n" or "- Foo\n". Strip the leading
  // list marker so the rendered bubble shows the raw question text without a
  // redundant number/bullet.
  return item.raw
    .replace(/^\s*(?:\d+[.)]|[-*+])\s+/, '')
    .replace(/\n[ \t]+/g, '\n')
    .trimEnd();
}

function stitchTokens(tokens: Tokens.Generic[]): string {
  return tokens.map((t) => t.raw).join('');
}
