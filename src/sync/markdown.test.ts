import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getDb } from '../db/connection.js';
import { addAttachment, createTicket, updateTicket } from '../db/queries.js';
import { updateSetting } from '../db/settings.js';
import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
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
    // With auto_order enabled (default), empty worklist shows auto-prioritize instructions
    expect(content).toContain('## Auto-Prioritize');
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

  it('includes workflow section with curl examples', () => {
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

  it('includes category descriptions', () => {
    const content = readFileSync(join(tempDir, 'worklist.md'), 'utf-8');
    expect(content).toContain('Ticket Types:');
  });

  it('includes creating tickets section', () => {
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

  it('places started tickets before not_started tickets', async () => {
    // Create a not_started ticket first, then a started one
    await createTicket('Open not started item');
    const st = await createTicket('Open started item');
    await updateTicket(st.id, { status: 'started' });

    scheduleOpenTicketsSync();
    await waitFor(5500);

    const content = readFileSync(join(tempDir, 'open-tickets.md'), 'utf-8');
    const startedPos = content.indexOf('## Started');
    const notStartedPos = content.indexOf('## Not Started');
    expect(startedPos).toBeGreaterThan(-1);
    expect(notStartedPos).toBeGreaterThan(-1);
    expect(startedPos).toBeLessThan(notStartedPos);
  });

  it('shows correct total count', async () => {
    scheduleOpenTicketsSync();
    await waitFor(5500);

    const content = readFileSync(join(tempDir, 'open-tickets.md'), 'utf-8');
    const match = content.match(/Total: (\d+) open ticket\(s\)/);
    expect(match).not.toBeNull();
    const count = parseInt(match![1], 10);
    expect(count).toBeGreaterThan(0);
  });

  it('includes category descriptions for open tickets', async () => {
    scheduleOpenTicketsSync();
    await waitFor(5500);

    const content = readFileSync(join(tempDir, 'open-tickets.md'), 'utf-8');
    expect(content).toContain('Ticket Types:');
  });

  it('shows "No open tickets." when all tickets are closed', async () => {
    // Move all tickets to completed so none are open
    const db = await getDb();
    await db.query(`UPDATE tickets SET status = 'completed'`);

    scheduleOpenTicketsSync();
    await waitFor(5500);

    const content = readFileSync(join(tempDir, 'open-tickets.md'), 'utf-8');
    expect(content).toContain('No open tickets.');
    expect(content).not.toContain('Ticket Types:');

    // Restore tickets to not_started for subsequent tests
    await db.query(`UPDATE tickets SET status = 'not_started'`);
  });
});

describe('auto-context in worklist', () => {
  it('includes auto_context content in ticket details', async () => {
    const autoContext = JSON.stringify([
      { type: 'category', key: 'bug', text: 'AUTO_CONTEXT_BUG_INFO: Always check regression tests.' },
    ]);
    await updateSetting('auto_context', autoContext);

    // Create a bug ticket that is up_next
    await createTicket('Bug with context', { category: 'bug', up_next: true });
    scheduleWorklistSync();
    await waitFor(700);

    const content = readFileSync(join(tempDir, 'worklist.md'), 'utf-8');
    expect(content).toContain('AUTO_CONTEXT_BUG_INFO: Always check regression tests.');
    expect(content).toContain('Bug with context');
  });

  it('includes tag-based auto_context content', async () => {
    const autoContext = JSON.stringify([
      { type: 'tag', key: 'frontend', text: 'TAG_CONTEXT_FRONTEND: Check browser compatibility.' },
    ]);
    await updateSetting('auto_context', autoContext);

    // Create a ticket with the 'frontend' tag
    await createTicket('Frontend ticket', { category: 'task', up_next: true, tags: JSON.stringify(['frontend']) });
    scheduleWorklistSync();
    await waitFor(700);

    const content = readFileSync(join(tempDir, 'worklist.md'), 'utf-8');
    expect(content).toContain('TAG_CONTEXT_FRONTEND: Check browser compatibility.');
  });

  it('prepends auto_context before ticket details', async () => {
    const autoContext = JSON.stringify([
      { type: 'category', key: 'feature', text: 'FEATURE_CONTEXT: Follow design system.' },
    ]);
    await updateSetting('auto_context', autoContext);

    await createTicket('Feature with details', { category: 'feature', up_next: true, details: 'Implement the widget.' });
    scheduleWorklistSync();
    await waitFor(700);

    const content = readFileSync(join(tempDir, 'worklist.md'), 'utf-8');
    // Context should appear before the actual details
    const contextPos = content.indexOf('FEATURE_CONTEXT: Follow design system.');
    const detailsPos = content.indexOf('Implement the widget.');
    expect(contextPos).toBeGreaterThan(-1);
    expect(detailsPos).toBeGreaterThan(-1);
    expect(contextPos).toBeLessThan(detailsPos);
  });

  it('ignores auto_context that does not match ticket category/tags', async () => {
    const autoContext = JSON.stringify([
      { type: 'category', key: 'investigation', text: 'INVESTIGATION_ONLY_CONTEXT' },
    ]);
    await updateSetting('auto_context', autoContext);

    await createTicket('Non-investigation ticket', { category: 'task', up_next: true });
    scheduleWorklistSync();
    await waitFor(700);

    const content = readFileSync(join(tempDir, 'worklist.md'), 'utf-8');
    expect(content).toContain('Non-investigation ticket');
    expect(content).not.toContain('INVESTIGATION_ONLY_CONTEXT');
  });
});

describe('auto_order disabled', () => {
  it('shows "No items" message instead of auto-prioritize when auto_order is false', async () => {
    const db = await getDb();
    // Disable auto_order
    await updateSetting('auto_order', 'false');
    // Ensure no up_next tickets
    await db.query(`UPDATE tickets SET up_next = false`);

    scheduleWorklistSync();
    await waitFor(700);

    const content = readFileSync(join(tempDir, 'worklist.md'), 'utf-8');
    expect(content).toContain('No items in the Up Next list.');
    expect(content).not.toContain('## Auto-Prioritize');

    // Re-enable auto_order for subsequent tests
    await updateSetting('auto_order', 'true');
  });
});

describe('category descriptions', () => {
  it('lists only categories used by up_next tickets', async () => {
    const db = await getDb();
    // Clear auto_context so it doesn't interfere
    await updateSetting('auto_context', '[]');
    // Reset all tickets to not up_next
    await db.query(`UPDATE tickets SET up_next = false`);

    // Create tickets with specific categories
    await createTicket('Bug cat ticket', { category: 'bug', up_next: true });
    await createTicket('Feature cat ticket', { category: 'feature', up_next: true });

    scheduleWorklistSync();
    await waitFor(700);

    const content = readFileSync(join(tempDir, 'worklist.md'), 'utf-8');
    expect(content).toContain('Ticket Types:');
    expect(content).toContain('- bug -');
    expect(content).toContain('- feature -');
    // task and investigation should NOT appear since no up_next tickets use them
    // (check the Ticket Types section specifically)
    const typesSection = content.slice(content.indexOf('Ticket Types:'));
    expect(typesSection).not.toContain('- task -');
    expect(typesSection).not.toContain('- investigation -');
    expect(typesSection).not.toContain('- requirement_change -');
  });
});

describe('ticket formatting with notes and attachments', () => {
  it('formats JSON array notes with timestamps', async () => {
    const db = await getDb();
    await db.query(`UPDATE tickets SET up_next = false`);

    const t = await createTicket('JSON notes ticket', { up_next: true });
    const jsonNotes = JSON.stringify([
      { text: 'First note', created_at: '2026-01-15T10:00:00Z' },
      { text: 'Second note', created_at: '2026-01-16T12:00:00Z' },
    ]);
    await db.query(`UPDATE tickets SET notes = $1 WHERE id = $2`, [jsonNotes, t.id]);

    scheduleWorklistSync();
    await waitFor(700);

    const content = readFileSync(join(tempDir, 'worklist.md'), 'utf-8');
    expect(content).toContain('- Notes:');
    expect(content).toContain('First note');
    expect(content).toContain('Second note');
  });

  it('formats tickets with multiple attachments', async () => {
    const db = await getDb();
    await db.query(`UPDATE tickets SET up_next = false`);

    const t = await createTicket('Multi-attach ticket', { up_next: true });
    await addAttachment(t.id, 'doc.pdf', '/files/doc.pdf');
    await addAttachment(t.id, 'image.png', '/files/image.png');

    scheduleWorklistSync();
    await waitFor(700);

    const content = readFileSync(join(tempDir, 'worklist.md'), 'utf-8');
    expect(content).toContain('- Attachments:');
    expect(content).toContain('/files/doc.pdf');
    expect(content).toContain('/files/image.png');
  });

  it('formats ticket tags in title case', async () => {
    const db = await getDb();
    await db.query(`UPDATE tickets SET up_next = false`);
    await updateSetting('auto_context', '[]');

    await createTicket('Tagged ticket', { category: 'task', up_next: true, tags: JSON.stringify(['api', 'backend']) });

    scheduleWorklistSync();
    await waitFor(700);

    const content = readFileSync(join(tempDir, 'worklist.md'), 'utf-8');
    expect(content).toContain('- Tags: Api, Backend');
  });

  it('includes ticket status in output', async () => {
    const db = await getDb();
    await db.query(`UPDATE tickets SET up_next = false`);

    const t = await createTicket('Status ticket', { up_next: true });
    await updateTicket(t.id, { status: 'started' });

    scheduleWorklistSync();
    await waitFor(700);

    const content = readFileSync(join(tempDir, 'worklist.md'), 'utf-8');
    // Status 'started' should appear
    expect(content).toContain('- Status: started');
  });

  it('shows "not started" with space instead of underscore', async () => {
    const db = await getDb();
    await db.query(`UPDATE tickets SET up_next = false`);

    await createTicket('Fresh ticket', { up_next: true });

    scheduleWorklistSync();
    await waitFor(700);

    const content = readFileSync(join(tempDir, 'worklist.md'), 'utf-8');
    expect(content).toContain('- Status: not started');
  });
});

describe('debounce behavior', () => {
  it('worklist debounce replaces pending sync with new one', async () => {
    const db = await getDb();
    await db.query(`UPDATE tickets SET up_next = false`);

    await createTicket('First sync ticket', { up_next: true });
    scheduleWorklistSync();

    // Immediately schedule again before the first fires (500ms debounce)
    await createTicket('Second sync ticket', { up_next: true });
    scheduleWorklistSync();

    // Wait for debounce to fire
    await waitFor(700);

    const content = readFileSync(join(tempDir, 'worklist.md'), 'utf-8');
    // Both tickets should appear since the second schedule replaced the first timer
    // and the final sync picks up all current up_next tickets
    expect(content).toContain('First sync ticket');
    expect(content).toContain('Second sync ticket');
  });

  it('open tickets debounce is longer than worklist debounce', async () => {
    // Schedule both syncs
    scheduleWorklistSync();
    scheduleOpenTicketsSync();

    // After 700ms the worklist should be written but not open-tickets
    await waitFor(700);
    const worklistExists = existsSync(join(tempDir, 'worklist.md'));
    expect(worklistExists).toBe(true);

    // Read worklist to confirm it was just written
    const worklistContent = readFileSync(join(tempDir, 'worklist.md'), 'utf-8');
    expect(worklistContent).toContain('# Hot Sheet - Up Next');

    // Open tickets debounce is 5000ms, so we need to wait longer
    await waitFor(4800);
    const openTicketsContent = readFileSync(join(tempDir, 'open-tickets.md'), 'utf-8');
    expect(openTicketsContent).toContain('# Hot Sheet - Open Tickets');
  });
});
