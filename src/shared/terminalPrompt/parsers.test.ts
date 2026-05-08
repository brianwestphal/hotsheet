/**
 * HS-7971 Phase 1 — pure-helper tests for the terminal prompt parser
 * registry. Exercises the Claude-Ink numbered-choice parser against the
 * concrete shape from the user's screenshot (the dev-channels safety
 * prompt) plus a battery of negative cases that should NOT match.
 */
import { describe, expect, it } from 'vitest';

import {
  buildGenericCancelPayload,
  buildGenericPayload,
  buildNumberedCancelPayload,
  buildNumberedPayload,
  buildYesNoCancelPayload,
  buildYesNoPayload,
  claudeNumberedParser,
  genericParser,
  hashQuestion,
  isClaudeNumberedFooter,
  isDecorativeLine,
  pickTitleLine,
  runParserRegistry,
  stripClaudeInputBox,
  stripClaudeStatusBar,
  trimRows,
  yesNoParser,
} from './parsers.js';

describe('hashQuestion (HS-7971)', () => {
  it('returns 8 hex chars', () => {
    expect(hashQuestion('hello')).toMatch(/^[0-9a-f]{8}$/);
  });
  it('is stable across calls', () => {
    expect(hashQuestion('Loading dev channels')).toBe(hashQuestion('Loading dev channels'));
  });
  it('lower-cases + trims so cosmetic differences don\'t break allow-rule keying', () => {
    expect(hashQuestion('Hello World')).toBe(hashQuestion('  hello world  '));
  });
  it('produces different hashes for distinct questions', () => {
    expect(hashQuestion('a')).not.toBe(hashQuestion('b'));
  });
});

describe('trimRows (HS-7971)', () => {
  it('drops trailing empty rows', () => {
    expect(trimRows(['a', '', 'b', '', '', ''])).toEqual(['a', '', 'b']);
  });
  it('trims trailing whitespace per row', () => {
    expect(trimRows(['hello   ', 'world\t'])).toEqual(['hello', 'world']);
  });
  it('keeps leading empty rows (Ink centring) intact', () => {
    expect(trimRows(['', 'a'])).toEqual(['', 'a']);
  });
});

describe('isClaudeNumberedFooter (HS-7971)', () => {
  it('matches the long form', () => {
    expect(isClaudeNumberedFooter('Enter to confirm · Esc to cancel')).toBe(true);
  });
  it('matches the short form', () => {
    expect(isClaudeNumberedFooter('Enter to confirm')).toBe(true);
  });
  it('tolerates trailing whitespace', () => {
    expect(isClaudeNumberedFooter('Enter to confirm   ')).toBe(true);
  });
  it('rejects unrelated lines', () => {
    expect(isClaudeNumberedFooter('Press Enter to continue')).toBe(false);
    expect(isClaudeNumberedFooter('Loading...')).toBe(false);
  });
  // HS-8216 — Claude Code 2026-05 builds emit `Esc to cancel · Tab to amend`
  // as the trailing footer when the prompt has an "amend" affordance (e.g.
  // a `…allow during this session` option the user can scope tighter with
  // Tab). Pre-fix this fell through the hardcoded Set and the parser
  // dropped the whole prompt.
  it('matches the Esc-to-cancel · Tab-to-amend variant (HS-8216)', () => {
    expect(isClaudeNumberedFooter('Esc to cancel · Tab to amend')).toBe(true);
  });
  it('matches the bare Esc-to-cancel form (HS-8216)', () => {
    expect(isClaudeNumberedFooter('Esc to cancel')).toBe(true);
  });
  it('tolerates trailing whitespace on the new variants (HS-8216)', () => {
    expect(isClaudeNumberedFooter('Esc to cancel · Tab to amend   ')).toBe(true);
  });
  it('matches future-proof suffix clauses (HS-8216)', () => {
    expect(isClaudeNumberedFooter('Enter to confirm · Tab to expand')).toBe(true);
    expect(isClaudeNumberedFooter('Esc to cancel · Shift+Tab to skip')).toBe(true);
  });
  it('rejects lookalikes that share the leading phrase but continue with prose (HS-8216)', () => {
    // Without a ` · ` separator the regex requires end-of-string after the
    // leading phrase, so an arbitrary docs line starting with the phrase
    // doesn't trip the matcher.
    expect(isClaudeNumberedFooter('Esc to cancel the operation')).toBe(false);
    expect(isClaudeNumberedFooter('Enter to confirm and proceed')).toBe(false);
  });

  // HS-8297 / HS-8304 (2026-05-08) — AskUserQuestion footer detection. The
  // user reported `/test-permission-yes-no` and `/test-permission-multiple-
  // choice` rendered numbered TUIs that §52 never overlaid. Root cause: the
  // tool's footer is `Enter to select  ↑↓ to navigate  Esc to cancel`,
  // which uses `Enter to select` (not `Enter to confirm`) AND multi-space
  // separators between segments instead of ` · `.
  it('matches the AskUserQuestion `Enter to select` verb (HS-8297 / HS-8304)', () => {
    expect(isClaudeNumberedFooter('Enter to select')).toBe(true);
  });
  it('matches the AskUserQuestion footer with the ↑↓-to-navigate middle clause (HS-8297 / HS-8304)', () => {
    // Multi-space separator (instead of the permission-prompt ` · ` separator)
    // is the AskUserQuestion convention.
    expect(isClaudeNumberedFooter('Enter to select  ↑↓ to navigate  Esc to cancel')).toBe(true);
  });
  it('matches the AskUserQuestion footer with extra trailing spaces (HS-8297 / HS-8304)', () => {
    expect(isClaudeNumberedFooter('Enter to select  ↑↓ to navigate  Esc to cancel   ')).toBe(true);
  });
  it('rejects "Enter to select" lookalike with prose continuation (HS-8297 / HS-8304)', () => {
    // Defence in depth — the regex still requires either a separator or
    // end-of-string after the leading phrase, so a docs line starting
    // with the verb doesn't accidentally match.
    expect(isClaudeNumberedFooter('Enter to select an option from the menu below')).toBe(false);
  });
});

