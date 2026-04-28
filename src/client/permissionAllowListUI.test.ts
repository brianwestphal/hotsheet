/**
 * HS-7953 — pure-helper tests for the allow-list management UI. The DOM-
 * mounting paths (table render, +Add form, overlay shortcut) are exercised
 * at e2e; these pin the pure regex-escape / pattern-validation / id-gen /
 * meta-formatting / parser logic.
 */
import { describe, expect, it } from 'vitest';

import {
  type AllowRule,
  formatRuleMeta,
  newRuleId,
  parseRules,
  regexEscape,
  validatePattern,
} from './permissionAllowListUI.js';

describe('regexEscape (HS-7953)', () => {
  it('escapes regex metacharacters so a literal command becomes a safe pattern', () => {
    expect(regexEscape('git status')).toBe('git status');
    expect(regexEscape('a.b')).toBe('a\\.b');
    expect(regexEscape('git log -p')).toBe('git log -p');
    expect(regexEscape('foo (bar) | baz')).toBe('foo \\(bar\\) \\| baz');
    expect(regexEscape('[a-z]+')).toBe('\\[a-z\\]\\+');
  });

  it('preserves spaces and word characters', () => {
    expect(regexEscape('npm run dev')).toBe('npm run dev');
  });
});

describe('validatePattern (HS-7953)', () => {
  it('returns null for a well-formed pattern', () => {
    expect(validatePattern('^git status$')).toBeNull();
    expect(validatePattern('foo')).toBeNull();
    expect(validatePattern('^git (status|diff)$')).toBeNull();
  });

  it('returns an error message for an empty / whitespace-only pattern', () => {
    expect(validatePattern('')).toBe('Pattern is required');
    expect(validatePattern('   ')).toBe('Pattern is required');
  });

  it('returns an error message for an invalid regex', () => {
    expect(validatePattern('[unclosed')).not.toBeNull();
    expect(validatePattern('(?<foo>bad')).not.toBeNull();
  });
});

describe('newRuleId (HS-7953)', () => {
  it('generates unique-looking ids prefixed with `ar_`', () => {
    const id = newRuleId(1700000000000, 0.5);
    expect(id).toMatch(/^ar_/);
    // Determinism with explicit args.
    expect(newRuleId(1700000000000, 0.5)).toBe(id);
  });

  it('produces different ids for different inputs', () => {
    expect(newRuleId(1, 0.1)).not.toBe(newRuleId(2, 0.1));
    expect(newRuleId(1, 0.1)).not.toBe(newRuleId(1, 0.2));
  });
});

describe('parseRules (HS-7953)', () => {
  it('returns [] for empty / unparseable input', () => {
    expect(parseRules(undefined)).toEqual([]);
    expect(parseRules(null)).toEqual([]);
    expect(parseRules('')).toEqual([]);
    expect(parseRules('not-json')).toEqual([]);
    expect(parseRules(42)).toEqual([]);
  });

  it('parses a well-formed array', () => {
    const raw = [{ id: 'r1', tool: 'Bash', pattern: '^git status$', added_at: '2026-04-28T00:00:00Z' }];
    expect(parseRules(raw)).toEqual(raw);
  });

  it('tolerates the legacy stringified-JSON shape', () => {
    const raw = JSON.stringify([{ id: 'r1', tool: 'Bash', pattern: '^x$', added_at: 'now' }]);
    expect(parseRules(raw)).toHaveLength(1);
  });

  it('drops entries with missing required fields', () => {
    const raw = [
      { id: 'r1', tool: 'Bash' }, // no pattern
      { id: '', tool: 'Bash', pattern: '^x$' }, // empty id
      { id: 'r2', tool: 'Bash', pattern: '^x$' }, // valid
    ];
    expect(parseRules(raw)).toHaveLength(1);
  });
});

describe('formatRuleMeta (HS-7953)', () => {
  function rule(o: Partial<AllowRule>): AllowRule {
    return { id: 'r1', tool: 'Bash', pattern: '^x$', added_at: '', ...o };
  }
  it('returns empty string when neither added_by nor added_at is meaningful', () => {
    expect(formatRuleMeta(rule({}))).toBe('');
  });
  it('joins added_by + formatted-date with a bullet separator', () => {
    const out = formatRuleMeta(rule({ added_by: 'overlay', added_at: '2026-04-28T00:00:00Z' }));
    expect(out).toContain('overlay');
    expect(out).toContain('·');
  });
  it('returns just added_by when added_at is invalid', () => {
    expect(formatRuleMeta(rule({ added_by: 'settings', added_at: 'not-a-date' }))).toBe('settings');
  });
  it('returns just the date when only added_at is set', () => {
    const out = formatRuleMeta(rule({ added_at: '2026-04-28T00:00:00Z' }));
    expect(out).not.toContain('·');
    expect(out.length).toBeGreaterThan(0);
  });
});
