/**
 * HS-7987 Phase 3 — pure-helper tests for terminal-prompt allow rules.
 */
import { describe, expect, it } from 'vitest';

import {
  buildAllowRule,
  buildChannelAllowRule,
  buildChoiceShape,
  findMatchingAllowRule,
  parseAllowRules,
  payloadForAutoAllow,
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

  // HS-8061 — duplicate `(parser_id, question_hash, choice_index)` triples
  // collapse to the first occurrence so historical bloat (multiple
  // "Always allow" clicks on the same prompt before the dedupe gate
  // landed) reads back as a single rule.
  it('collapses duplicate (parser_id, question_hash, choice_index) entries to the first occurrence (HS-8061)', () => {
    const arr = [
      { id: 'r-first',  parser_id: 'claude-numbered', question_hash: 'h1', choice_index: 0, created_at: '2026-04-01T00:00:00Z', question_preview: 'first' },
      { id: 'r-dup-1',  parser_id: 'claude-numbered', question_hash: 'h1', choice_index: 0, created_at: '2026-04-02T00:00:00Z', question_preview: 'dup' },
      { id: 'r-dup-2',  parser_id: 'claude-numbered', question_hash: 'h1', choice_index: 0, created_at: '2026-04-03T00:00:00Z' },
      { id: 'r-other',  parser_id: 'yesno',           question_hash: 'h1', choice_index: 0, created_at: '' }, // different parser → kept
      { id: 'r-other2', parser_id: 'claude-numbered', question_hash: 'h2', choice_index: 0, created_at: '' }, // different hash → kept
      { id: 'r-other3', parser_id: 'claude-numbered', question_hash: 'h1', choice_index: 1, created_at: '' }, // different choice → kept
    ];
    const out = parseAllowRules(arr);
    expect(out.map(r => r.id)).toEqual(['r-first', 'r-other', 'r-other2', 'r-other3']);
    // The kept rule's optional metadata (question_preview) is the
    // original's, NOT a later duplicate's — pinning the first-wins rule.
    expect(out[0].question_preview).toBe('first');
  });

  it('does not dedupe when only the rule id differs (id is not part of the match key)', () => {
    // Same `(parser_id, question_hash, choice_index)` → still a dup.
    // The rule id field is local-only metadata so it should not affect
    // dedupe.
    const arr = [
      { id: 'r-A', parser_id: 'yesno', question_hash: 'h', choice_index: 0, created_at: '' },
      { id: 'r-B', parser_id: 'yesno', question_hash: 'h', choice_index: 0, created_at: '' },
    ];
    expect(parseAllowRules(arr)).toHaveLength(1);
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

  // HS-8071 — drift-resistant fallback. When Claude TUI status-bar lines
  // bleed into the captured question region, the `question_hash` shifts
  // (sometimes — about 50% of launches per the user's report). The
  // rule's `choice_shape` field stays stable and lets us recognise the
  // prompt anyway.
  describe('choice_shape fallback (HS-8071)', () => {
    function ruleWithShape(parserId: string, hash: string, shape: string, choiceIndex = 0): TerminalPromptAllowRule {
      return {
        id: `r-${parserId}-${hash}`,
        parser_id: parserId,
        question_hash: hash,
        choice_index: choiceIndex,
        choice_shape: shape,
        created_at: '',
      };
    }

    it('matches on choice_shape when the question_hash drifted', () => {
      const expectedShape = buildChoiceShape(numberedMatch);
      const r = ruleWithShape('claude-numbered', 'DRIFTED-HASH-99999999', expectedShape);
      expect(findMatchingAllowRule(numberedMatch, [r])).toBe(r);
    });

    it('does NOT match on choice_shape when the parser_id differs', () => {
      const expectedShape = buildChoiceShape(numberedMatch);
      const r = ruleWithShape('yesno', 'whatever', expectedShape);
      expect(findMatchingAllowRule(numberedMatch, [r])).toBeNull();
    });

    it('does NOT match on choice_shape when the rule shape differs', () => {
      const r = ruleWithShape('claude-numbered', 'whatever', 'different shape|here');
      expect(findMatchingAllowRule(numberedMatch, [r])).toBeNull();
    });

    it('skips the fallback when the rule has no choice_shape (back-compat with pre-HS-8071 rules)', () => {
      const r: TerminalPromptAllowRule = {
        id: 'old',
        parser_id: 'claude-numbered',
        question_hash: 'DRIFTED-HASH-99999999',
        choice_index: 0,
        created_at: '',
        // no choice_shape — older rule shape.
      };
      expect(findMatchingAllowRule(numberedMatch, [r])).toBeNull();
    });

    it('prefers the question_hash exact match when both tiers would match', () => {
      // Tier 1 should win — the per-choice rule with the right hash is
      // returned even when an alternate rule with the same shape also
      // exists later in the list.
      const expectedShape = buildChoiceShape(numberedMatch);
      const tier1 = ruleWithShape('claude-numbered', 'abcd1234', 'wrong shape', 0);
      const tier2 = ruleWithShape('claude-numbered', 'DRIFTED-HASH', expectedShape, 1);
      expect(findMatchingAllowRule(numberedMatch, [tier1, tier2])).toBe(tier1);
    });
  });

  // HS-8071 (post-feedback) — Tier 3 back-compat: legacy rules without
  // `choice_shape` (created before the choice_shape work) STILL need to
  // auto-allow when their `question_preview` substring appears anywhere
  // in the live capture's `questionLines`. Without this, every existing
  // rule in the user's settings.json silently stopped matching whenever
  // Claude TUI status-bar lines pushed `pickTitleLine` to a different
  // headline — the user reported the popup was still leaking through on
  // ~50% of app launches even after the choice_shape fix shipped.
  describe('Tier 3 — back-compat preview-substring fallback', () => {
    function legacyRule(parserId: string, preview: string, choiceIndex = 0): TerminalPromptAllowRule {
      return {
        id: 'legacy',
        parser_id: parserId,
        question_hash: 'legacy-hash-that-wont-match',
        question_preview: preview,
        choice_index: choiceIndex,
        created_at: '2026-04-01T00:00:00Z',
        // intentionally NO choice_shape — pre-fix rule
      };
    }

    function numberedMatchWithBleed(): NumberedMatch {
      // Simulates the dev-channels prompt with Claude TUI status-bar lines
      // bleeding into the captured question region — the exact scenario
      // the user reported.
      return {
        parserId: 'claude-numbered',
        shape: 'numbered',
        question: '▶▶ accept edits on (shift+tab to cycle)', // pickTitleLine drift
        questionLines: [
          'WARNING: Loading development channels',
          'Experimental — inbound messages will be pushed into this session.',
          '',
          '▶▶ accept edits on (shift+tab to cycle)',
          '• high · /effort',
        ],
        choices: [
          { index: 0, label: 'I am using this for local development', highlighted: true },
          { index: 1, label: 'Exit', highlighted: false },
        ],
        signature: 'claude-numbered:LIVE-DRIFTED-HASH:0',
      };
    }

    it('matches a legacy rule whose question_preview appears as a substring in the live capture', () => {
      const rule = legacyRule('claude-numbered', 'WARNING: Loading development channels');
      const m = numberedMatchWithBleed();
      expect(findMatchingAllowRule(m, [rule])).toBe(rule);
    });

    it('normalises whitespace so multi-line previews still match', () => {
      // Preview was recorded across multiple lines (it shouldn't be — but
      // some captures collapse newlines differently across renders).
      const rule = legacyRule('claude-numbered', 'WARNING: Loading\ndevelopment   channels');
      const m = numberedMatchWithBleed();
      expect(findMatchingAllowRule(m, [rule])).toBe(rule);
    });

    it('does NOT match when the parser_id differs', () => {
      const rule = legacyRule('yesno', 'WARNING: Loading development channels');
      expect(findMatchingAllowRule(numberedMatchWithBleed(), [rule])).toBeNull();
    });

    it('does NOT match when the preview is too short to be unique', () => {
      // 14 chars (< MIN_PREVIEW_MATCH_CHARS = 15) → skipped.
      const rule = legacyRule('claude-numbered', 'Loading dev ch');
      expect(findMatchingAllowRule(numberedMatchWithBleed(), [rule])).toBeNull();
    });

    it('does NOT match when the preview is missing entirely (rule predates HS-7988)', () => {
      const rule: TerminalPromptAllowRule = {
        id: 'older',
        parser_id: 'claude-numbered',
        question_hash: 'no-match-hash',
        choice_index: 0,
        created_at: '',
        // no question_preview AND no choice_shape — earliest rule shape
      };
      expect(findMatchingAllowRule(numberedMatchWithBleed(), [rule])).toBeNull();
    });

    it('does NOT match when the rule has a choice_shape (Tier 3 only fires for legacy rules)', () => {
      // A modern rule with choice_shape that DOESN'T match the live shape
      // shouldn't fall through to Tier 3 — it's expected to either match
      // via Tier 2 or not at all.
      const rule: TerminalPromptAllowRule = {
        id: 'modern',
        parser_id: 'claude-numbered',
        question_hash: 'wont-match',
        question_preview: 'WARNING: Loading development channels',
        choice_index: 0,
        choice_shape: 'something-else|other-thing',
        created_at: '2026-05-01T00:00:00Z',
      };
      expect(findMatchingAllowRule(numberedMatchWithBleed(), [rule])).toBeNull();
    });

    it('rejects an out-of-range choice_index for the current numbered shape', () => {
      // Rule was recorded against a 3-option prompt (choice_index = 2);
      // current prompt has only 2 options → reject so the auto-response
      // doesn't pick a non-existent choice.
      const rule = legacyRule('claude-numbered', 'WARNING: Loading development channels', 2);
      expect(findMatchingAllowRule(numberedMatchWithBleed(), [rule])).toBeNull();
    });

    it('Tier 3 is preferred over no match — Tier 1+2 still take precedence when applicable', () => {
      const rule3 = legacyRule('claude-numbered', 'WARNING: Loading development channels');
      const rule1: TerminalPromptAllowRule = {
        id: 'tier1',
        parser_id: 'claude-numbered',
        question_hash: 'LIVE-DRIFTED-HASH', // primary hash match
        question_preview: 'something else',
        choice_index: 1,
        created_at: '2026-05-03T00:00:00Z',
      };
      // Tier 1 wins even when Tier 3 would also match.
      expect(findMatchingAllowRule(numberedMatchWithBleed(), [rule3, rule1])).toBe(rule1);
    });

    it('matches yesno legacy rules via preview substring too', () => {
      const yesNoBleed: YesNoMatch = {
        parserId: 'yesno',
        shape: 'yesno',
        question: 'Confirm',
        questionLines: [
          'About to delete 42 files in /important/data',
          'Confirm? [y/n]',
        ],
        yesIsCapital: false,
        noIsCapital: false,
        signature: 'yesno:DRIFTED:0',
      };
      const rule = legacyRule('yesno', 'About to delete 42 files in /important/data');
      expect(findMatchingAllowRule(yesNoBleed, [rule])).toBe(rule);
    });
  });

  // HS-8071 (2026-05-04 follow-up) — Tier 4 long-choice-label fallback. The
  // user-reported settings.json had a single rule from 2026-05-01 whose
  // `question_preview = "WARNING: Loading development channels"` no longer
  // appears in the live capture (Claude updated the prompt text to
  // "Experimental: inbound messages will be pushed into this session"),
  // so Tier 3 substring match also failed. The popup leaked through
  // every launch and the user (rightly) refused to manually re-tick. The
  // saved `choice_label = "I am using this for local development"` IS still
  // in the live choices, and is long enough (37 chars) to be uniquely
  // identifying — so we match on (parser_id + label-equality at index +
  // length floor).
  describe('Tier 4 — long-choice-label fallback', () => {
    function legacyRuleWithLabel(label: string, choiceIndex = 0): TerminalPromptAllowRule {
      return {
        id: 'legacy-label',
        parser_id: 'claude-numbered',
        question_hash: 'wont-match',
        question_preview: 'totally-different-text-than-the-current-prompt',
        choice_index: choiceIndex,
        choice_label: label,
        created_at: '2026-05-01T00:00:00Z',
      };
    }

    function liveMatchWithChoices(choices: { index: number; label: string; highlighted: boolean }[]): NumberedMatch {
      return {
        parserId: 'claude-numbered',
        shape: 'numbered',
        question: 'A new prompt the user has not seen before',
        questionLines: ['A new prompt the user has not seen before'],
        choices,
        signature: 'claude-numbered:NEW-HASH:0',
      };
    }

    it('matches when the rule choice_label exactly equals the live choices[index].label and is long enough', () => {
      const rule = legacyRuleWithLabel('I am using this for local development', 0);
      const m = liveMatchWithChoices([
        { index: 0, label: 'I am using this for local development', highlighted: true },
        { index: 1, label: 'Exit', highlighted: false },
      ]);
      expect(findMatchingAllowRule(m, [rule])).toBe(rule);
    });

    it('does NOT match when the label is too short (uniqueness floor)', () => {
      // 19 chars — under MIN_CHOICE_LABEL_MATCH_CHARS = 20.
      const rule = legacyRuleWithLabel('Yes, allow all edit', 0);
      const m = liveMatchWithChoices([
        { index: 0, label: 'Yes, allow all edit', highlighted: true },
        { index: 1, label: 'Exit', highlighted: false },
      ]);
      expect(findMatchingAllowRule(m, [rule])).toBeNull();
    });

    it('does NOT match when the live label at that index differs (different prompt with same shape)', () => {
      const rule = legacyRuleWithLabel('I am using this for local development', 0);
      const m = liveMatchWithChoices([
        { index: 0, label: 'Some entirely different long option label', highlighted: true },
        { index: 1, label: 'Exit', highlighted: false },
      ]);
      expect(findMatchingAllowRule(m, [rule])).toBeNull();
    });

    it('does NOT match when choice_index is out of range', () => {
      const rule = legacyRuleWithLabel('I am using this for local development', 5);
      const m = liveMatchWithChoices([
        { index: 0, label: 'I am using this for local development', highlighted: true },
        { index: 1, label: 'Exit', highlighted: false },
      ]);
      expect(findMatchingAllowRule(m, [rule])).toBeNull();
    });

    it('does NOT match when the rule has a choice_shape (Tier 4 only fires for legacy rules)', () => {
      const rule: TerminalPromptAllowRule = {
        id: 'modern',
        parser_id: 'claude-numbered',
        question_hash: 'wont-match',
        question_preview: 'old preview',
        choice_index: 0,
        choice_label: 'I am using this for local development',
        choice_shape: 'something-else|other-thing',
        created_at: '2026-05-04T00:00:00Z',
      };
      const m = liveMatchWithChoices([
        { index: 0, label: 'I am using this for local development', highlighted: true },
        { index: 1, label: 'Exit', highlighted: false },
      ]);
      expect(findMatchingAllowRule(m, [rule])).toBeNull();
    });

    it('does NOT match yesno shape (Tier 4 is numbered-only — yesno labels are inherently short)', () => {
      const rule: TerminalPromptAllowRule = {
        id: 'legacy-yesno',
        parser_id: 'yesno',
        question_hash: 'wont-match',
        choice_index: 0,
        choice_label: 'Yes, this is a long yesno label',
        created_at: '2026-05-01T00:00:00Z',
      };
      const m: YesNoMatch = {
        parserId: 'yesno',
        shape: 'yesno',
        question: 'Continue',
        questionLines: ['Continue? [y/n]'],
        yesIsCapital: false,
        noIsCapital: false,
        signature: 'yesno:NEW:0',
      };
      expect(findMatchingAllowRule(m, [rule])).toBeNull();
    });

    it('Tier 1 still wins when both Tier 1 and Tier 4 would match', () => {
      const tier4Rule = legacyRuleWithLabel('I am using this for local development', 0);
      const tier1Rule: TerminalPromptAllowRule = {
        id: 'tier1',
        parser_id: 'claude-numbered',
        question_hash: 'NEW-HASH', // primary hash match against the live signature
        choice_index: 1,
        created_at: '2026-05-04T00:00:00Z',
      };
      const m = liveMatchWithChoices([
        { index: 0, label: 'I am using this for local development', highlighted: true },
        { index: 1, label: 'Exit', highlighted: false },
      ]);
      expect(findMatchingAllowRule(m, [tier4Rule, tier1Rule])).toBe(tier1Rule);
    });

    it('Tier 3 still wins when both Tier 3 and Tier 4 would match', () => {
      const tier4Rule = legacyRuleWithLabel('I am using this for local development', 0);
      const tier3Rule: TerminalPromptAllowRule = {
        id: 'tier3',
        parser_id: 'claude-numbered',
        question_hash: 'wont-match',
        question_preview: 'A new prompt the user has not seen', // substring of live questionLines
        choice_index: 1,
        created_at: '2026-05-04T00:00:00Z',
      };
      const m = liveMatchWithChoices([
        { index: 0, label: 'I am using this for local development', highlighted: true },
        { index: 1, label: 'Exit', highlighted: false },
      ]);
      expect(findMatchingAllowRule(m, [tier4Rule, tier3Rule])).toBe(tier3Rule);
    });

    it('does NOT match when choice_label is missing entirely (rule predates HS-7988)', () => {
      const rule: TerminalPromptAllowRule = {
        id: 'legacy-no-label',
        parser_id: 'claude-numbered',
        question_hash: 'wont-match',
        choice_index: 0,
        created_at: '',
      };
      const m = liveMatchWithChoices([
        { index: 0, label: 'I am using this for local development', highlighted: true },
        { index: 1, label: 'Exit', highlighted: false },
      ]);
      expect(findMatchingAllowRule(m, [rule])).toBeNull();
    });
  });
});

describe('buildChoiceShape (HS-8071)', () => {
  it('joins numbered choice labels lowercase + pipe-separated', () => {
    expect(buildChoiceShape(numberedMatch)).toBe('i am using this for local development|exit');
  });

  it('returns the literal "yes|no" for yesno shape regardless of capitalisation', () => {
    expect(buildChoiceShape(yesNoMatch)).toBe('yes|no');
  });

  it('returns empty string for the generic shape (never allow-listable)', () => {
    expect(buildChoiceShape(genericMatch)).toBe('');
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

  // HS-8071 — new rules carry a `choice_shape` fingerprint so the
  // findMatchingAllowRule fallback can pick them up under question_hash
  // drift.
  it('records the drift-resistant choice_shape fingerprint on numbered rules', () => {
    const r = buildAllowRule(numberedMatch, 0, 'I am using this for local development');
    expect(r.choice_shape).toBe('i am using this for local development|exit');
  });

  it('records "yes|no" on yesno rules', () => {
    const r = buildAllowRule(yesNoMatch, 0, 'Yes');
    expect(r.choice_shape).toBe('yes|no');
  });
});

// HS-8034 Phase 2 — `payloadForAutoAllow` was moved from
// `src/client/terminalPrompt/autoAllow.ts` so the server-side scanner gate
// in `registry.ts` can call it. Behaviour is identical to the prior
// client-only implementation; tests pin the same edge cases the client
// path already relied on.
describe('payloadForAutoAllow (HS-8034)', () => {
  const baseRule: TerminalPromptAllowRule = {
    id: 'tp_xxx',
    parser_id: 'claude-numbered',
    question_hash: 'abcd1234',
    choice_index: 0,
    choice_label: 'I am using this for local development',
    created_at: '2026-04-30T07:00:00Z',
  };

  it('builds a numbered payload at the rule choice', () => {
    const payload = payloadForAutoAllow(numberedMatch, baseRule);
    expect(payload).toBe('\r');
  });

  it('builds a yesno payload — yes when choice_index === 0', () => {
    const yesRule: TerminalPromptAllowRule = { ...baseRule, parser_id: 'yesno', choice_index: 0 };
    const payload = payloadForAutoAllow(yesNoMatch, yesRule);
    expect(payload).toBe('y\r');
  });

  it('builds a yesno payload — no when choice_index === 1', () => {
    const noRule: TerminalPromptAllowRule = { ...baseRule, parser_id: 'yesno', choice_index: 1 };
    const payload = payloadForAutoAllow(yesNoMatch, noRule);
    expect(payload).toBe('n\r');
  });

  it('returns null for a generic match', () => {
    expect(payloadForAutoAllow(genericMatch, baseRule)).toBe(null);
  });

  it('returns null when the rule choice_index is out of range (live prompt has fewer choices)', () => {
    const overflowRule: TerminalPromptAllowRule = { ...baseRule, choice_index: 99 };
    expect(payloadForAutoAllow(numberedMatch, overflowRule)).toBe(null);
  });

  it('returns null when the rule choice_index is negative', () => {
    const negativeRule: TerminalPromptAllowRule = { ...baseRule, choice_index: -1 };
    expect(payloadForAutoAllow(numberedMatch, negativeRule)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// HS-8210 Phase B (§58.4) — channel-keyed allow rules + Tier 0 matcher.
// ---------------------------------------------------------------------------

describe('HS-8210 Phase B — channel-keyed allow rules', () => {
  const channelMatch: NumberedMatch = {
    parserId: 'claude-numbered',
    shape: 'numbered',
    question: 'Loading development channels can pose a security risk',
    questionLines: [
      'Loading development channels',
      '',
      'Channels: server:hotsheet-channel',
    ],
    choices: [
      { index: 0, label: 'I am using this for local development', highlighted: true },
      { index: 1, label: 'Exit', highlighted: false },
    ],
    signature: 'claude-numbered:abcd1234:0',
    channel: 'server:hotsheet-channel',
  };

  const otherChannelMatch: NumberedMatch = {
    ...channelMatch,
    questionLines: ['Channels: server:other-channel'],
    channel: 'server:other-channel',
  };

  const channelRule: TerminalPromptAllowRule = {
    id: 'tp_channel_1',
    parser_id: 'claude-numbered',
    question_hash: '',
    question_preview: 'Loading development channels can pose a security risk',
    choice_index: 0,
    choice_label: 'I am using this for local development',
    match_channel: 'server:hotsheet-channel',
    created_at: '2026-05-06T00:00:00Z',
  };

  describe('Tier 0 — channel-keyed lookup', () => {
    it('hits when the rule match_channel equals match.channel', () => {
      const result = findMatchingAllowRule(channelMatch, [channelRule]);
      expect(result).toBe(channelRule);
    });

    it('misses when the channel name differs and falls through to Tier 1+', () => {
      const otherRule: TerminalPromptAllowRule = {
        id: 'tp_other',
        parser_id: 'claude-numbered',
        question_hash: 'abcd1234',
        choice_index: 0,
        created_at: '2026-05-06T00:00:00Z',
      };
      const result = findMatchingAllowRule(otherChannelMatch, [channelRule, otherRule]);
      // Channel rule misses (different channel); falls through to Tier 1
      // hash match on the legacy hash-keyed rule.
      expect(result).toBe(otherRule);
    });

    it('Tier 0 wins when both a channel rule and a hash rule could match', () => {
      const hashRule: TerminalPromptAllowRule = {
        id: 'tp_hash',
        parser_id: 'claude-numbered',
        question_hash: 'abcd1234',
        choice_index: 1,
        created_at: '2026-05-06T00:00:00Z',
      };
      // List the hash rule first so insertion order doesn't accidentally
      // dictate the result.
      const result = findMatchingAllowRule(channelMatch, [hashRule, channelRule]);
      expect(result).toBe(channelRule);
    });

    it('does NOT match a yesno match — Tier 0 is numbered-only', () => {
      // YesNoMatch has no `channel` field at the type level, but at runtime
      // a defensive bag-shaped object would still skip Tier 0.
      const yesnoMatchAny = { ...yesNoMatch, channel: 'server:hotsheet-channel' } as unknown as MatchResult;
      const result = findMatchingAllowRule(yesnoMatchAny, [channelRule]);
      expect(result).toBeNull();
    });

    it('skips when choice_index is out of range for the live shape (bounds check)', () => {
      const overflowRule: TerminalPromptAllowRule = { ...channelRule, choice_index: 2 };
      // channelMatch has 2 choices (indexes 0 and 1); choice_index 2 is OOR.
      const result = findMatchingAllowRule(channelMatch, [overflowRule]);
      expect(result).toBeNull();
    });

    it('skips when choice_index is negative (defensive)', () => {
      const negRule: TerminalPromptAllowRule = { ...channelRule, choice_index: -1 };
      const result = findMatchingAllowRule(channelMatch, [negRule]);
      expect(result).toBeNull();
    });

    it('does NOT match when match.channel is undefined (non-channel-bearing prompt)', () => {
      const result = findMatchingAllowRule(numberedMatch, [channelRule]);
      // numberedMatch has no `channel` field, so Tier 0 is skipped. Tier 1
      // sees a rule with empty hash that doesn't match `abcd1234`. No match.
      expect(result).toBeNull();
    });

    it('channel-keyed rules are skipped by Tier 1–4 — only fire via Tier 0', () => {
      // A non-channel match whose preview happens to overlap a channel
      // rule's preview must NOT trigger the channel rule via Tier 3.
      const nonChannelMatch: NumberedMatch = {
        ...numberedMatch,
        questionLines: ['Loading development channels can pose a security risk'],
      };
      const result = findMatchingAllowRule(nonChannelMatch, [channelRule]);
      expect(result).toBeNull();
    });
  });

  describe('buildChannelAllowRule', () => {
    it('produces a valid rule with empty question_hash + populated match_channel', () => {
      const rule = buildChannelAllowRule(channelMatch, 0, 'I am using this for local development');
      expect(rule.parser_id).toBe('claude-numbered');
      expect(rule.question_hash).toBe('');
      expect(rule.match_channel).toBe('server:hotsheet-channel');
      expect(rule.choice_index).toBe(0);
      expect(rule.choice_label).toBe('I am using this for local development');
      expect(rule.question_preview).toBe('Loading development channels can pose a security risk');
      expect(rule.id).toMatch(/^tp_/);
      expect(rule.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('throws when called without a captured channel', () => {
      const noChannel: NumberedMatch = { ...numberedMatch };
      expect(() => buildChannelAllowRule(noChannel, 0, 'foo')).toThrow(/without a channel/);
    });
  });

  describe('parseAllowRules — channel-keyed schema', () => {
    it('accepts a channel-keyed rule with empty question_hash', () => {
      const arr = [{
        id: 'r1',
        parser_id: 'claude-numbered',
        question_hash: '',
        choice_index: 0,
        match_channel: 'server:hotsheet-channel',
        created_at: '2026-05-06T00:00:00Z',
      }];
      const parsed = parseAllowRules(arr);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].match_channel).toBe('server:hotsheet-channel');
      expect(parsed[0].question_hash).toBe('');
    });

    it('still rejects a non-channel rule with empty question_hash (back-compat)', () => {
      const arr = [{
        id: 'r1',
        parser_id: 'claude-numbered',
        question_hash: '',
        choice_index: 0,
        created_at: '2026-05-06T00:00:00Z',
      }];
      expect(parseAllowRules(arr)).toHaveLength(0);
    });

    it('drops rules whose match_channel is the wrong type', () => {
      const arr = [{
        id: 'r1',
        parser_id: 'claude-numbered',
        question_hash: '',
        choice_index: 0,
        match_channel: 42,
        created_at: '2026-05-06T00:00:00Z',
      }];
      // match_channel isn't a string → not retained → empty hash gate kicks in.
      expect(parseAllowRules(arr)).toHaveLength(0);
    });

    it('dedupe: a channel rule and a hash rule for the same (parser, choice_index) coexist', () => {
      const arr = [
        {
          id: 'r_chan',
          parser_id: 'claude-numbered',
          question_hash: '',
          choice_index: 0,
          match_channel: 'server:hotsheet-channel',
          created_at: '2026-05-06T00:00:00Z',
        },
        {
          id: 'r_hash',
          parser_id: 'claude-numbered',
          question_hash: 'abcd1234',
          choice_index: 0,
          created_at: '2026-05-06T00:00:00Z',
        },
      ];
      const parsed = parseAllowRules(arr);
      expect(parsed).toHaveLength(2);
      expect(parsed.map(r => r.id).sort()).toEqual(['r_chan', 'r_hash']);
    });

    it('dedupe: two channel rules with different channels coexist', () => {
      const arr = [
        {
          id: 'r_a',
          parser_id: 'claude-numbered',
          question_hash: '',
          choice_index: 0,
          match_channel: 'server:foo',
          created_at: '2026-05-06T00:00:00Z',
        },
        {
          id: 'r_b',
          parser_id: 'claude-numbered',
          question_hash: '',
          choice_index: 0,
          match_channel: 'server:bar',
          created_at: '2026-05-06T00:00:00Z',
        },
      ];
      expect(parseAllowRules(arr)).toHaveLength(2);
    });

    it('dedupe: two channel rules for the SAME channel collapse to the first', () => {
      const arr = [
        {
          id: 'r_first',
          parser_id: 'claude-numbered',
          question_hash: '',
          choice_index: 0,
          match_channel: 'server:foo',
          created_at: '2026-05-06T00:00:00Z',
        },
        {
          id: 'r_dup',
          parser_id: 'claude-numbered',
          question_hash: '',
          choice_index: 0,
          match_channel: 'server:foo',
          created_at: '2026-05-06T01:00:00Z',
        },
      ];
      const parsed = parseAllowRules(arr);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].id).toBe('r_first');
    });
  });

  describe('payloadForAutoAllow — channel-keyed rules', () => {
    it('produces the same payload as an equivalent hash-keyed rule', () => {
      const channelPayload = payloadForAutoAllow(channelMatch, channelRule);
      const hashRule: TerminalPromptAllowRule = {
        id: 'tp_hash',
        parser_id: 'claude-numbered',
        question_hash: 'abcd1234',
        choice_index: 0,
        created_at: '2026-05-06T00:00:00Z',
      };
      const hashPayload = payloadForAutoAllow(channelMatch, hashRule);
      expect(channelPayload).toBe(hashPayload);
      expect(channelPayload).toBe('\r');
    });
  });
});