describe('claudeNumberedParser — AskUserQuestion shape (HS-8297 / HS-8304)', () => {
  // The user-reported case from HS-8297 / HS-8304 — AskUserQuestion renders
  // a numbered prompt where each option has a description line below it,
  // blank rows separate options, and the footer uses `Enter to select` +
  // multi-space-separated middle/trailing clauses. Pre-fix the parser broke
  // at the first description / inter-option blank and dropped the prompt.
  it('parses a 2-option AskUserQuestion (HS-8297 yes-no skill repro)', () => {
    const rows = [
      'Proceed?',
      '',
      '> 1. Yes',
      '   Confirm and continue with the test action.',
      '  2. No',
      '   Cancel — do not perform the test action.',
      '',
      'Enter to select  ↑↓ to navigate  Esc to cancel',
    ];
    const result = claudeNumberedParser.match(rows);
    expect(result).not.toBeNull();
    if (result?.shape !== 'numbered') return;
    expect(result.choices).toHaveLength(2);
    expect(result.choices[0]).toEqual({ index: 0, label: 'Yes', highlighted: true });
    expect(result.choices[1]).toEqual({ index: 1, label: 'No', highlighted: false });
    expect(result.question).toBe('Proceed?');
  });

  it('parses a 4-option AskUserQuestion with blank-separated option groups (HS-8304 multiple-choice skill repro)', () => {
    // Mirrors the screenshot in HS-8304 — descriptions on first two options,
    // bare options 3 and 4, blank between option pairs.
    const rows = [
      'Pick one',
      '',
      '> 1. Option A',
      '   The first option — selecting it should be fast and uneventful.',
      '  2. Option B',
      '   The second option — a slightly different path with similar shape.',
      '',
      '  3. Option C',
      '  4. Option D',
      '',
      'Enter to select  ↑↓ to navigate  Esc to cancel',
    ];
    const result = claudeNumberedParser.match(rows);
    expect(result).not.toBeNull();
    if (result?.shape !== 'numbered') return;
    expect(result.choices).toHaveLength(4);
    expect(result.choices.map(c => c.label)).toEqual(['Option A', 'Option B', 'Option C', 'Option D']);
    expect(result.choices[0].highlighted).toBe(true);
    expect(result.question).toBe('Pick one');
  });

  it('does not break the existing dev-channels permission-prompt shape (defence-in-depth)', () => {
    // Same fixture as the original happy-path test — the HS-8297 / HS-8304
    // walk-upward changes (skip blanks, skip indented descriptions) MUST
    // continue to produce identical output for prompts that don't use either
    // shape. Re-asserting here keeps the regression bar visible alongside
    // the new fixtures.
    const rows = [
      'Loading development channels can pose a security risk',
      '',
      '> 1. I am using this for local development',
      '  2. Exit',
      '',
      'Enter to confirm · Esc to cancel',
    ];
    const result = claudeNumberedParser.match(rows);
    expect(result).not.toBeNull();
    if (result?.shape !== 'numbered') return;
    expect(result.choices).toHaveLength(2);
    expect(result.choices[0].label).toBe('I am using this for local development');
    expect(result.question).toBe('Loading development channels can pose a security risk');
  });
});

