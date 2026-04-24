import { describe, expect, it } from 'vitest';

import { combineResponses, parseFeedbackPrompt } from './feedbackParser.js';

describe('parseFeedbackPrompt (HS-6998)', () => {
  it('returns null on empty or whitespace input', () => {
    expect(parseFeedbackPrompt('')).toBeNull();
    expect(parseFeedbackPrompt('   \n  \n')).toBeNull();
  });

  it('returns null when there is no list', () => {
    expect(parseFeedbackPrompt('Just a single question? No list here.')).toBeNull();
  });

  it('returns null when the list has only one item (single-item is not multi-part)', () => {
    const prompt = 'Intro.\n\n- Only one\n\nOutro.';
    expect(parseFeedbackPrompt(prompt)).toBeNull();
  });

  it('splits an ordered list into parts with intro and outro', () => {
    const prompt = 'Some intro text.\n\n1. First question\n2. Second question\n3. Third\n\nClosing remarks.';
    const result = parseFeedbackPrompt(prompt);
    expect(result).not.toBeNull();
    expect(result!.parts).toHaveLength(3);
    expect(result!.parts[0].markdown).toContain('First question');
    expect(result!.parts[1].markdown).toContain('Second question');
    expect(result!.parts[2].markdown).toContain('Third');
    expect(result!.intro).toContain('Some intro text');
    expect(result!.outro).toContain('Closing remarks');
  });

  it('splits an unordered bullet list into parts', () => {
    const prompt = 'Questions:\n\n- How should X work?\n- Should we add Y?\n- What about Z?\n';
    const result = parseFeedbackPrompt(prompt);
    expect(result).not.toBeNull();
    expect(result!.parts).toHaveLength(3);
    expect(result!.parts[0].markdown).toContain('How should X work?');
    expect(result!.parts[2].markdown).toContain('What about Z?');
  });

  it('preserves nested markdown inside items (bold, code)', () => {
    const prompt = '1. **Scope**: should we do `foo` or `bar`?\n2. **Timing**: before or after _launch_?';
    const result = parseFeedbackPrompt(prompt);
    expect(result).not.toBeNull();
    // The item markdown should retain the inline formatting so the dialog
    // can render it via marked.
    expect(result!.parts[0].markdown).toContain('**Scope**');
    expect(result!.parts[0].markdown).toContain('`foo`');
    expect(result!.parts[1].markdown).toContain('_launch_');
  });

  it('builds a shortLabel from the first 60 plain-text chars', () => {
    const prompt = '1. This is a reasonably long question that should be truncated in the label attribute.\n2. Short one';
    const result = parseFeedbackPrompt(prompt);
    expect(result!.parts[0].shortLabel.length).toBeLessThanOrEqual(60);
    expect(result!.parts[0].shortLabel).toMatch(/^This is a reasonably long/);
  });

  it('handles multi-line list items (continuation lines)', () => {
    const prompt = '1. First question\n   with continuation on a new line\n2. Second';
    const result = parseFeedbackPrompt(prompt);
    expect(result).not.toBeNull();
    expect(result!.parts).toHaveLength(2);
    expect(result!.parts[0].markdown).toMatch(/First question/);
    expect(result!.parts[0].markdown).toMatch(/continuation/);
  });

  it('picks the FIRST qualifying list when the prompt has multiple lists', () => {
    const prompt = 'Intro.\n\n1. Q1\n2. Q2\n\nSome middle.\n\n- later\n- stuff\n';
    const result = parseFeedbackPrompt(prompt);
    expect(result).not.toBeNull();
    expect(result!.parts).toHaveLength(2);
    expect(result!.parts[0].markdown).toContain('Q1');
    // Trailing list folds into the outro.
    expect(result!.outro).toContain('later');
  });

  it('handles prompts with no intro (list starts at top)', () => {
    const prompt = '1. Alpha\n2. Beta\n';
    const result = parseFeedbackPrompt(prompt);
    expect(result!.intro).toBe('');
    expect(result!.parts).toHaveLength(2);
  });

  it('handles prompts with no outro (list ends at bottom)', () => {
    const prompt = 'Intro.\n\n1. Alpha\n2. Beta\n';
    const result = parseFeedbackPrompt(prompt);
    expect(result!.outro).toBe('');
  });
});

describe('combineResponses (HS-6998)', () => {
  it('formats ordered responses with "1." / "2." / ... markers', () => {
    const out = combineResponses(['First answer', 'Second answer'], true);
    expect(out).toBe('1. First answer\n\n2. Second answer');
  });

  it('formats unordered responses with "-" markers', () => {
    const out = combineResponses(['Yes', 'No'], false);
    expect(out).toBe('- Yes\n\n- No');
  });

  it('replaces empty responses with an italic "(no response)" placeholder', () => {
    const out = combineResponses(['Real answer', '', 'Another'], true);
    expect(out).toContain('2. *(no response)*');
    // Numbering stays aligned so the reader can map answers back to questions.
    expect(out).toContain('1. Real answer');
    expect(out).toContain('3. Another');
  });

  it('trims whitespace around responses but preserves internal structure', () => {
    const out = combineResponses(['   yes   \n\n  extra  ', 'no'], true);
    expect(out.startsWith('1. yes')).toBe(true);
    expect(out).toContain('2. no');
  });
});
