/**
 * HS-7987 Phase 3 — pure-helper tests for terminal-prompt allow rules.
 */
import { describe, expect, it } from 'vitest';

import {
  buildAllowRule,
  findMatchingAllowRule,
  parseAllowRules,
  type TerminalPromptAllowRule,
} from './allowRules.js';
import type { GenericMatch, MatchResult, NumberedMatch, YesNoMatch } from './parsers.js';

const numberedMatch: NumberedMatch = {
  parserId: 'claude-numbered',
  shape: 'numbered',
  question: 'Loading development channels can pose a security risk',
  questionLines: ['Loading development channels can pose a security risk'],
  choices: [
    { index: 0, label: 'I am using this for local development', highlighted: true },
    { index: 1, label: 'Exit', highlighted: false },
  ],
  signature: 'claude-numbered:abcd1234:0',
};

const yesNoMatch: YesNoMatch = {
  parserId: 'yesno',
  shape: 'yesno',
  question: 'Continue',
  questionLines: ['Continue [y/n]'],
  yesIsCapital: false,
  noIsCapital: false,
  signature: 'yesno:11112222:0',
};

const genericMatch: GenericMatch = {
  parserId: 'generic',
  shape: 'generic',
  question: 'What is your name',
  questionLines: ['What is your name?'],
  rawText: 'What is your name?',
  signature: 'generic:33334444:0',
};

describe('parseAllowRules (HS-7987)', () => {
  it('returns [] for non-array inputs', () => {
    expect(parseAllowRules(undefined)).toEqual([]);
    expect(parseAllowRules(null)).toEqual([]);
    expect(parseAllowRules('not an array')).toEqual([]);
    expect(parseAllowRules(42)).toEqual([]);
  });

  it('parses a stringified-JSON form (legacy compat)', () => {
    const jsonStr = JSON.stringify([{
      id: 'r1',
      parser_id: 'claude-numbered',
      question_hash: 'abc',
      choice_index: 0,
      created_at: '2026-04-28T00:00:00Z',
    }]);
    expect(parseAllowRules(jsonStr)).toHaveLength(1);
  });

  it('drops rules missing required fields', () => {
    const arr = [
      { /* missing everything */ },
      { id: 'r1' /* missing parser_id */ },
      { id: 'r1', parser_id: 'claude-numbered' /* missing hash */ },
      { id: 'r1', parser_id: 'claude-numbered', question_hash: 'abc' /* missing choice_index */ },
      { id: 'r1', parser_id: 'claude-numbered', question_hash: 'abc', choice_index: 0 }, // valid
    ];
    expect(parseAllowRules(arr)).toHaveLength(1);
  });

  it('preserves optional question_preview + choice_label', () => {
    const arr = [{
      id: 'r1',
      parser_id: 'claude-numbered',
      question_hash: 'abc',
      choice_index: 0,
      created_at: '',
      question_preview: 'Loading dev channels',
      choice_label: 'I am using this for local development',
    }];
    const rules = parseAllowRules(arr);
    expect(rules[0].question_preview).toBe('Loading dev channels');
    expect(rules[0].choice_label).toBe('I am using this for local development');
  });

  it('drops rules with non-finite choice_index', () => {
    const arr = [{
      id: 'r1',
      parser_id: 'claude-numbered',
      question_hash: 'abc',
      choice_index: NaN,
      created_at: '',
    }];
    expect(parseAllowRules(arr)).toEqual([]);
  });
});

describe('findMatchingAllowRule (HS-7987)', () => {
  function rule(parserId: string, hash: string, choiceIndex = 0): TerminalPromptAllowRule {
    return {
      id: `r-${parserId}-${hash}`,
      parser_id: parserId,
      question_hash: hash,
      choice_index: choiceIndex,
      created_at: '',
    };
  }

  it('returns null for generic-shape matches', () => {
    const rules = [rule('generic', '33334444')];
    expect(findMatchingAllowRule(genericMatch, rules)).toBeNull();
  });

  it('returns null when no rule matches the parser_id', () => {
    expect(findMatchingAllowRule(numberedMatch, [rule('yesno', 'abcd1234')])).toBeNull();
  });

  it('returns null when no rule matches the question_hash', () => {
    expect(findMatchingAllowRule(numberedMatch, [rule('claude-numbered', 'deadbeef')])).toBeNull();
  });

  it('returns the matching rule for an exact (parser_id, hash) pair on numbered match', () => {
    const r = rule('claude-numbered', 'abcd1234', 1);
    expect(findMatchingAllowRule(numberedMatch, [r])).toBe(r);
  });

  it('returns the matching rule for a yesno match', () => {
    const r = rule('yesno', '11112222', 0);
    expect(findMatchingAllowRule(yesNoMatch, [r])).toBe(r);
  });

  it('returns the FIRST matching rule when multiple exist', () => {
    const r1 = rule('claude-numbered', 'abcd1234', 0);
    const r2 = rule('claude-numbered', 'abcd1234', 1);
    expect(findMatchingAllowRule(numberedMatch, [r1, r2])).toBe(r1);
  });

  it('returns null for empty rules list', () => {
    expect(findMatchingAllowRule(numberedMatch, [])).toBeNull();
  });
});

describe('buildAllowRule (HS-7987)', () => {
  it('builds a rule with stable shape from a numbered match', () => {
    const r = buildAllowRule(numberedMatch, 1, 'Exit');
    expect(r.parser_id).toBe('claude-numbered');
    expect(r.question_hash).toBe('abcd1234');
    expect(r.choice_index).toBe(1);
    expect(r.choice_label).toBe('Exit');
    expect(r.question_preview).toBe(numberedMatch.question);
    expect(r.id).toMatch(/^tp_/);
    expect(r.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('builds a rule from a yesno match', () => {
    const r = buildAllowRule(yesNoMatch, 0, 'Yes');
    expect(r.parser_id).toBe('yesno');
    expect(r.choice_index).toBe(0);
    expect(r.choice_label).toBe('Yes');
  });

  it('throws when called with a generic match', () => {
    expect(() => buildAllowRule(genericMatch, 0, 'whatever')).toThrow();
  });

  it('truncates long question text into question_preview', () => {
    const longMatch: MatchResult = {
      ...numberedMatch,
      question: 'x'.repeat(200),
    };
    const r = buildAllowRule(longMatch, 0, 'A');
    expect(r.question_preview!.length).toBe(120);
  });
});
