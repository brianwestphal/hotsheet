/**
 * HS-8686 — unit tests for `computeConflictDiff`. The pre-fix render in
 * `pluginSettings.tsx` had a too-narrow zod schema (`ConflictPrimitiveSchema`)
 * that rejected the `tags: string[]` field every real conflict carries,
 * silently dropping the entire diff. These tests pin the new behavior so the
 * regression class can't recur.
 */
import { describe, expect, it } from 'vitest';

import { computeConflictDiff } from './pluginConflictDiff.js';

describe('computeConflictDiff', () => {
  it('returns no-data when conflict_data is null', () => {
    const diff = computeConflictDiff(null);
    expect(diff.status).toBe('no-data');
    expect(diff.fields).toEqual([]);
    expect(diff.summary).toMatch(/no diff details/i);
  });

  it('returns no-data when conflict_data is empty string', () => {
    expect(computeConflictDiff('').status).toBe('no-data');
  });

  it('returns parse-error when conflict_data is not valid JSON', () => {
    const diff = computeConflictDiff('not json {');
    expect(diff.status).toBe('parse-error');
    expect(diff.fields).toEqual([]);
  });

  it('detects a single title-only diff', () => {
    const blob = JSON.stringify({
      local: { title: 'Local title', status: 'started' },
      remote: { title: 'Remote title', status: 'started' },
    });
    const diff = computeConflictDiff(blob);
    expect(diff.status).toBe('has-diff');
    expect(diff.fields).toHaveLength(1);
    expect(diff.fields[0]).toMatchObject({
      key: 'title',
      label: 'Title',
      local: 'Local title',
      remote: 'Remote title',
      multiline: false,
    });
    expect(diff.summary).toBe('1 field differs: title.');
  });

  it('treats array-valued `tags` as a real, renderable field (the HS-8686 regression case)', () => {
    // Pre-fix: the client's schema rejected arrays, returning null for the
    // whole parse. This is the exact shape the GitHub-issues backend emits
    // via `extractTicketFields`.
    const blob = JSON.stringify({
      local: { title: 'Same title', tags: ['urgent', 'bug'] },
      remote: { title: 'Same title', tags: ['urgent'] },
    });
    const diff = computeConflictDiff(blob);
    expect(diff.status).toBe('has-diff');
    expect(diff.fields).toHaveLength(1);
    expect(diff.fields[0].key).toBe('tags');
    expect(diff.fields[0].local).toBe('urgent, bug');
    expect(diff.fields[0].remote).toBe('urgent');
  });

  it('returns no-diff when every field stringify-matches (metadata-only conflict)', () => {
    const blob = JSON.stringify({
      local: { title: 'Same', status: 'started', tags: ['a'] },
      remote: { title: 'Same', status: 'started', tags: ['a'] },
    });
    const diff = computeConflictDiff(blob);
    expect(diff.status).toBe('no-diff');
    expect(diff.fields).toEqual([]);
    expect(diff.summary).toMatch(/metadata-only/i);
  });

  it('orders fields with title first and details last by convention', () => {
    const blob = JSON.stringify({
      local: { details: 'A', tags: ['x'], title: 'A', status: 'started', priority: 'low', up_next: false, category: 'bug' },
      remote: { details: 'B', tags: ['y'], title: 'B', status: 'completed', priority: 'high', up_next: true, category: 'feature' },
    });
    const diff = computeConflictDiff(blob);
    expect(diff.fields.map((f) => f.key)).toEqual([
      'title',
      'status',
      'category',
      'priority',
      'up_next',
      'tags',
      'details',
    ]);
  });

  it('puts unknown keys after known keys, alphabetically', () => {
    const blob = JSON.stringify({
      local: { title: 'A', custom_field_b: '1', custom_field_a: '1' },
      remote: { title: 'B', custom_field_b: '2', custom_field_a: '2' },
    });
    const diff = computeConflictDiff(blob);
    expect(diff.fields.map((f) => f.key)).toEqual([
      'title',
      'custom_field_a',
      'custom_field_b',
    ]);
  });

  it('renders booleans as `true` / `false`, not `1`/`0`', () => {
    const blob = JSON.stringify({
      local: { up_next: true },
      remote: { up_next: false },
    });
    const diff = computeConflictDiff(blob);
    expect(diff.fields[0].local).toBe('true');
    expect(diff.fields[0].remote).toBe('false');
    expect(diff.fields[0].label).toBe('Up Next');
  });

  it('renders null / missing as `(empty)`', () => {
    const blob = JSON.stringify({
      local: { details: null },
      remote: { details: 'has value' },
    });
    const diff = computeConflictDiff(blob);
    expect(diff.fields[0].local).toBe('(empty)');
    expect(diff.fields[0].remote).toBe('has value');
  });

  it('renders empty arrays as `(empty)`, non-empty arrays joined', () => {
    const blob = JSON.stringify({
      local: { tags: [] },
      remote: { tags: ['a', 'b', 'c'] },
    });
    const diff = computeConflictDiff(blob);
    expect(diff.fields[0].local).toBe('(empty)');
    expect(diff.fields[0].remote).toBe('a, b, c');
  });

  it('detects multiline for newline-containing details', () => {
    const blob = JSON.stringify({
      local: { details: 'line1\nline2' },
      remote: { details: 'just one line' },
    });
    const diff = computeConflictDiff(blob);
    expect(diff.fields[0].multiline).toBe(true);
  });

  it('detects multiline for >80-char single-line text', () => {
    const blob = JSON.stringify({
      local: { details: 'a'.repeat(100) },
      remote: { details: 'b' },
    });
    const diff = computeConflictDiff(blob);
    expect(diff.fields[0].multiline).toBe(true);
  });

  it('surfaces base_synced_at when present', () => {
    const blob = JSON.stringify({
      local: { title: 'X' },
      remote: { title: 'Y' },
      base_synced_at: '2026-05-28T10:00:00.000Z',
    });
    const diff = computeConflictDiff(blob);
    expect(diff.baseSyncedAt).toBe('2026-05-28T10:00:00.000Z');
  });

  it('handles fields present on only one side as an add/remove', () => {
    const blob = JSON.stringify({
      local: { title: 'A', extra_only_local: 'yes' },
      remote: { title: 'A' },
    });
    const diff = computeConflictDiff(blob);
    expect(diff.status).toBe('has-diff');
    expect(diff.fields).toHaveLength(1);
    expect(diff.fields[0].key).toBe('extra_only_local');
    expect(diff.fields[0].local).toBe('yes');
    expect(diff.fields[0].remote).toBe('(empty)');
  });

  it('summary lists every differing field, lowercased', () => {
    const blob = JSON.stringify({
      local: { title: 'A', status: 'started', tags: ['x'] },
      remote: { title: 'B', status: 'completed', tags: ['y'] },
    });
    const diff = computeConflictDiff(blob);
    expect(diff.summary).toBe('3 fields differ: title, status, tags.');
  });

  it('survives a wholly empty local + remote bag', () => {
    const blob = JSON.stringify({ local: {}, remote: {} });
    const diff = computeConflictDiff(blob);
    expect(diff.status).toBe('no-diff');
  });
});