describe('claudeNumberedParser (HS-7971) — happy paths', () => {
  it('parses the dev-channels warning shape (the user-reported case)', () => {
    // From HS-7971's screenshot — the exact text claude renders pre-MCP.
    const rows = [
      'Loading development channels can pose a security risk',
      '',
      '> 1. I am using this for local development',
      '  2. Exit',
      '',
      'Enter to confirm · Esc to cancel',
    ];
    const result = claudeNumberedParser.match(rows);
    expect(result).not.toBeNull();
    expect(result?.parserId).toBe('claude-numbered');
    expect(result?.shape).toBe('numbered');
    if (result?.shape !== 'numbered') return;
    expect(result.choices).toHaveLength(2);
    expect(result.choices[0]).toEqual({
      index: 0,
      label: 'I am using this for local development',
      highlighted: true,
    });
    expect(result.choices[1]).toEqual({
      index: 1,
      label: 'Exit',
      highlighted: false,
    });
    expect(result.question).toBe('Loading development channels can pose a security risk');
    // Signature shape: claude-numbered:<hash>:<defaultIdx>
    expect(result.signature).toMatch(/^claude-numbered:[0-9a-f]{8}:0$/);
  });

  // HS-7995 — Recent Claude Code builds render the highlighted-row cursor as
  // `❯` (U+276F) rather than `>`. Pre-fix the parser still matched the
  // non-highlighted option line, but the highlighted row failed the regex,
  // leaving only one parsed choice → the prompt was silently rejected and
  // no overlay surfaced. This is the EXACT byte-stream shape observed via
  // `script(1)` capture of `claude --dangerously-load-development-channels`.
  it('parses the production dev-channels prompt with `❯` cursor (HS-7995)', () => {
    const rows = [
      '  WARNING: Loading development channels',
      '',
      '  --dangerously-load-development-channels is for local channel development',
      '  only. Do not use this option to run channels you have downloaded off the',
      '  internet.',
      '',
      '  Please use --channels to run a list of approved channels.',
      '',
      '  Channels: server:test',
      '',
      '  ❯ 1. I am using this for local development',
      '    2. Exit',
      '',
      '  Enter to confirm · Esc to cancel',
    ];
    const result = claudeNumberedParser.match(rows);
    expect(result).not.toBeNull();
    if (result?.shape !== 'numbered') throw new Error('expected numbered');
    expect(result.choices).toHaveLength(2);
    expect(result.choices[0]).toEqual({
      index: 0,
      label: 'I am using this for local development',
      highlighted: true,
    });
    expect(result.choices[1]).toEqual({
      index: 1,
      label: 'Exit',
      highlighted: false,
    });
    expect(result.signature).toMatch(/^claude-numbered:[0-9a-f]{8}:0$/);
  });

  // HS-8216 (2026-05-06) — user-reported regression. In a project whose
  // claude session was NOT MCP-connected (so the §47 popup path doesn't
  // fire), running a prompt that asks Read permission produced a TUI
  // numbered prompt with a `Esc to cancel · Tab to amend` footer. Pre-fix
  // the hardcoded `NUMBERED_FOOTERS` set didn't include that variant, so
  // the parser returned null and the §52 overlay never surfaced. This
  // test pins the exact text the user pasted from their LingoGist
  // terminal so any future footer-set drift is caught immediately.
  it('parses the LingoGist Read-permission prompt with `Esc to cancel · Tab to amend` footer (HS-8216)', () => {
    const rows = [
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. Yes, allow reading from Desktop/ during this session',
      '   3. No',
      '',
      ' Esc to cancel · Tab to amend',
    ];
    const result = claudeNumberedParser.match(rows);
    expect(result).not.toBeNull();
    if (result?.shape !== 'numbered') throw new Error('expected numbered');
    expect(result.choices).toHaveLength(3);
    expect(result.choices[0]).toEqual({ index: 0, label: 'Yes', highlighted: true });
    expect(result.choices[1].label).toBe('Yes, allow reading from Desktop/ during this session');
    expect(result.choices[2]).toEqual({ index: 2, label: 'No', highlighted: false });
    expect(result.question).toBe('Do you want to proceed?');
    expect(result.signature).toMatch(/^claude-numbered:[0-9a-f]{8}:0$/);
  });

  it('treats `▶` and `►` as cursor markers too (HS-7995 follow-up — robustness)', () => {
    for (const cursor of ['▶', '►']) {
      const rows = [
        'Pick',
        '',
        `${cursor} 1. A`,
        '  2. B',
        '',
        'Enter to confirm · Esc to cancel',
      ];
      const result = claudeNumberedParser.match(rows);
      if (result?.shape !== 'numbered') throw new Error(`expected numbered for ${cursor}`);
      expect(result.choices[0].highlighted).toBe(true);
      expect(result.choices[1].highlighted).toBe(false);
    }
  });

  it('handles the second option being highlighted', () => {
    const rows = [
      'Pick one',
      '',
      '  1. Foo',
      '> 2. Bar',
      '',
      'Enter to confirm · Esc to cancel',
    ];
    const result = claudeNumberedParser.match(rows);
    if (result?.shape !== 'numbered') throw new Error('expected numbered');
    expect(result.choices[1].highlighted).toBe(true);
    expect(result.choices[0].highlighted).toBe(false);
    expect(result.signature).toMatch(/:1$/);
  });

  it('still parses when no row carries the `>` cursor (defaults to first option)', () => {
    const rows = [
      'Question',
      '',
      '  1. A',
      '  2. B',
      '',
      'Enter to confirm · Esc to cancel',
    ];
    const result = claudeNumberedParser.match(rows);
    if (result?.shape !== 'numbered') throw new Error('expected numbered');
    // No highlighted option → defaultIdx falls back to 0.
    expect(result.signature).toMatch(/:0$/);
    expect(result.choices.every(c => !c.highlighted)).toBe(true);
  });

  it('handles 3+ options', () => {
    const rows = [
      'Pick',
      '',
      '> 1. Yes',
      '  2. No',
      '  3. Maybe',
      '',
      'Enter to confirm',
    ];
    const result = claudeNumberedParser.match(rows);
    if (result?.shape !== 'numbered') throw new Error('expected numbered');
    expect(result.choices.map(c => c.label)).toEqual(['Yes', 'No', 'Maybe']);
  });

  it('falls back to "(unlabelled prompt)" when there\'s no question text above the options', () => {
    const rows = [
      '> 1. A',
      '  2. B',
      '',
      'Enter to confirm · Esc to cancel',
    ];
    const result = claudeNumberedParser.match(rows);
    if (result?.shape !== 'numbered') throw new Error('expected numbered');
    expect(result.question).toBe('(unlabelled prompt)');
  });

  // HS-8037 — pre-fix the title joined every non-empty line with spaces,
  // which read as a wall of text in the title bar AND duplicated the same
  // content already visible in the framed `<pre>` context block below.
  // Now the title is the single most useful line: the trailing `?` line
  // for diff-shape prompts (covered by the next test), or the first non-
  // decorative heading line for warning-shape prompts (this case). The
  // remaining lines stay in `questionLines` for the framed context block.
  it('uses the first non-decorative line as the title for prose-shape multi-line questions (HS-8037)', () => {
    const rows = [
      'Loading development channels',
      'can pose a security risk',
      '',
      '> 1. Yes',
      '  2. Exit',
      '',
      'Enter to confirm · Esc to cancel',
    ];
    const result = claudeNumberedParser.match(rows);
    if (result?.shape !== 'numbered') throw new Error('expected numbered');
    expect(result.question).toBe('Loading development channels');
    // The body lives in questionLines — the framed context block consumes it.
    expect(result.questionLines).toContain('Loading development channels');
    expect(result.questionLines).toContain('can pose a security risk');
  });

  // HS-7980 — Claude renders an inline diff above the choices for an Edit-tool
  // prompt. The single-line `question` is the title-bar summary; the
  // `questionLines` array preserves the structure for the overlay's
  // monospaced context block.
  it('preserves multi-line context (e.g. Edit-tool diff) in questionLines', () => {
    const rows = [
      '@@ -1,3 +1,4 @@',
      ' export function authMfa() {',
      '-  return false;',
      '+  return true;',
      ' }',
      '',
      'Do you want to overwrite authMfa.ts?',
      '',
      '> 1. Yes',
      '  2. Yes, allow all edits during this session',
      '  3. No',
      '',
      'Enter to confirm · Esc to cancel',
    ];
    const result = claudeNumberedParser.match(rows);
    if (result?.shape !== 'numbered') throw new Error('expected numbered');
    expect(result.choices).toHaveLength(3);
    // questionLines preserves every line in the context region — diff +
    // question, joined by neighbouring blank-row gaps.
    expect(result.questionLines).toContain('@@ -1,3 +1,4 @@');
    expect(result.questionLines).toContain('-  return false;');
    expect(result.questionLines).toContain('+  return true;');
    expect(result.questionLines).toContain('Do you want to overwrite authMfa.ts?');
    // HS-8037 — title now picks the trailing `?` line (the literal
    // question) rather than joining the diff lines into a wall of text.
    expect(result.question).toBe('Do you want to overwrite authMfa.ts?');
  });

  // HS-8037 — production `--dangerously-load-development-channels` warning
  // shape. Pre-fix the title bar collapsed all eight question lines into a
  // single string ("WARNING: Loading development channels --dangerously-…
  // server:hotsheet-channel"), and that same content was repeated verbatim
  // in the framed `<pre>` context block right below — the user explicitly
  // flagged this as "redundantly shows … with a bunch of horizontal lines
  // before it" on HS-8037. Title now picks the heading; the body stays in
  // questionLines for the context block.
  it('uses the WARNING heading as the title for the dev-channels safety prompt (HS-8037)', () => {
    const rows = [
      '  WARNING: Loading development channels',
      '',
      '  --dangerously-load-development-channels is for local channel development',
      '  only. Do not use this option to run channels you have downloaded off the',
      '  internet.',
      '',
      '  Please use --channels to run a list of approved channels.',
      '',
      '  Channels: server:hotsheet-channel',
      '',
      '  ❯ 1. I am using this for local development',
      '    2. Exit',
      '',
      '  Enter to confirm · Esc to cancel',
    ];
    const result = claudeNumberedParser.match(rows);
    if (result?.shape !== 'numbered') throw new Error('expected numbered');
    expect(result.question).toBe('WARNING: Loading development channels');
    // questionLines still carries the full body so the overlay's framed
    // context block can reproduce the structure (paragraphs separated by
    // blank rows, channels-line at the end).
    expect(result.questionLines.some(l => l.includes('--dangerously-load-development-channels'))).toBe(true);
    expect(result.questionLines.some(l => l.includes('Channels: server:hotsheet-channel'))).toBe(true);
  });

  // HS-8037 — pure-decoration rows (e.g. Claude's TUI box-drawing borders
  // around a warning) must not be picked as the title. The title should
  // skip past them to the first row carrying real content.
  it('skips decorative box-drawing borders when picking the title (HS-8037)', () => {
    const rows = [
      '────────────────────────────────────────',
      'Choose your channel',
      '────────────────────────────────────────',
      '',
      '> 1. Local',
      '  2. Remote',
      '',
      'Enter to confirm · Esc to cancel',
    ];
    const result = claudeNumberedParser.match(rows);
    if (result?.shape !== 'numbered') throw new Error('expected numbered');
    expect(result.question).toBe('Choose your channel');
  });
});

