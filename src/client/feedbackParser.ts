/**
 * Feedback-prompt splitter (HS-6998).
 *
 * AI-generated feedback prompts are unpredictable: sometimes a neat numbered
 * list of independent questions, sometimes a paragraph ending in "which of
 * A/B/C/D/E should I do?" with the letters being options rather than parts.
 * An earlier version of this module tried to auto-detect "parts" from the
 * first list it found — that failed on mixed prompts where the list was an
 * options menu, not a question set. This version does NOT try to guess.
 *
 * Instead, we split the prompt into top-level markdown blocks (paragraphs,
 * lists, headings, code blocks, ...) via `marked.lexer`. The dialog renders
 * each block verbatim with an "+ Add response" affordance between blocks, so
 * the user can insert their own response textareas wherever they want. A
 * catch-all textarea always sits at the bottom for a single free-form reply.
 *
 * On submit, if only the catch-all was used, the note body is just that text.
 * If any inline responses were added, `combineQuotedResponse` re-emits the
 * prompt blocks as markdown quotes (`> ...`) with the user's responses
 * interleaved in the correct order — the reader sees the original question
 * text right next to each answer.
 */
import './markdownSetup.js';

import { marked, type Tokens } from 'marked';

export interface FeedbackBlock {
  /** Raw markdown source of the block (paragraph, list, heading, etc.). */
  markdown: string;
  /** Pre-rendered HTML ready to inject via `raw()`. */
  html: string;
}

export interface BlockResponse {
  /** Index of the prompt block this response follows. */
  blockIndex: number;
  /** The response text the user entered. */
  text: string;
}

/** Split a prompt into top-level markdown blocks. Always returns an array
 *  (possibly empty for whitespace-only input). `space` tokens and empty
 *  blocks are dropped so the caller doesn't need to filter.
 *
 *  HS-7930 — every top-level list is always split into one block per item,
 *  so the user gets a click-to-add-response point between every question /
 *  option / line. Pre-HS-7930 a heuristic decided per-list whether to split
 *  (HS-7558); the heuristic mis-fired often enough that the user asked for
 *  the dialog's split-points to be uniform and user-driven. The dialog now
 *  hides every insert affordance until the user hovers the gap, so the
 *  finer-grained always-split layout adds zero visual noise to prompts that
 *  the user doesn't intend to insert into. Sub-bullets nested under a list
 *  item still stay with their parent — they're typically clarifications,
 *  not independent questions. */
export function parseFeedbackBlocks(prompt: string): FeedbackBlock[] {
  if (typeof prompt !== 'string' || prompt.trim() === '') return [];

  let tokens: Tokens.Generic[];
  try {
    tokens = marked.lexer(prompt);
  } catch {
    return [{ markdown: prompt.trim(), html: marked.parse(prompt, { async: false }) }];
  }

  // Filter out space + empty tokens upfront so the always-split logic doesn't
  // emit empty list-item blocks for whitespace-only items.
  const meaningful: Tokens.Generic[] = [];
  for (const t of tokens) {
    if (t.type === 'space') continue;
    if (t.raw.trim() === '') continue;
    meaningful.push(t);
  }

  const blocks: FeedbackBlock[] = [];
  for (const t of meaningful) {
    const md = t.raw.trim();
    if (md === '') continue;

    // HS-7930 — always split lists into per-item blocks. Empty items are
    // dropped (defensive — `meaningful` already filters whitespace-only
    // top-level tokens, but a list could still contain a blank item).
    if (t.type === 'list') {
      const list = t as Tokens.List;
      if (list.items.length === 0) continue;
      for (const item of list.items) {
        const itemMd = item.raw.trim();
        if (itemMd === '') continue;
        blocks.push({ markdown: itemMd, html: marked.parse(itemMd, { async: false }) });
      }
      continue;
    }

    blocks.push({ markdown: md, html: marked.parse(md, { async: false }) });
  }
  return blocks;
}

/**
 * Combine the prompt blocks and the user's responses into a single markdown
 * note body. The prompt blocks are emitted as markdown blockquotes (`> `) so
 * they visually group together, and the user's responses appear un-quoted
 * between them.
 *
 * Responses are attached to blocks by `blockIndex`: a response with
 * `blockIndex === N` appears after block N. Multiple responses may share a
 * blockIndex and are emitted in their original order. A catch-all response
 * (the always-present bottom textarea) is appended last, un-quoted.
 *
 * If `inlineResponses` is empty, the catch-all is returned verbatim with no
 * quoting — no point restating the whole prompt back at the reader when the
 * user just typed a single free-form reply.
 */
export function combineQuotedResponse(
  blocks: FeedbackBlock[],
  inlineResponses: BlockResponse[],
  catchAll: string,
): string {
  const catchText = catchAll.trim();
  const liveResponses = inlineResponses.filter(r => r.text.trim() !== '');

  if (liveResponses.length === 0) return catchText;

  const pieces: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    pieces.push(quoteMarkdown(blocks[i].markdown));
    for (const r of liveResponses) {
      if (r.blockIndex === i) pieces.push(r.text.trim());
    }
  }
  // Any responses whose blockIndex is out of range (shouldn't happen in normal
  // flow, but guard against it) append at the end in their original order.
  const maxIdx = blocks.length - 1;
  for (const r of liveResponses) {
    if (r.blockIndex > maxIdx) pieces.push(r.text.trim());
  }

  if (catchText !== '') pieces.push(catchText);
  return pieces.join('\n\n');
}

function quoteMarkdown(md: string): string {
  return md
    .split('\n')
    .map(line => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}
