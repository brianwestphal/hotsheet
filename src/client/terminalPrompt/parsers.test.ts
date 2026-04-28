/**
 * HS-7971 Phase 1 — pure-helper tests for the terminal prompt parser
 * registry. Exercises the Claude-Ink numbered-choice parser against the
 * concrete shape from the user's screenshot (the dev-channels safety
 * prompt) plus a battery of negative cases that should NOT match.
 */
import { describe, expect, it } from 'vitest';

import {
  buildNumberedCancelPayload,
  buildNumberedPayload,
  claudeNumberedParser,
  hashQuestion,
  isClaudeNumberedFooter,
  runParserRegistry,
  trimRows,
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

  it('preserves multi-line question text by joining with spaces', () => {
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
    expect(result.question).toBe('Loading development channels can pose a security risk');
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
    // Single-line summary collapses to one string.
    expect(result.question).toContain('Do you want to overwrite authMfa.ts?');
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