// HS-8037 — direct unit tests for the helpers.
describe('isDecorativeLine (HS-8037)', () => {
  it('returns true for box-drawing horizontal rules', () => {
    expect(isDecorativeLine('────────────────────────')).toBe(true);
    expect(isDecorativeLine('━━━━━━━━━━')).toBe(true);
    expect(isDecorativeLine('═════════════════')).toBe(true);
  });

  it('returns true for ASCII horizontal rules', () => {
    expect(isDecorativeLine('--------')).toBe(true);
    expect(isDecorativeLine('========')).toBe(true);
    expect(isDecorativeLine('________')).toBe(true);
  });

  it('returns false for empty / whitespace-only lines (those carry paragraph structure)', () => {
    expect(isDecorativeLine('')).toBe(false);
    expect(isDecorativeLine('   ')).toBe(false);
  });

  it('returns false for lines containing real content', () => {
    expect(isDecorativeLine('WARNING: Loading channels')).toBe(false);
    expect(isDecorativeLine('--dangerously-load')).toBe(false); // `d` is not in the decoration set
    expect(isDecorativeLine('1. Yes')).toBe(false);
  });
});

describe('pickTitleLine (HS-8037)', () => {
  it('returns empty string for an empty list', () => {
    expect(pickTitleLine([])).toBe('');
  });

  it('returns empty string when every line is blank or decorative', () => {
    expect(pickTitleLine(['', '   ', '────'])).toBe('');
  });

  it('prefers the trailing `?` line over earlier headings (diff-shape prompts)', () => {
    const lines = [
      '@@ -1,3 +1,4 @@',
      '+  return true;',
      '',
      'Do you want to overwrite foo.ts?',
    ];
    expect(pickTitleLine(lines)).toBe('Do you want to overwrite foo.ts?');
  });

  it('falls back to the first non-decorative line when there is no `?` line', () => {
    const lines = [
      '────────',
      'WARNING: Loading channels',
      '',
      'long body paragraph',
    ];
    expect(pickTitleLine(lines)).toBe('WARNING: Loading channels');
  });

  it('ignores a single trailing `?` character (length-1 token, not a real question)', () => {
    const lines = ['Heading', '?'];
    expect(pickTitleLine(lines)).toBe('Heading');
  });

  it('picks the LATEST `?` line when several are present', () => {
    const lines = ['First?', 'Middle line', 'Last?'];
    expect(pickTitleLine(lines)).toBe('Last?');
  });
});

describe('claudeNumberedParser (HS-8050) — questionLines context capping', () => {
  // User flagged on HS-8050: popup body included a chunk of post-prompt
  // claude TUI decorations ("? for shortcuts", "high - /effort", the
  // "Listening for channel messages..." pre-amble, etc.) because the
  // upward walk pulled every row back to row 0. The fix caps at
  // MAX_QUESTION_CONTEXT_ROWS rows AND stops at any run of 2+
  // consecutive blank rows (visual section break).
  it('stops the upward walk at a run of 2+ blank rows (section break)', () => {
    const rows = [
      'old TUI line A',
      'old TUI line B',
      '',
      '',                            // 2 blanks → section break
      'Loading development channels can pose a security risk',
      '',
      '> 1. I am using this for local development',
      '  2. Exit',
      '',
      'Enter to confirm · Esc to cancel',
    ];
    const result = claudeNumberedParser.match(rows);
    if (result?.shape !== 'numbered') throw new Error('expected numbered');
    // questionLines should NOT contain the pre-section-break TUI lines.
    expect(result.questionLines.some(l => l.includes('old TUI line'))).toBe(false);
    // It SHOULD contain the actual question.
    expect(result.questionLines.some(l => l.includes('Loading development channels'))).toBe(true);
    // Title is the question, not the TUI noise.
    expect(result.question).toBe('Loading development channels can pose a security risk');
  });

  it('preserves single-blank diff structure inside the question region (HS-7980 still works)', () => {
    const rows = [
      '  -  const old = 1',
      '  +  const new = 2',
      '',                            // single blank — diff context separator
      'Apply this edit?',
      '',
      '> 1. Yes',
      '  2. No',
      '',
      'Enter to confirm · Esc to cancel',
    ];
    const result = claudeNumberedParser.match(rows);
    if (result?.shape !== 'numbered') throw new Error('expected numbered');
    // Diff rows + the single-blank separator + question line all preserved.
    expect(result.questionLines).toContain('  -  const old = 1');
    expect(result.questionLines).toContain('  +  const new = 2');
    expect(result.questionLines).toContain('Apply this edit?');
    expect(result.question).toBe('Apply this edit?');
  });

  it('caps the question region at MAX_QUESTION_CONTEXT_ROWS rows', () => {
    // Build 25 non-blank rows above the numbered block — no blank-run
    // section break to stop the walk early. The cap should still
    // truncate to ≤ 15 rows.
    const tuiNoise: string[] = [];
    for (let i = 0; i < 25; i++) tuiNoise.push(`noise line ${i}`);
    const rows = [
      ...tuiNoise,
      '> 1. A',
      '  2. B',
      '',
      'Enter to confirm · Esc to cancel',
    ];
    const result = claudeNumberedParser.match(rows);
    if (result?.shape !== 'numbered') throw new Error('expected numbered');
    expect(result.questionLines.length).toBeLessThanOrEqual(15);
    // Most-recent rows above the prompt are the ones we keep — earliest
    // noise lines should have been dropped.
    expect(result.questionLines.some(l => l === 'noise line 0')).toBe(false);
    expect(result.questionLines.some(l => l === 'noise line 24')).toBe(true);
  });

  it('the original dev-channels fixture still matches with the cap in place', () => {
    // Regression guard: the canonical fixture from the HS-7971 happy-path
    // test still produces the same choices and title after the HS-8050 cap.
    const rows = [
      'Loading development channels can pose a security risk',
      '',
      '> 1. I am using this for local development',
      '  2. Exit',
      '',
      'Enter to confirm · Esc to cancel',
    ];
    const result = claudeNumberedParser.match(rows);
    if (result?.shape !== 'numbered') throw new Error('expected numbered');
    expect(result.choices).toHaveLength(2);
    expect(result.choices[0].label).toBe('I am using this for local development');
    expect(result.choices[1].label).toBe('Exit');
    expect(result.question).toBe('Loading development channels can pose a security risk');
  });
});

