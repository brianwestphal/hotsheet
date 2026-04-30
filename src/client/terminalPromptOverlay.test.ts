/**
 * HS-8037 — happy-dom regression test for the terminal-prompt overlay's
 * title / context split. Pre-fix the overlay's title bar joined every
 * non-empty `questionLines` row with spaces ("WARNING: Loading
 * development channels --dangerously-load-development-channels …
 * server:hotsheet-channel"), and the framed `<pre>` context block right
 * below repeated the same content verbatim — the user explicitly flagged
 * this on HS-8037 ("redundantly shows … with a bunch of horizontal lines
 * before it"). Now the parser picks a single useful title line and the
 * overlay strips that line (plus pure-decoration rows) from the context
 * block before rendering, so the same content never appears twice.
 *
 * The parser-side title-pick is covered by `parsers.test.ts`; this spec
 * locks in the overlay-side strip + the no-empty-context-block fallback.
 */
// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import type { NumberedMatch } from '../shared/terminalPrompt/parsers.js';
import { openTerminalPromptOverlay } from './terminalPromptOverlay.js';

afterEach(() => {
  document.querySelectorAll('.terminal-prompt-overlay').forEach(el => el.remove());
});

function makeMatch(over: Partial<NumberedMatch> = {}): NumberedMatch {
  return {
    parserId: 'claude-numbered',
    shape: 'numbered',
    question: 'WARNING: Loading development channels',
    questionLines: [
      '  WARNING: Loading development channels',
      '',
      '  --dangerously-load-development-channels is for local channel development',
      '  only. Do not use this option to run channels you have downloaded off the',
      '  internet.',
      '',
      '  Channels: server:hotsheet-channel',
    ],
    signature: 'claude-numbered:abc:0',
    choices: [
      { index: 0, label: 'I am using this for local development', highlighted: true },
      { index: 1, label: 'Exit', highlighted: false },
    ],
    ...over,
  };
}

describe('terminal-prompt overlay context strip (HS-8037)', () => {
  it('renders the title in the header and the body in the framed context — no duplicate heading line', () => {
    openTerminalPromptOverlay({
      match: makeMatch(),
      onSend: () => true,
      onClose: () => { /* no-op */ },
    });

    const overlay = document.querySelector('.terminal-prompt-overlay');
    expect(overlay).not.toBeNull();

    const title = overlay?.querySelector('.terminal-prompt-overlay-title')?.textContent;
    expect(title).toBe('WARNING: Loading development channels');

    const context = overlay?.querySelector('.terminal-prompt-overlay-context')?.textContent ?? '';
    // Heading line is in the title — must NOT also appear in the framed
    // context block (that's the regression the user reported).
    expect(context).not.toContain('WARNING: Loading development channels');
    // Body lines are still present.
    expect(context).toContain('--dangerously-load-development-channels');
    expect(context).toContain('Channels: server:hotsheet-channel');
  });

  it('strips pure-decoration box-drawing rows from the framed context block', () => {
    openTerminalPromptOverlay({
      match: makeMatch({
        question: 'Choose your channel',
        questionLines: [
          '────────────────────────────────────────',
          'Choose your channel',
          '────────────────────────────────────────',
          '',
          'Pick the one you want to load.',
        ],
      }),
      onSend: () => true,
      onClose: () => { /* no-op */ },
    });

    const overlay = document.querySelector('.terminal-prompt-overlay');
    const context = overlay?.querySelector('.terminal-prompt-overlay-context')?.textContent ?? '';
    expect(context).not.toContain('────');
    // Title-line stripped too.
    expect(context).not.toContain('Choose your channel');
    // Real body content survives.
    expect(context).toContain('Pick the one you want to load.');
  });

  it('omits the framed context block entirely when the body is empty after stripping', () => {
    // Title-only prompt (no body paragraphs) — pre-fix the framed block
    // would render with whitespace; post-fix it shouldn't render at all.
    openTerminalPromptOverlay({
      match: makeMatch({
        question: 'Continue?',
        questionLines: ['Continue?'],
      }),
      onSend: () => true,
      onClose: () => { /* no-op */ },
    });

    const overlay = document.querySelector('.terminal-prompt-overlay');
    expect(overlay?.querySelector('.terminal-prompt-overlay-context')).toBeNull();
  });

  it('renders an Edit-tool diff prompt with the question in the title and the diff in the context (HS-7980 + HS-8037)', () => {
    openTerminalPromptOverlay({
      match: makeMatch({
        question: 'Do you want to overwrite authMfa.ts?',
        questionLines: [
          '@@ -1,3 +1,4 @@',
          ' export function authMfa() {',
          '-  return false;',
          '+  return true;',
          ' }',
          '',
          'Do you want to overwrite authMfa.ts?',
        ],
        choices: [
          { index: 0, label: 'Yes', highlighted: true },
          { index: 1, label: 'No', highlighted: false },
        ],
      }),
      onSend: () => true,
      onClose: () => { /* no-op */ },
    });

    const overlay = document.querySelector('.terminal-prompt-overlay');
    expect(overlay?.querySelector('.terminal-prompt-overlay-title')?.textContent).toBe('Do you want to overwrite authMfa.ts?');

    const context = overlay?.querySelector('.terminal-prompt-overlay-context')?.textContent ?? '';
    // Diff lines preserved.
    expect(context).toContain('-  return false;');
    expect(context).toContain('+  return true;');
    // Question line NOT duplicated in context.
    expect(context).not.toContain('Do you want to overwrite authMfa.ts?');
  });
});
