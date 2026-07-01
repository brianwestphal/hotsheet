// HS-9247 — built-in default auto-context + the read-time merge. These cover the
// merge's state transitions (default → user override → empty-text suppress →
// user-only entry) rather than each branch from a clean slate.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AUTO_CONTEXT,
  defaultAutoContextFor,
  resolveAutoContextWithDefaults,
} from './autoContextDefaults.js';
import type { AutoContextEntry } from './schemas.js';

describe('DEFAULT_AUTO_CONTEXT', () => {
  it('ships a default for each of the six software built-in categories', () => {
    for (const key of ['issue', 'bug', 'feature', 'requirement_change', 'task', 'investigation']) {
      expect(defaultAutoContextFor(key)).not.toBeNull();
    }
  });

  it('the bug default demands both positive and negative test cases (HS-9247 feedback)', () => {
    const bug = defaultAutoContextFor('bug') ?? '';
    expect(bug.toLowerCase()).toContain('positive');
    expect(bug.toLowerCase()).toContain('negative');
    expect(bug.toLowerCase()).toContain('root cause');
  });

  it('the requirement_change default mentions tests may be required', () => {
    expect((defaultAutoContextFor('requirement_change') ?? '').toLowerCase()).toContain('test');
  });

  it('ships design/creative preset defaults but NOT product/marketing/personal specifics', () => {
    expect(defaultAutoContextFor('concept')).not.toBeNull();
    expect(defaultAutoContextFor('asset')).not.toBeNull();
    // No default for product/marketing/personal-only category ids.
    expect(defaultAutoContextFor('epic')).toBeNull();
    expect(defaultAutoContextFor('campaign')).toBeNull();
    expect(defaultAutoContextFor('errand')).toBeNull();
    expect(defaultAutoContextFor('nonexistent')).toBeNull();
  });

  it('every entry is a category entry with non-empty text', () => {
    for (const e of DEFAULT_AUTO_CONTEXT) {
      expect(e.type).toBe('category');
      expect(e.text.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('resolveAutoContextWithDefaults', () => {
  it('returns the built-in defaults when the user has none', () => {
    const resolved = resolveAutoContextWithDefaults([]);
    expect(resolved.find((e) => e.key === 'bug')?.text).toBe(defaultAutoContextFor('bug'));
    expect(resolved.length).toBe(DEFAULT_AUTO_CONTEXT.length);
  });

  it('a user entry overrides the default for that category', () => {
    const user: AutoContextEntry[] = [{ type: 'category', key: 'bug', text: 'MY CUSTOM BUG CONTEXT' }];
    const resolved = resolveAutoContextWithDefaults(user);
    expect(resolved.find((e) => e.type === 'category' && e.key === 'bug')?.text).toBe('MY CUSTOM BUG CONTEXT');
    // Other categories still get their defaults.
    expect(resolved.find((e) => e.key === 'feature')?.text).toBe(defaultAutoContextFor('feature'));
  });

  it('an explicit empty-text user entry suppresses the default (kept, empty)', () => {
    const user: AutoContextEntry[] = [{ type: 'category', key: 'bug', text: '' }];
    const resolved = resolveAutoContextWithDefaults(user);
    const bug = resolved.find((e) => e.type === 'category' && e.key === 'bug');
    expect(bug).toBeDefined();
    expect(bug?.text).toBe('');
  });

  it('user-only entries (a tag, or a category with no default) are appended', () => {
    const user: AutoContextEntry[] = [
      { type: 'tag', key: 'frontend', text: 'FE CONTEXT' },
      { type: 'category', key: 'epic', text: 'EPIC CONTEXT' },
    ];
    const resolved = resolveAutoContextWithDefaults(user);
    expect(resolved.find((e) => e.type === 'tag' && e.key === 'frontend')?.text).toBe('FE CONTEXT');
    expect(resolved.find((e) => e.type === 'category' && e.key === 'epic')?.text).toBe('EPIC CONTEXT');
    // Built-in defaults survive alongside the user-only entries.
    expect(resolved.find((e) => e.key === 'bug')?.text).toBe(defaultAutoContextFor('bug'));
  });

  it('does not mutate the input array', () => {
    const user: AutoContextEntry[] = [{ type: 'category', key: 'bug', text: 'X' }];
    resolveAutoContextWithDefaults(user);
    expect(user).toHaveLength(1);
  });

  it('HS-9256 — a suppressed id omits its default (locally-hidden shared entry)', () => {
    const resolved = resolveAutoContextWithDefaults([], new Set(['category:bug']));
    // The bug default is suppressed; other defaults still apply.
    expect(resolved.find((e) => e.type === 'category' && e.key === 'bug')).toBeUndefined();
    expect(resolved.find((e) => e.key === 'feature')?.text).toBe(defaultAutoContextFor('feature'));
  });

  it('HS-9256 — a user entry still wins even if its id is also in the suppressed set', () => {
    // Suppression only gates the DEFAULT fallback; an explicit user entry for the
    // key is authoritative (belt-and-suspenders — the caller never passes both,
    // but the merge order must keep the user entry).
    const user: AutoContextEntry[] = [{ type: 'category', key: 'bug', text: 'EXPLICIT' }];
    const resolved = resolveAutoContextWithDefaults(user, new Set(['category:bug']));
    expect(resolved.find((e) => e.type === 'category' && e.key === 'bug')?.text).toBe('EXPLICIT');
  });
});
