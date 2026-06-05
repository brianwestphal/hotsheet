/**
 * §78 Announcer live mode (HS-8769) — dismissed-topics storage + normalization,
 * and (HS-8768) the backlog-compression threshold.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import { addDismissedTopic, getDismissedTopics, MAX_DISMISSED_TOPICS, normalizeTopics, setDismissedTopics } from './dismissedTopics.js';
import { BACKLOG_HIGH_THRESHOLD,backlogCompressionLevel } from './generate.js';

describe('normalizeTopics (HS-8769)', () => {
  it('trims, drops blanks, dedupes case-insensitively', () => {
    expect(normalizeTopics(['Fixed export', 'fixed export', '  ', 'Added tests'])).toEqual(['Fixed export', 'Added tests']);
  });
  it('keeps only the most-recent N', () => {
    const many = Array.from({ length: MAX_DISMISSED_TOPICS + 10 }, (_, i) => `t${String(i)}`);
    const out = normalizeTopics(many);
    expect(out).toHaveLength(MAX_DISMISSED_TOPICS);
    expect(out[0]).toBe('t10'); // dropped the oldest 10
  });
});

describe('backlogCompressionLevel (HS-8768)', () => {
  it('compresses harder once the unplayed backlog crosses the threshold', () => {
    expect(backlogCompressionLevel(0)).toBe('normal');
    expect(backlogCompressionLevel(BACKLOG_HIGH_THRESHOLD - 1)).toBe('normal');
    expect(backlogCompressionLevel(BACKLOG_HIGH_THRESHOLD)).toBe('high');
    expect(backlogCompressionLevel(BACKLOG_HIGH_THRESHOLD + 5)).toBe('high');
  });
});

describe('dismissed-topics storage (HS-8769)', () => {
  let tempDir: string;
  beforeAll(async () => { tempDir = await setupTestDb(); });
  afterAll(async () => { await cleanupTestDb(tempDir); });
  beforeEach(async () => { await setDismissedTopics([]); });

  it('add appends + dedupes; set replaces', async () => {
    await addDismissedTopic('Fixed export');
    await addDismissedTopic('fixed export'); // dup (case-insensitive) → ignored
    await addDismissedTopic('  ');            // blank → ignored
    expect(await getDismissedTopics()).toEqual(['Fixed export']);

    await setDismissedTopics(['a', '', 'b', 'a']);
    expect(await getDismissedTopics()).toEqual(['a', 'b']);
  });
});