describe('stripClaudeInputBox (HS-8071)', () => {
  it('removes the 3-line divider / ❯ <text> / divider pattern', () => {
    const rows = [
      'real content',
      '──────────────────────────────────',
      '❯ Try "how does markdown.ts work?"',
      '──────────────────────────────────',
      'more real content',
    ];
    expect(stripClaudeInputBox(rows)).toEqual([
      'real content',
      'more real content',
    ]);
  });

  it('strips when the inner line carries leading whitespace before ❯', () => {
    const rows = [
      '─────',
      '   ❯ placeholder text',
      '─────',
    ];
    expect(stripClaudeInputBox(rows)).toEqual([]);
  });

  it('handles back-to-back input boxes (idempotent re-scan)', () => {
    const rows = [
      '─────',
      '❯ a',
      '─────',
      '─────',
      '❯ b',
      '─────',
      'tail',
    ];
    expect(stripClaudeInputBox(rows)).toEqual(['tail']);
  });

  it('leaves a bare `❯ Foo` line alone when not flanked by dividers', () => {
    const rows = [
      'header',
      '❯ standalone arrow line',
      'footer',
    ];
    expect(stripClaudeInputBox(rows)).toEqual(rows);
  });

  it('leaves a divider/divider pair alone when no ❯ inside', () => {
    const rows = [
      '──────',
      'normal text',
      '──────',
    ];
    expect(stripClaudeInputBox(rows)).toEqual(rows);
  });

  it('leaves the row sequence alone when shorter than 3 rows', () => {
    expect(stripClaudeInputBox([])).toEqual([]);
    expect(stripClaudeInputBox(['─────'])).toEqual(['─────']);
    expect(stripClaudeInputBox(['─────', '❯ foo'])).toEqual(['─────', '❯ foo']);
  });

  it('does not strip when the dividers are real text rows that happen to look short', () => {
    // `Hello!` is not in the decorative char set, so `isDecorativeLine` is false.
    const rows = ['Hello!', '❯ choice', 'World!'];
    expect(stripClaudeInputBox(rows)).toEqual(rows);
  });

  it('is pure / does not mutate the input', () => {
    const rows = ['─────', '❯ x', '─────', 'tail'];
    const snapshot = [...rows];
    stripClaudeInputBox(rows);
    expect(rows).toEqual(snapshot);
  });
});

// HS-8071 (2026-05-04 follow-up) — strip Claude TUI status-bar lines from a
// row sequence so they don't bleed into the captured question region.
describe('stripClaudeStatusBar (HS-8071)', () => {
  it('strips the `(shift+tab to cycle)` mode-toggle hint', () => {
    const rows = [
      'real prompt body',
      '▶▶ accept edits on (shift+tab to cycle)',
      '> 1. Yes',
    ];
    expect(stripClaudeStatusBar(rows)).toEqual([
      'real prompt body',
      '> 1. Yes',
    ]);
  });

  it('strips bypass-permissions and no-edits variations of the cycle hint', () => {
    const rows = [
      '▶▶ bypass permissions on (shift+tab to cycle)',
      '▶▶ no edits made (shift+tab to cycle)',
      '· accept edits on (shift+tab to cycle)',
      'preserved line',
    ];
    expect(stripClaudeStatusBar(rows)).toEqual(['preserved line']);
  });

  it('strips the `● <mode> · /effort` indicator (high/medium/low/max)', () => {
    const rows = [
      'preserved',
      '● high · /effort',
      '● medium · /effort',
      '● low · /effort',
      '● max · /effort',
      'also preserved',
    ];
    expect(stripClaudeStatusBar(rows)).toEqual(['preserved', 'also preserved']);
  });

  it('handles the `•` bullet variant on the effort indicator', () => {
    const rows = ['• high • /effort', 'kept'];
    expect(stripClaudeStatusBar(rows)).toEqual(['kept']);
  });

  it('preserves blank rows verbatim (paragraph structure stays intact)', () => {
    const rows = [
      'top',
      '',
      '▶▶ accept edits on (shift+tab to cycle)',
      '',
      'bottom',
    ];
    expect(stripClaudeStatusBar(rows)).toEqual(['top', '', '', 'bottom']);
  });

  it('does NOT strip lines that mention "shift" or "effort" without the full status-bar shape', () => {
    const rows = [
      'shift the focus to the editor',
      '/effort is a slash command',
      'high quality output',
    ];
    expect(stripClaudeStatusBar(rows)).toEqual(rows);
  });

  it('is pure / does not mutate input', () => {
    const rows = ['▶▶ accept edits on (shift+tab to cycle)', 'kept'];
    const snapshot = [...rows];
    stripClaudeStatusBar(rows);
    expect(rows).toEqual(snapshot);
  });

  it('is idempotent', () => {
    const rows = ['▶▶ accept edits on (shift+tab to cycle)', '● high · /effort', 'kept'];
    expect(stripClaudeStatusBar(stripClaudeStatusBar(rows))).toEqual(['kept']);
  });
});

