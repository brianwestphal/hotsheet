/**
 * HS-7952 — pure-helper tests for the permission allow-rule matcher.
 * The fetchPermission integration (auto-allow inserts a logged event +
 * forwards `behavior:'allow'` to the channel server) is exercised at the
 * route-test layer; these tests pin the matcher math.
 */
import { describe, expect, it } from 'vitest';

import {
  type AllowRule,
  extractPrimaryValue,
  findMatchingAllowRule,
  parseAllowRules,
  primaryFieldKey,
} from './permissionAllowRules.js';

function rule(o: Partial<AllowRule>): AllowRule {
  return {
    id: 'r1',
    tool: 'Bash',
    pattern: '^git status$',
    added_at: '2026-04-28T00:00:00Z',
    ...o,
  };
}

describe('primaryFieldKey (HS-7952)', () => {
  it('returns the right key for each supported tool', () => {
    expect(primaryFieldKey('Bash')).toBe('command');
    expect(primaryFieldKey('Read')).toBe('file_path');
    expect(primaryFieldKey('NotebookRead')).toBe('file_path');
    expect(primaryFieldKey('WebFetch')).toBe('url');
    expect(primaryFieldKey('WebSearch')).toBe('query');
    expect(primaryFieldKey('Glob')).toBe('pattern');
  });

  it('returns null for unsupported tools (Edit / Write / unknown)', () => {
    expect(primaryFieldKey('Edit')).toBeNull();
    expect(primaryFieldKey('Write')).toBeNull();
    expect(primaryFieldKey('TodoWrite')).toBeNull();
    expect(primaryFieldKey('SomeNewTool')).toBeNull();
  });
});

describe('extractPrimaryValue (HS-7952)', () => {
  it('returns the field for a well-formed Bash input', () => {
    expect(extractPrimaryValue('Bash', JSON.stringify({ command: 'git status' }))).toBe('git status');
  });

  it('returns null for non-allow-listable tools', () => {
    expect(extractPrimaryValue('Edit', JSON.stringify({ command: 'x' }))).toBeNull();
  });

  it('returns null for non-string field values (numbers / objects / null)', () => {
    expect(extractPrimaryValue('Bash', JSON.stringify({ command: 42 }))).toBeNull();
    expect(extractPrimaryValue('Bash', JSON.stringify({ command: null }))).toBeNull();
  });

  it('returns null for missing fields', () => {
    expect(extractPrimaryValue('Bash', JSON.stringify({ description: 'no command field' }))).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(extractPrimaryValue('Bash', '{not json')).toBeNull();
    expect(extractPrimaryValue('Bash', '')).toBeNull();
  });

  it('returns null for top-level arrays / nulls / scalars', () => {
    expect(extractPrimaryValue('Bash', '[1,2,3]')).toBeNull();
    expect(extractPrimaryValue('Bash', 'null')).toBeNull();
    expect(extractPrimaryValue('Bash', '"just a string"')).toBeNull();
  });
});

