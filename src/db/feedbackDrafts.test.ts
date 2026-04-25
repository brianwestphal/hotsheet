import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import {
  createFeedbackDraft, deleteFeedbackDraft, getFeedbackDraft,
  listFeedbackDrafts, updateFeedbackDraft,
} from './feedbackDrafts.js';
import { createTicket } from './queries.js';

let tempDir: string;

beforeAll(async () => {
  tempDir = await setupTestDb();
});

afterAll(async () => {
  await cleanupTestDb(tempDir);
});

const samplePartitions = {
  blocks: [
    { markdown: 'How are you?', html: '<p>How are you?</p>' },
    { markdown: 'What time is it?', html: '<p>What time is it?</p>' },
  ],
  inlineResponses: [
    { blockIndex: 0, text: 'Doing fine, thanks' },
  ],
  catchAll: 'Just a quick draft.',
};

describe('feedback_drafts table (HS-7599)', () => {
  it('creates a draft, lists it back, and round-trips the saved partitions verbatim', async () => {
    const ticket = await createTicket('Draft test ticket');
    const created = await createFeedbackDraft({
      id: 'fd_test_1',
      ticketId: ticket.id,
      parentNoteId: 'n_parent_1',
      promptText: 'How are you? What time is it?',
      partitions: samplePartitions,
    });
    expect(created.id).toBe('fd_test_1');
    expect(created.ticketId).toBe(ticket.id);
    expect(created.parentNoteId).toBe('n_parent_1');
    expect(created.promptText).toBe('How are you? What time is it?');
    expect(created.partitions).toEqual(samplePartitions);

    const listed = await listFeedbackDrafts(ticket.id);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe('fd_test_1');
    expect(listed[0].partitions).toEqual(samplePartitions);
  });

  it('updates only the partitions field on PATCH and bumps updated_at', async () => {
    const ticket = await createTicket('Draft update ticket');
    const original = await createFeedbackDraft({
      id: 'fd_update_1',
      ticketId: ticket.id,
      parentNoteId: 'n_parent_2',
      promptText: 'Original prompt',
      partitions: samplePartitions,
    });

    // Wait a moment so updated_at can change.
    await new Promise(resolve => setTimeout(resolve, 10));

    const newPartitions = {
      blocks: samplePartitions.blocks,
      inlineResponses: [
        { blockIndex: 0, text: 'Updated answer' },
        { blockIndex: 1, text: 'Now in second block' },
      ],
      catchAll: 'New catch-all text',
    };
    const updated = await updateFeedbackDraft('fd_update_1', newPartitions);
    expect(updated).not.toBeNull();
    expect(updated!.partitions).toEqual(newPartitions);
    // Prompt text + parent note id are NOT changed by PATCH.
    expect(updated!.promptText).toBe('Original prompt');
    expect(updated!.parentNoteId).toBe('n_parent_2');
    // updated_at advances; created_at does not.
    expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(original.updatedAt).getTime());
    expect(new Date(updated!.createdAt).getTime()).toBe(new Date(original.createdAt).getTime());
  });

  it('returns null on PATCH for a missing draft id', async () => {
    const result = await updateFeedbackDraft('fd_missing', samplePartitions);
    expect(result).toBeNull();
  });

  it('deletes a draft and removes it from the listing', async () => {
    const ticket = await createTicket('Draft delete ticket');
    await createFeedbackDraft({
      id: 'fd_delete_1',
      ticketId: ticket.id,
      parentNoteId: null,
      promptText: 'To be deleted',
      partitions: samplePartitions,
    });
    const before = await listFeedbackDrafts(ticket.id);
    expect(before.some(d => d.id === 'fd_delete_1')).toBe(true);

    const deleted = await deleteFeedbackDraft('fd_delete_1');
    expect(deleted).toBe(true);

    const after = await listFeedbackDrafts(ticket.id);
    expect(after.some(d => d.id === 'fd_delete_1')).toBe(false);

    // Idempotent: deleting an already-deleted draft returns false.
    expect(await deleteFeedbackDraft('fd_delete_1')).toBe(false);
  });

  it('lists drafts in created-at order so the UI renders them stably', async () => {
    const ticket = await createTicket('Draft ordering ticket');
    await createFeedbackDraft({
      id: 'fd_order_a',
      ticketId: ticket.id,
      parentNoteId: 'n_a',
      promptText: 'First',
      partitions: samplePartitions,
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    await createFeedbackDraft({
      id: 'fd_order_b',
      ticketId: ticket.id,
      parentNoteId: 'n_b',
      promptText: 'Second',
      partitions: samplePartitions,
    });
    const listed = await listFeedbackDrafts(ticket.id);
    const ids = listed.map(d => d.id);
    const aIdx = ids.indexOf('fd_order_a');
    const bIdx = ids.indexOf('fd_order_b');
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThan(aIdx);
  });

  it('preserves drafts when the parent note id is null (free-floating)', async () => {
    const ticket = await createTicket('Free-floating draft ticket');
    await createFeedbackDraft({
      id: 'fd_floating_1',
      ticketId: ticket.id,
      parentNoteId: null,
      promptText: 'Original prompt that may be deleted later',
      partitions: samplePartitions,
    });
    const got = await getFeedbackDraft('fd_floating_1');
    expect(got).not.toBeNull();
    expect(got!.parentNoteId).toBeNull();
    expect(got!.promptText).toBe('Original prompt that may be deleted later');
  });

  it('cascades delete when the parent ticket is removed (FK ON DELETE CASCADE)', async () => {
    const ticket = await createTicket('Cascade test ticket');
    await createFeedbackDraft({
      id: 'fd_cascade_1',
      ticketId: ticket.id,
      parentNoteId: 'n_cascade',
      promptText: 'Cascade test',
      partitions: samplePartitions,
    });
    expect(await getFeedbackDraft('fd_cascade_1')).not.toBeNull();
    // Hard delete the ticket via the queries API; the draft should go too.
    const { hardDeleteTicket } = await import('./queries.js');
    await hardDeleteTicket(ticket.id);
    expect(await getFeedbackDraft('fd_cascade_1')).toBeNull();
  });
});