// HS-8071 (2026-05-04 follow-up) — end-to-end through claudeNumberedParser:
// the status-bar lines bleed into the captured rows for the dev-channels
// dialog. Pre-fix this contaminated `questionLines`, drifted the hash, and
// defeated the Tier 3 substring fallback. With `stripClaudeStatusBar`
// applied alongside `stripClaudeInputBox`, the captured question region is
// stable across the various Claude TUI status bar configurations.
describe('claudeNumberedParser (HS-8071 status-bar) — Claude status-bar stripped', () => {
  function buildDevChannelsBuffer(includeStatusBar: boolean, mode: 'high' | 'medium' = 'high'): string[] {
    const rows: string[] = [
      'Listening for channel messages from: server:hotsheet-channel',
      'Experimental: inbound messages will be pushed into this session, this carries prompt injection risks.',
      'Restart Claude Code without --dangerously-load-development-channels to disable.',
    ];
    if (includeStatusBar) {
      rows.push('▶▶ accept edits on (shift+tab to cycle)');
      rows.push(`● ${mode} · /effort`);
    }
    rows.push('');
    rows.push('> 1. I am using this for local development');
    rows.push('  2. Exit');
    rows.push('');
    rows.push('Enter to confirm · Esc to cancel');
    return rows;
  }

  it('produces the same question / hash whether the status bar is bleeding in or not', () => {
    const a = claudeNumberedParser.match(buildDevChannelsBuffer(false));
    const b = claudeNumberedParser.match(buildDevChannelsBuffer(true, 'high'));
    const c = claudeNumberedParser.match(buildDevChannelsBuffer(true, 'medium'));
    if (a?.shape !== 'numbered') throw new Error('a not numbered');
    if (b?.shape !== 'numbered') throw new Error('b not numbered');
    if (c?.shape !== 'numbered') throw new Error('c not numbered');
    expect(a.signature).toBe(b.signature);
    expect(b.signature).toBe(c.signature);
    expect(a.question).toBe(b.question);
  });

  it('removes the status-bar lines from questionLines', () => {
    const result = claudeNumberedParser.match(buildDevChannelsBuffer(true));
    if (result?.shape !== 'numbered') throw new Error('expected numbered');
    expect(result.questionLines.some(l => l.includes('shift+tab to cycle'))).toBe(false);
    expect(result.questionLines.some(l => l.includes('/effort'))).toBe(false);
  });

  it('preserves the experimental warning text so Tier 3 substring fallback still works', () => {
    const result = claudeNumberedParser.match(buildDevChannelsBuffer(true));
    if (result?.shape !== 'numbered') throw new Error('expected numbered');
    const blob = result.questionLines.join('\n');
    expect(blob.includes('Experimental: inbound messages')).toBe(true);
  });
});

// HS-8071 — full-stack regression: when Claude renders the dev-channels
// dialog with its TUI input box rendered ABOVE the modal, the placeholder
// text inside that input box (e.g. `Try "how does markdown.ts work?"`)
// varies per launch + per terminal width. Pre-fix that text bled into the
// captured `questionLines`, shifted the `question_hash` on every
// re-render, AND defeated the §52 Tier 3 question_preview substring
// fallback because the substring no longer appeared verbatim.
describe('claudeNumberedParser (HS-8071) — Claude input-box stripped from question region', () => {
  // Build the buffer shape the user reported in the 2026-05-04 screenshot:
  // some warning text at the top, the Claude input box framed by 2
  // horizontal-rule dividers, then the numbered choices and the footer.
  function buildBuffer(placeholder: string): string[] {
    return [
      'Listening for channel messages from: server:hotsheet-channel',
      'Experimental: inbound messages will be pushed into this session',
      '─────────────────────────────────────────────────',
      `❯ ${placeholder}`,
      '─────────────────────────────────────────────────',
      '',
      '> 1. I am using this for local development',
      '  2. Exit',
      '',
      'Enter to confirm · Esc to cancel',
    ];
  }

  it('produces the same question / hash regardless of the rotating placeholder text', () => {
    const a = claudeNumberedParser.match(buildBuffer('Try "how does markdown.ts work?"'));
    const b = claudeNumberedParser.match(buildBuffer('Try a question, or describe your task'));
    const c = claudeNumberedParser.match(buildBuffer('Ask Claude to do something'));
    if (a?.shape !== 'numbered') throw new Error('a not numbered');
    if (b?.shape !== 'numbered') throw new Error('b not numbered');
    if (c?.shape !== 'numbered') throw new Error('c not numbered');
    expect(a.question).toBe(b.question);
    expect(b.question).toBe(c.question);
    expect(a.signature).toBe(b.signature);
    expect(b.signature).toBe(c.signature);
  });

  it('removes the divider / ❯ / divider rows from questionLines', () => {
    const result = claudeNumberedParser.match(buildBuffer('Try foo'));
    if (result?.shape !== 'numbered') throw new Error('expected numbered');
    expect(result.questionLines.some(l => l.includes('❯'))).toBe(false);
    // The dividers around the input box are gone; any divider that
    // remained would only be one that wasn't part of the input box.
    const dividerCount = result.questionLines.filter(l => isDecorativeLine(l)).length;
    expect(dividerCount).toBe(0);
  });

  it('still preserves the warning text above the input box', () => {
    const result = claudeNumberedParser.match(buildBuffer('Try foo'));
    if (result?.shape !== 'numbered') throw new Error('expected numbered');
    expect(result.questionLines.some(l => l.includes('Listening for channel messages'))).toBe(true);
    expect(result.questionLines.some(l => l.includes('Experimental: inbound messages'))).toBe(true);
  });

  it('stripped popup body matches the same `question_preview` substring across renders', () => {
    // Tier 3 of `findMatchingAllowRule` does a normalised .includes() on
    // the question_preview against the questionLines blob. That should
    // succeed regardless of the input-box placeholder.
    const a = claudeNumberedParser.match(buildBuffer('one placeholder'));
    const b = claudeNumberedParser.match(buildBuffer('an entirely different placeholder'));
    if (a?.shape !== 'numbered') throw new Error('a not numbered');
    if (b?.shape !== 'numbered') throw new Error('b not numbered');
    const preview = 'Listening for channel messages';
    expect(a.questionLines.join('\n').includes(preview)).toBe(true);
    expect(b.questionLines.join('\n').includes(preview)).toBe(true);
  });
});

