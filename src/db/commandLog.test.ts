import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import { addLogEntry, clearLog, getLogCount, getLogEntries, pruneLog, updateLogEntry } from './commandLog.js';

let tempDir: string;

beforeAll(async () => {
  tempDir = await setupTestDb();
});

afterAll(async () => {
  await cleanupTestDb(tempDir);
});

beforeEach(async () => {
  await clearLog();
});

describe('addLogEntry', () => {
  it('creates a log entry and returns it', async () => {
    const entry = await addLogEntry('sync', 'inbound', 'Pulled 3 tickets', 'Details here');
    expect(entry.id).toBeGreaterThan(0);
    expect(entry.event_type).toBe('sync');
    expect(entry.direction).toBe('inbound');
    expect(entry.summary).toBe('Pulled 3 tickets');
    expect(entry.detail).toBe('Details here');
    expect(entry.created_at).toBeTruthy();
  });
});

describe('getLogEntries', () => {
  it('returns entries ordered by created_at DESC', async () => {
    await addLogEntry('sync', 'inbound', 'First', '');
    await addLogEntry('push', 'outbound', 'Second', '');
    await addLogEntry('sync', 'inbound', 'Third', '');

    const entries = await getLogEntries();
    expect(entries.length).toBe(3);
    expect(entries[0].summary).toBe('Third');
    expect(entries[2].summary).toBe('First');
  });

  it('respects limit and offset', async () => {
    for (let i = 1; i <= 5; i++) {
      await addLogEntry('sync', 'inbound', `Entry ${i}`, '');
    }

    const page1 = await getLogEntries({ limit: 2, offset: 0 });
    expect(page1.length).toBe(2);
    expect(page1[0].summary).toBe('Entry 5');
    expect(page1[1].summary).toBe('Entry 4');

    const page2 = await getLogEntries({ limit: 2, offset: 2 });
    expect(page2.length).toBe(2);
    expect(page2[0].summary).toBe('Entry 3');
    expect(page2[1].summary).toBe('Entry 2');
  });

  it('filters by eventType', async () => {
    await addLogEntry('sync', 'inbound', 'Sync entry', '');
    await addLogEntry('push', 'outbound', 'Push entry', '');
    await addLogEntry('sync', 'inbound', 'Another sync', '');

    const syncOnly = await getLogEntries({ eventType: 'sync' });
    expect(syncOnly.length).toBe(2);
    expect(syncOnly.every(e => e.event_type === 'sync')).toBe(true);
  });

  it('filters by search term (case-insensitive)', async () => {
    await addLogEntry('sync', 'inbound', 'Pulled tickets', 'from GitHub');
    await addLogEntry('push', 'outbound', 'Pushed changes', 'to remote');
    await addLogEntry('sync', 'inbound', 'Pulled issues', 'from GitLab');

    const results = await getLogEntries({ search: 'github' });
    expect(results.length).toBe(1);
    expect(results[0].summary).toBe('Pulled tickets');
  });

  it('searches both summary and detail fields', async () => {
    await addLogEntry('sync', 'inbound', 'Generic summary', 'Contains keyword SEARCHME');
    await addLogEntry('push', 'outbound', 'Has SEARCHME in summary', 'plain detail');

    const results = await getLogEntries({ search: 'SEARCHME' });
    expect(results.length).toBe(2);
  });

  it('combines eventType and search filters', async () => {
    await addLogEntry('sync', 'inbound', 'Sync with keyword', '');
    await addLogEntry('push', 'outbound', 'Push with keyword', '');
    await addLogEntry('sync', 'inbound', 'Sync without it', '');

    const results = await getLogEntries({ eventType: 'sync', search: 'keyword' });
    expect(results.length).toBe(1);
    expect(results[0].summary).toBe('Sync with keyword');
  });
});

describe('getLogCount', () => {
  it('returns total count with no filters', async () => {
    await addLogEntry('sync', 'inbound', 'One', '');
    await addLogEntry('push', 'outbound', 'Two', '');
    await addLogEntry('sync', 'inbound', 'Three', '');

    const count = await getLogCount();
    expect(count).toBe(3);
  });

  it('returns filtered count', async () => {
    await addLogEntry('sync', 'inbound', 'A', '');
    await addLogEntry('push', 'outbound', 'B', '');
    await addLogEntry('sync', 'inbound', 'C', '');

    const count = await getLogCount({ eventType: 'sync' });
    expect(count).toBe(2);
  });
});

describe('updateLogEntry', () => {
  it('updates summary', async () => {
    const entry = await addLogEntry('sync', 'inbound', 'Original', 'Detail');
    await updateLogEntry(entry.id, { summary: 'Updated summary' });

    const entries = await getLogEntries();
    expect(entries[0].summary).toBe('Updated summary');
    expect(entries[0].detail).toBe('Detail');
  });

  it('updates detail', async () => {
    const entry = await addLogEntry('sync', 'inbound', 'Summary', 'Original detail');
    await updateLogEntry(entry.id, { detail: 'New detail' });

    const entries = await getLogEntries();
    expect(entries[0].summary).toBe('Summary');
    expect(entries[0].detail).toBe('New detail');
  });

  it('updates both summary and detail', async () => {
    const entry = await addLogEntry('sync', 'inbound', 'Old sum', 'Old det');
    await updateLogEntry(entry.id, { summary: 'New sum', detail: 'New det' });

    const entries = await getLogEntries();
    expect(entries[0].summary).toBe('New sum');
    expect(entries[0].detail).toBe('New det');
  });

  it('does nothing when no updates provided', async () => {
    const entry = await addLogEntry('sync', 'inbound', 'Unchanged', 'Unchanged detail');
    await updateLogEntry(entry.id, {});

    const entries = await getLogEntries();
    expect(entries[0].summary).toBe('Unchanged');
    expect(entries[0].detail).toBe('Unchanged detail');
  });
});

describe('clearLog', () => {
  it('removes all entries', async () => {
    await addLogEntry('sync', 'inbound', 'A', '');
    await addLogEntry('push', 'outbound', 'B', '');
    expect(await getLogCount()).toBe(2);

    await clearLog();
    expect(await getLogCount()).toBe(0);
  });
});

describe('pruneLog', () => {
  it('keeps only the most recent N entries', async () => {
    for (let i = 1; i <= 5; i++) {
      await addLogEntry('sync', 'inbound', `Entry ${i}`, '');
    }
    expect(await getLogCount()).toBe(5);

    await pruneLog(3);

    const remaining = await getLogEntries();
    expect(remaining.length).toBe(3);
    // Most recent entries should be kept
    expect(remaining[0].summary).toBe('Entry 5');
    expect(remaining[1].summary).toBe('Entry 4');
    expect(remaining[2].summary).toBe('Entry 3');
  });

  it('does nothing when count is below maxEntries', async () => {
    await addLogEntry('sync', 'inbound', 'Only one', '');
    await pruneLog(100);

    expect(await getLogCount()).toBe(1);
  });
});
