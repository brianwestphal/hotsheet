import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import { addAttachment, createTicket, updateTicket } from '../db/queries.js';
import { getDb } from '../db/connection.js';
import { initMarkdownSync, scheduleOpenTicketsSync, scheduleWorklistSync } from './markdown.js';

let tempDir: string;

beforeAll(async () => {
  tempDir = await setupTestDb();
  initMarkdownSync(tempDir, 9999);
});

afterAll(async () => {
  await cleanupTestDb(tempDir);
});

function waitFor(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('worklist sync', () => {
  it('generates empty worklist when no up_next tickets exist', async () => {
    // DB is fresh — no tickets at all
    scheduleWorklistSync();
    await waitFor(700);

    const path = join(tempDir, 'worklist.md');
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('# Hot Sheet - Up Next');
    expect(content).toContain('No items in the Up Next list.');
    expect(content).toContain('## Workflow');
  });

  it('generates worklist.md with up_next tickets', async () => {
    await createTicket('Worklist ticket', { category: 'bug', priority: 'high', up_next: true });
    scheduleWorklistSync();
    await waitFor(700);

    const content = readFileSync(join(tempDir, 'worklist.md'), 'utf-8');
    expect(content).toContain('# Hot Sheet - Up Next');
    expect(content).toContain('Worklist ticket');
    expect(content).toContain('localhost:9999');
    // Should no longer say "No items"
    expect(content).not.toContain('No items in the Up Next list.');
  });

  it('includes workflow section with curl examples', async () => {
    const content = readFileSync(join(tempDir, 'worklist.md'), 'utf-8');
    expect(content).toContain('## Workflow');
    expect(content).toContain('curl');
    expect(content).toContain('http://localhost:9999/api');
  });

  it('includes ticket details and notes', async () => {
    const t = await createTicket('Detailed ticket', { up_next: true, details: 'Important details' });
    await updateTicket(t.id, { notes: 'A test note' });
    scheduleWorklistSync();
    await waitFor(700);

    const content = readFileSync(join(tempDir, 'worklist.md'), 'utf-8');
    expect(content).toContain('Important details');
    expect(content).toContain('A test note');
  });

  it('formats multi-line details correctly', async () => {
    await createTicket('Multiline ticket', { up_next: true, details: 'Line one\nLine two\nLine three' });
    scheduleWorklistSync();
    await waitFor(700);

    const content = readFileSync(join(tempDir, 'worklist.md'), 'utf-8');
    expect(content).toContain('- Details: Line one');
    expect(content).toContain('  Line two');
    expect(content).toContain('  Line three');
  });

  it('includes attachment listing for tickets with attachments', async () => {
    const t = await createTicket('Attached ticket', { up_next: true });
    await addAttachment(t.id, 'screenshot.png', '/fake/path/screenshot.png');
    scheduleWorklistSync();
    await waitFor(700);

    const content = readFileSync(join(tempDir, 'worklist.md'), 'utf-8');
    expect(content).toContain('- Attachments:');
    expect(content).toContain('/fake/path/screenshot.png');
  });

  it('formats legacy plain-text notes without timestamp', async () => {
    const db = await getDb();
    const t = await createTicket('Legacy notes ticket', { up_next: true });
    // Directly set plain-text notes to simulate legacy data
    await db.query(`UPDATE tickets SET notes = 'Old plain note' WHERE id = $1`, [t.id]);
    scheduleWorklistSync();
    await waitFor(700);

    const content = readFileSync(join(tempDir, 'worklist.md'), 'utf-8');
    expect(content).toContain('Old plain note');
  });

  it('sorts tickets by priority (highest first)', async () => {
    await createTicket('Low pri ticket', { priority: 'low', up_next: true });
    await createTicket('Highest pri ticket', { priority: 'highest', up_next: true });
    scheduleWorklistSync();
    await waitFor(700);

    const content = readFileSync(join(tempDir, 'worklist.md'), 'utf-8');
    const highestPos = content.indexOf('Highest pri ticket');
    const lowPos = content.indexOf('Low pri ticket');
    expect(highestPos).toBeLessThan(lowPos);
  });

  it('includes category descriptions', async () => {
    const content = readFileSync(join(tempDir, 'worklist.md'), 'utf-8');
    expect(content).toContain('Ticket Types:');
  });

  it('includes creating tickets section', async () => {
    const content = readFileSync(join(tempDir, 'worklist.md'), 'utf-8');
    expect(content).toContain('## Creating Tickets');
    expect(content).toContain('POST');
  });
});

describe('open tickets sync', () => {
  it('generates open-tickets.md grouped by status', async () => {
    const t = await createTicket('Started ticket');
    await updateTicket(t.id, { status: 'started' });
    await createTicket('Not started ticket');

    scheduleOpenTicketsSync();
    await waitFor(5500);

    const path = join(tempDir, 'open-tickets.md');
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('# Hot Sheet - Open Tickets');
    expect(content).toContain('## Started');
    expect(content).toContain('## Not Started');
    expect(content).toContain('Total:');
  });
});