// HS-8210 Phase A (§58.3) — channel-name extraction from claude-numbered
// prompts. Pure parser test; no allow-rule or matcher coverage here (Phase B).
describe('claudeNumberedParser (HS-8210) — channel extraction', () => {
  it('captures the channel name from the production dev-channels prompt', () => {
    const rows = [
      '  WARNING: Loading development channels',
      '',
      '  --dangerously-load-development-channels is for local channel development',
      '  only.',
      '',
      '  Channels: server:hotsheet-channel',
      '',
      '  ❯ 1. I am using this for local development',
      '    2. Exit',
      '',
      '  Enter to confirm · Esc to cancel',
    ];
    const result = claudeNumberedParser.match(rows);
    if (result?.shape !== 'numbered') throw new Error('expected numbered');
    expect(result.channel).toBe('server:hotsheet-channel');
  });

  it('leaves channel undefined for a non-channel-bearing numbered prompt', () => {
    const rows = [
      'Pick one',
      '',
      '> 1. Foo',
      '  2. Bar',
      '',
      'Enter to confirm · Esc to cancel',
    ];
    const result = claudeNumberedParser.match(rows);
    if (result?.shape !== 'numbered') throw new Error('expected numbered');
    expect(result.channel).toBeUndefined();
  });

  it('does NOT capture a `Channels: foo` substring that appears mid-line (must be at line start)', () => {
    const rows = [
      'Some preamble mentioning Channels: server:wrong inline',
      '',
      '> 1. Yes',
      '  2. No',
      '',
      'Enter to confirm · Esc to cancel',
    ];
    const result = claudeNumberedParser.match(rows);
    if (result?.shape !== 'numbered') throw new Error('expected numbered');
    expect(result.channel).toBeUndefined();
  });

  it('captures cleanly when the channel line has trailing whitespace', () => {
    const rows = [
      'Loading development channels',
      '',
      'Channels: server:hotsheet-channel   ',
      '',
      '> 1. Yes',
      '  2. Exit',
      '',
      'Enter to confirm · Esc to cancel',
    ];
    const result = claudeNumberedParser.match(rows);
    if (result?.shape !== 'numbered') throw new Error('expected numbered');
    expect(result.channel).toBe('server:hotsheet-channel');
  });

  it('captures the verbatim `server:` prefix so distinct prefixes produce distinct values', () => {
    const rowsServer = [
      'Loading',
      '',
      'Channels: server:foo',
      '',
      '> 1. Yes',
      '  2. No',
      '',
      'Enter to confirm · Esc to cancel',
    ];
    const rowsClient = [
      'Loading',
      '',
      'Channels: client:foo',
      '',
      '> 1. Yes',
      '  2. No',
      '',
      'Enter to confirm · Esc to cancel',
    ];
    const a = claudeNumberedParser.match(rowsServer);
    const b = claudeNumberedParser.match(rowsClient);
    if (a?.shape !== 'numbered' || b?.shape !== 'numbered') throw new Error('expected numbered');
    expect(a.channel).toBe('server:foo');
    expect(b.channel).toBe('client:foo');
    expect(a.channel).not.toBe(b.channel);
  });

  it('yesno + generic shapes never carry a channel field (defensive shape test)', () => {
    const yesnoMatch = yesNoParser.match(['Channels: server:foo — proceed? [y/n]']);
    expect(yesnoMatch).not.toBeNull();
    // Defensive: the field doesn't exist on YesNoMatch at the type level,
    // but at runtime confirm there's no spurious property.
    expect((yesnoMatch as unknown as { channel?: string }).channel).toBeUndefined();

    const genericMatch = genericParser.match(['Channels: server:foo. What now?']);
    expect(genericMatch).not.toBeNull();
    expect((genericMatch as unknown as { channel?: string }).channel).toBeUndefined();
  });
});

describe('claudeNumberedParser (HS-7971) — negative cases', () => {
  it('returns null when the footer is missing', () => {
    const rows = [
      'Question',
      '> 1. A',
      '  2. B',
    ];
    expect(claudeNumberedParser.match(rows)).toBeNull();
  });

  it('returns null when only one numbered row matches (need ≥ 2 choices)', () => {
    const rows = [
      'Q',
      '> 1. Only',
      '',
      'Enter to confirm · Esc to cancel',
    ];
    expect(claudeNumberedParser.match(rows)).toBeNull();
  });

  it('returns null when digits skip (1, 3) — Claude always renders contiguous', () => {
    const rows = [
      'Q',
      '> 1. A',
      '  3. C',
      '',
      'Enter to confirm · Esc to cancel',
    ];
    expect(claudeNumberedParser.match(rows)).toBeNull();
  });

  it('returns null when digits start at 0 instead of 1', () => {
    const rows = [
      'Q',
      '> 0. A',
      '  1. B',
      '',
      'Enter to confirm · Esc to cancel',
    ];
    expect(claudeNumberedParser.match(rows)).toBeNull();
  });

  it('returns null on empty rows', () => {
    expect(claudeNumberedParser.match([])).toBeNull();
    expect(claudeNumberedParser.match([''])).toBeNull();
  });

  it('returns null when the footer text appears mid-buffer (must be trailing per §52.3.3)', () => {
    const rows = [
      'Earlier output mentioning Enter to confirm · Esc to cancel inline',
      '',
      'Different output now without a footer',
    ];
    expect(claudeNumberedParser.match(rows)).toBeNull();
  });

  it('rejects a Markdown-style numbered list inside docs', () => {
    const rows = [
      'Here are the steps:',
      '',
      '1. Run claude',
      '2. Confirm the warning',
      '',
      'And you should see output. Press space to scroll.',
    ];
    expect(claudeNumberedParser.match(rows)).toBeNull();
  });
});

describe('runParserRegistry (HS-7971)', () => {
  it('returns the claude-numbered match when shape matches', () => {
    const rows = [
      'Q',
      '> 1. A',
      '  2. B',
      '',
      'Enter to confirm · Esc to cancel',
    ];
    expect(runParserRegistry(rows)).not.toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(runParserRegistry(['plain output'])).toBeNull();
  });
});

describe('buildNumberedPayload (HS-7971)', () => {
  const choices = [
    { index: 0, label: 'A', highlighted: true },
    { index: 1, label: 'B', highlighted: false },
    { index: 2, label: 'C', highlighted: false },
  ];

  it('returns just Enter when chosen index equals highlighted', () => {
    expect(buildNumberedPayload(choices, 0)).toBe('\r');
  });

  it('navigates down N rows then Enter for forward delta', () => {
    expect(buildNumberedPayload(choices, 1)).toBe('\x1b[B\r');
    expect(buildNumberedPayload(choices, 2)).toBe('\x1b[B\x1b[B\r');
  });

  it('navigates up N rows then Enter for backward delta', () => {
    const fromMid = [
      { index: 0, label: 'A', highlighted: false },
      { index: 1, label: 'B', highlighted: true },
      { index: 2, label: 'C', highlighted: false },
    ];
    expect(buildNumberedPayload(fromMid, 0)).toBe('\x1b[A\r');
    expect(buildNumberedPayload(fromMid, 2)).toBe('\x1b[B\r');
  });

  it('falls back to index 0 when no option is highlighted', () => {
    const noHighlight = choices.map(c => ({ ...c, highlighted: false }));
    expect(buildNumberedPayload(noHighlight, 0)).toBe('\r');
    expect(buildNumberedPayload(noHighlight, 1)).toBe('\x1b[B\r');
  });
});