describe('parseAllowRules (HS-7952)', () => {
  it('returns [] for empty / unparseable input', () => {
    expect(parseAllowRules(undefined)).toEqual([]);
    expect(parseAllowRules(null)).toEqual([]);
    expect(parseAllowRules('')).toEqual([]);
    expect(parseAllowRules('not-json')).toEqual([]);
    expect(parseAllowRules(42)).toEqual([]);
  });

  it('parses a well-formed array', () => {
    const raw = [{ id: 'r1', tool: 'Bash', pattern: '^git status$', added_at: '2026-04-28T00:00:00Z' }];
    expect(parseAllowRules(raw)).toEqual(raw);
  });

  it('tolerates the legacy stringified-JSON shape', () => {
    const raw = JSON.stringify([{ id: 'r1', tool: 'Bash', pattern: '^x$', added_at: 'now' }]);
    expect(parseAllowRules(raw)).toHaveLength(1);
  });

  it('drops entries with missing required fields', () => {
    const raw = [
      { id: '', tool: 'Bash', pattern: '^x$' }, // empty id
      { tool: 'Bash', pattern: '^x$' }, // no id
      { id: 'r1', pattern: '^x$' }, // no tool
      { id: 'r2', tool: 'Bash' }, // no pattern
      { id: 'r3', tool: 'Bash', pattern: '^x$' }, // valid
    ];
    const out = parseAllowRules(raw);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('r3');
  });

  it('preserves added_by when set, drops it otherwise', () => {
    const raw = [
      { id: 'a', tool: 'Bash', pattern: '^x$', added_by: 'overlay' },
      { id: 'b', tool: 'Bash', pattern: '^x$', added_by: 'settings' },
      { id: 'c', tool: 'Bash', pattern: '^x$', added_by: 'malformed' },
      { id: 'd', tool: 'Bash', pattern: '^x$' },
    ];
    const out = parseAllowRules(raw);
    expect(out[0].added_by).toBe('overlay');
    expect(out[1].added_by).toBe('settings');
    expect(out[2].added_by).toBeUndefined();
    expect(out[3].added_by).toBeUndefined();
  });
});

describe('findMatchingAllowRule (HS-7952)', () => {
  it('matches when tool + pattern both match', () => {
    const r = rule({ tool: 'Bash', pattern: '^git status$' });
    expect(findMatchingAllowRule('Bash', 'git status', [r])).toBe(r);
  });

  it('returns null when tool doesnt match', () => {
    const r = rule({ tool: 'Bash', pattern: '^x$' });
    expect(findMatchingAllowRule('Read', 'x', [r])).toBeNull();
  });

  it('returns null when pattern doesnt match (anchored)', () => {
    // Pattern is `^git status$` — full match required.
    const r = rule({ tool: 'Bash', pattern: '^git status$' });
    expect(findMatchingAllowRule('Bash', 'cd /tmp && git status', [r])).toBeNull();
    expect(findMatchingAllowRule('Bash', 'git status -s', [r])).toBeNull();
  });

  it('matches with a regex broader than literal', () => {
    const r = rule({ tool: 'Bash', pattern: '^git (status|diff)$' });
    expect(findMatchingAllowRule('Bash', 'git status', [r])).toBe(r);
    expect(findMatchingAllowRule('Bash', 'git diff', [r])).toBe(r);
    expect(findMatchingAllowRule('Bash', 'git log', [r])).toBeNull();
  });

  it('returns null for Edit / Write tools regardless of rules', () => {
    // §47.4.2 — file path alone doesnt capture diff intent.
    const r = rule({ tool: 'Edit', pattern: '.*' });
    expect(findMatchingAllowRule('Edit', 'anything', [r])).toBeNull();
    const r2 = rule({ tool: 'Write', pattern: '.*' });
    expect(findMatchingAllowRule('Write', 'anything', [r2])).toBeNull();
  });

  it('skips rules with malformed regex (no crash)', () => {
    const r = rule({ tool: 'Bash', pattern: '[unclosed' });
    expect(findMatchingAllowRule('Bash', 'anything', [r])).toBeNull();
  });

  it('skips rules whose pattern exceeds the length cap (catastrophic-backtracking guard)', () => {
    const r = rule({ tool: 'Bash', pattern: 'a'.repeat(1000) });
    expect(findMatchingAllowRule('Bash', 'a'.repeat(1000), [r])).toBeNull();
  });

  it('returns the FIRST matching rule when multiple match', () => {
    const r1 = rule({ id: 'r1', tool: 'Bash', pattern: '^git .*$' });
    const r2 = rule({ id: 'r2', tool: 'Bash', pattern: '^git status$' });
    expect(findMatchingAllowRule('Bash', 'git status', [r1, r2])?.id).toBe('r1');
  });

  it('returns null with an empty rule list', () => {
    expect(findMatchingAllowRule('Bash', 'git status', [])).toBeNull();
  });
});
