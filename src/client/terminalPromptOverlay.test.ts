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

import type { GenericMatch, NumberedMatch, YesNoMatch } from '../shared/terminalPrompt/parsers.js';
import { openTerminalPromptOverlay, sourceLabelForMatch } from './terminalPromptOverlay.js';

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

    const title = overlay?.querySelector('.dialog-shell-title')?.textContent;
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
    expect(overlay?.querySelector('.dialog-shell-title')?.textContent).toBe('Do you want to overwrite authMfa.ts?');

    const context = overlay?.querySelector('.terminal-prompt-overlay-context')?.textContent ?? '';
    // Diff lines preserved.
    expect(context).toContain('-  return false;');
    expect(context).toContain('+  return true;');
    // Question line NOT duplicated in context.
    expect(context).not.toContain('Do you want to overwrite authMfa.ts?');
  });
});

/**
 * HS-8068 — every overlay shape that can be allow-listed (numbered +
 * yesno) gets a source-name chip in the header so the visual rhythm
 * mirrors §47's permission-popup `tool_name` chip. Generic-fallback
 * overlays don't show a chip — there's no meaningful source label
 * (the heuristic fired without a parser claiming the prompt).
 */
describe('terminal-prompt overlay tool-name chip (HS-8068)', () => {
  it('renders the `Claude` chip for claude-numbered prompts', () => {
    const match = makeMatch();
    expect(sourceLabelForMatch(match)).toBe('Claude');
    openTerminalPromptOverlay({
      match,
      onSend: () => true,
      onClose: () => { /* no-op */ },
    });
    const overlay = document.querySelector('.terminal-prompt-overlay');
    const chip = overlay?.querySelector('.dialog-shell-tool');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe('Claude');
  });

  it('renders the `Shell` chip for yesno prompts', () => {
    const match: YesNoMatch = {
      parserId: 'yesno',
      shape: 'yesno',
      question: 'Continue? (y/n)',
      questionLines: ['Continue? (y/n)'],
      signature: 'yesno:hash:0',
      yesIsCapital: false,
      noIsCapital: false,
    };
    expect(sourceLabelForMatch(match)).toBe('Shell');
    openTerminalPromptOverlay({
      match,
      onSend: () => true,
      onClose: () => { /* no-op */ },
    });
    // HS-8069 — `.terminal-prompt-overlay-yesno` moved to the inner
    // `.terminal-prompt-overlay-actions` div post-shell-migration; the
    // chip lives in the outer overlay's shell-rendered header.
    const overlay = document.querySelector('.terminal-prompt-overlay');
    const chip = overlay?.querySelector('.dialog-shell-tool');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe('Shell');
  });

  it('hides the chip for generic-fallback prompts (sourceLabel returns null)', () => {
    const match: GenericMatch = {
      parserId: 'generic',
      shape: 'generic',
      question: 'Pick something:',
      questionLines: ['Pick something:'],
      signature: 'generic:hash:0',
      rawText: 'Pick something:\n[A] one\n[B] two',
    };
    expect(sourceLabelForMatch(match)).toBeNull();
    openTerminalPromptOverlay({
      match,
      onSend: () => true,
      onClose: () => { /* no-op */ },
    });
    // HS-8069 — outer overlay is `.terminal-prompt-overlay`; the
    // generic-specific class moved to the inner actions container.
    const overlay = document.querySelector('.terminal-prompt-overlay');
    expect(overlay?.querySelector('.dialog-shell-tool')).toBeNull();
  });

  it('falls back to the raw parserId for unknown parser registrations (defensive)', () => {
    // Hypothetical future parser that hasn't been added to the chip
    // mapping — chip surfaces the raw id so a misconfiguration is
    // visible in QA rather than silently hidden.
    const match: NumberedMatch = makeMatch({ parserId: 'fancy-future-parser' });
    expect(sourceLabelForMatch(match)).toBe('fancy-future-parser');
  });
});

/**
 * HS-8067 — Minimize / "No response needed" footer links bring the
 * §52 terminal-prompt overlay up to feature parity with §47's
 * permission popup so the shared dialog shell (HS-8066) can render
 * both surfaces uniformly. Both bypass the existing `onClose` path
 * (which posts `/terminal/prompt-dismiss` server-side) and fire
 * dedicated `onMinimize` / `onNoResponseNeeded` callbacks instead —
 * the dispatcher (`bellPoll.tsx`) decides the server-side behaviour
 * for each.
 */