describe('buildNumberedCancelPayload (HS-7971)', () => {
  it('emits the Esc byte', () => {
    expect(buildNumberedCancelPayload()).toBe('\x1b');
  });
});

// ---------------------------------------------------------------------------
// HS-7986 Phase 2 — yesNoParser
// ---------------------------------------------------------------------------

describe('yesNoParser (HS-7986)', () => {
  it('matches lowercase [y/n]', () => {
    const m = yesNoParser.match(['Are you sure? [y/n]']);
    expect(m).not.toBeNull();
    expect(m!.shape).toBe('yesno');
    expect(m!.parserId).toBe('yesno');
    expect(m!.signature).toMatch(/^yesno:/);
    if (m!.shape === 'yesno') {
      expect(m!.yesIsCapital).toBe(false);
      expect(m!.noIsCapital).toBe(false);
    }
  });

  it('matches [Y/n] and surfaces the capital flag', () => {
    const m = yesNoParser.match(['Continue? [Y/n]']);
    expect(m).not.toBeNull();
    if (m!.shape === 'yesno') {
      expect(m!.yesIsCapital).toBe(true);
      expect(m!.noIsCapital).toBe(false);
    }
  });

  it('matches (y/N) parens variant', () => {
    const m = yesNoParser.match(['Delete this file? (y/N)']);
    expect(m).not.toBeNull();
    if (m!.shape === 'yesno') {
      expect(m!.yesIsCapital).toBe(false);
      expect(m!.noIsCapital).toBe(true);
    }
  });

  it('matches [yes/no] long-form', () => {
    const m = yesNoParser.match(['Overwrite? [yes/no]']);
    expect(m).not.toBeNull();
    expect(m!.shape).toBe('yesno');
  });

  it('matches a trailing colon variant', () => {
    const m = yesNoParser.match(['Proceed [y/n]:']);
    expect(m).not.toBeNull();
    if (m!.shape === 'yesno') {
      // Trailing : stripped from question summary.
      expect(m!.question).toBe('Proceed');
    }
  });

  it('only inspects the trailing visible non-empty line', () => {
    const m = yesNoParser.match([
      'some earlier output',
      'Continue? [y/n]',
      '',
    ]);
    expect(m).not.toBeNull();
  });

  it('returns null when no marker is present', () => {
    expect(yesNoParser.match(['just regular shell output'])).toBeNull();
  });

  it('rejects markdown list lines that contain a yes/no marker', () => {
    expect(yesNoParser.match(['- this option offers [y/n] support'])).toBeNull();
  });

  it('rejects shell comments starting with #', () => {
    expect(yesNoParser.match(['# example: prompt with [y/n]'])).toBeNull();
  });

  it('rejects numbered-list items', () => {
    expect(yesNoParser.match(['1. like this [y/n]'])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HS-7986 Phase 2 — genericParser
// ---------------------------------------------------------------------------

describe('genericParser (HS-7986)', () => {
  it('matches a trailing question mark on the last visible line', () => {
    const m = genericParser.match(['What is your name?']);
    expect(m).not.toBeNull();
    expect(m!.shape).toBe('generic');
    if (m!.shape === 'generic') {
      expect(m!.question).toBe('What is your name');
      expect(m!.rawText).toBe('What is your name?');
    }
  });

  it('matches a trailing `?:` cosmetic prompt suffix', () => {
    const m = genericParser.match(['Pick a colour ?:']);
    expect(m).not.toBeNull();
  });

  it('returns null when there is no trailing ?', () => {
    expect(genericParser.match(['just regular output'])).toBeNull();
  });

  it('rejects a trailing question mark inside a markdown comment line', () => {
    expect(genericParser.match(['> a quoted question?'])).toBeNull();
  });

  it('rejects a trailing question mark on a numbered-list line', () => {
    expect(genericParser.match(['1. is this a question?'])).toBeNull();
  });

  it('preserves the full visible context as rawText', () => {
    const rows = [
      'Database connection lost.',
      'Retry?',
    ];
    const m = genericParser.match(rows);
    expect(m).not.toBeNull();
    if (m!.shape === 'generic') {
      expect(m!.rawText.split('\n')).toEqual(rows);
    }
  });

  it('produces a parserId-prefixed signature', () => {
    const m = genericParser.match(['Why?']);
    expect(m!.signature).toMatch(/^generic:/);
  });
});

// ---------------------------------------------------------------------------
// HS-7986 Phase 2 — registry priority
// ---------------------------------------------------------------------------

describe('runParserRegistry priority (HS-7986)', () => {
  it('returns claude-numbered first when the prompt fits both shapes', () => {
    const rows = [
      'Continue [y/n]?',
      '',
      '> 1. Yes',
      '  2. No',
      '',
      'Enter to confirm · Esc to cancel',
    ];
    const m = runParserRegistry(rows);
    expect(m!.parserId).toBe('claude-numbered');
  });

  it('returns yesno when only yesno matches', () => {
    const m = runParserRegistry(['Wipe disk? [y/N]']);
    expect(m!.parserId).toBe('yesno');
  });

  it('returns generic only after the others fail', () => {
    const m = runParserRegistry(['What is your favourite colour?']);
    expect(m!.parserId).toBe('generic');
  });

  it('returns null when nothing matches', () => {
    expect(runParserRegistry(['plain shell output'])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HS-7986 Phase 2 — payload builders
// ---------------------------------------------------------------------------

describe('buildYesNoPayload (HS-7986)', () => {
  const fakeMatch = {
    parserId: 'yesno',
    shape: 'yesno' as const,
    question: 'Q',
    questionLines: ['Q [y/n]'],
    yesIsCapital: false,
    noIsCapital: false,
    signature: 'yesno:abc:0',
  };

  it('emits y\\r for yes', () => {
    expect(buildYesNoPayload(fakeMatch, 'yes')).toBe('y\r');
  });

  it('emits n\\r for no', () => {
    expect(buildYesNoPayload(fakeMatch, 'no')).toBe('n\r');
  });
});

describe('buildYesNoCancelPayload (HS-7986)', () => {
  it('emits Esc', () => {
    expect(buildYesNoCancelPayload()).toBe('\x1b');
  });
});

describe('buildGenericPayload (HS-7986)', () => {
  it('appends \\r to the user text', () => {
    expect(buildGenericPayload('hello')).toBe('hello\r');
  });

  it('handles empty input', () => {
    expect(buildGenericPayload('')).toBe('\r');
  });
});

describe('buildGenericCancelPayload (HS-7986)', () => {
  it('emits Esc', () => {
    expect(buildGenericCancelPayload()).toBe('\x1b');
  });
});