describe('terminal-prompt overlay Minimize / No-response-needed footer (HS-8067)', () => {
  it('renders neither link when neither callback is provided (back-compat)', () => {
    openTerminalPromptOverlay({
      match: makeMatch(),
      onSend: () => true,
      onClose: () => { /* no-op */ },
    });
    const overlay = document.querySelector('.terminal-prompt-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay?.querySelector('.terminal-prompt-overlay-links')).toBeNull();
  });

  it('renders both links when both callbacks are provided', () => {
    openTerminalPromptOverlay({
      match: makeMatch(),
      onSend: () => true,
      onClose: () => { /* no-op */ },
      onMinimize: () => { /* no-op */ },
      onNoResponseNeeded: () => { /* no-op */ },
    });
    const overlay = document.querySelector('.terminal-prompt-overlay');
    expect(overlay?.querySelector('.dialog-shell-minimize-link')).not.toBeNull();
    expect(overlay?.querySelector('.dialog-shell-dismiss-link')).not.toBeNull();
    // Separator only shows when BOTH links are present.
    expect(overlay?.querySelector('.dialog-shell-links-sep')).not.toBeNull();
  });

  it('omits the separator when only one of the two links is rendered', () => {
    openTerminalPromptOverlay({
      match: makeMatch(),
      onSend: () => true,
      onClose: () => { /* no-op */ },
      onMinimize: () => { /* no-op */ },
    });
    const overlay = document.querySelector('.terminal-prompt-overlay');
    expect(overlay?.querySelector('.dialog-shell-minimize-link')).not.toBeNull();
    expect(overlay?.querySelector('.dialog-shell-dismiss-link')).toBeNull();
    expect(overlay?.querySelector('.dialog-shell-links-sep')).toBeNull();
  });

  it('Minimize link click fires onMinimize and tears down DOM, NOT onClose', () => {
    let onCloseCalls = 0;
    let onMinimizeCalls = 0;
    openTerminalPromptOverlay({
      match: makeMatch(),
      onSend: () => true,
      onClose: () => { onCloseCalls += 1; },
      onMinimize: () => { onMinimizeCalls += 1; },
    });
    const link = document.querySelector<HTMLAnchorElement>('.dialog-shell-minimize-link');
    expect(link).not.toBeNull();
    link?.click();
    expect(onMinimizeCalls).toBe(1);
    // onClose's server-dismiss POST happens for ACTIVE dismissal only;
    // Minimize keeps the server-side pending entry alive for restore.
    expect(onCloseCalls).toBe(0);
    expect(document.querySelector('.terminal-prompt-overlay')).toBeNull();
  });

  it('"No response needed" link click fires onNoResponseNeeded and tears down DOM, NOT onClose', () => {
    let onCloseCalls = 0;
    let onDismissCalls = 0;
    openTerminalPromptOverlay({
      match: makeMatch(),
      onSend: () => true,
      onClose: () => { onCloseCalls += 1; },
      onNoResponseNeeded: () => { onDismissCalls += 1; },
    });
    const link = document.querySelector<HTMLAnchorElement>('.dialog-shell-dismiss-link');
    expect(link).not.toBeNull();
    link?.click();
    expect(onDismissCalls).toBe(1);
    expect(onCloseCalls).toBe(0);
    expect(document.querySelector('.terminal-prompt-overlay')).toBeNull();
  });

  // HS-8071 — the Cancel button was removed from numbered + yesno + generic
  // overlay shapes per the user's feedback ("the 'cancel' button can be
  // removed, its not helpful"). Esc still cancels via the capture-phase
  // keyboard handler in `mountShellWithEsc`; the X-close button on the
  // shell header dismisses without sending. Keeping a regression test so
  // an accidental re-introduction (e.g. from a future shape) gets caught.
  it('Cancel button is no longer rendered (HS-8071)', () => {
    openTerminalPromptOverlay({
      match: makeMatch(),
      onSend: () => true,
      onClose: () => { /* no-op */ },
      onMinimize: () => { /* no-op */ },
      onNoResponseNeeded: () => { /* no-op */ },
    });
    expect(document.querySelector('.terminal-prompt-overlay-cancel')).toBeNull();
  });

  it('Escape still cancels the overlay (numbered shape) — sends the cancel payload + closes (HS-8071)', () => {
    let sendCalls = 0;
    let lastSend = '';
    openTerminalPromptOverlay({
      match: makeMatch(),
      onSend: (payload) => { sendCalls += 1; lastSend = payload; return true; },
      onClose: () => { /* no-op */ },
      onMinimize: () => { /* no-op */ },
      onNoResponseNeeded: () => { /* no-op */ },
    });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(sendCalls).toBe(1);
    expect(lastSend).toBe('\x1b'); // numbered cancel payload
    expect(document.querySelector('.terminal-prompt-overlay')).toBeNull();
  });
});
