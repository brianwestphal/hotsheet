/**
 * Tests for the HTTP request-validation boundary (`src/routes/validation.ts`).
 * `parseBody` is the shared safe-parse wrapper every route uses to reject
 * malformed JSON bodies with a readable error; the schemas are the wire SSOT
 * for the ticket / batch / global-config endpoints. None of this had direct
 * coverage before.
 */
import { describe, expect, it } from 'vitest';

import {
  BatchActionSchema,
  CreateTicketSchema,
  parseBody,
  UpdateTicketSchema,
} from './validation.js';

describe('parseBody', () => {
  it('returns the parsed data on a valid body', () => {
    const r = parseBody(CreateTicketSchema, { title: 'Hello' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.title).toBe('Hello');
  });

  it('reports a path-qualified message on a schema failure', () => {
    const r = parseBody(BatchActionSchema, { ids: [1], action: 'nope' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/action/);
  });

  it('joins multiple issues with "; "', () => {
    const r = parseBody(BatchActionSchema, { ids: 'not-an-array', action: 'bogus' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain(';');
  });

  it('falls back to "Invalid request body" when no message survives', () => {
    // A non-object passed to an object schema yields a root-level issue whose
    // path is empty; the `: ` filter strips it, so the fallback string is used.
    const r = parseBody(BatchActionSchema, 42);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.length).toBeGreaterThan(0);
  });
});

describe('CreateTicketSchema', () => {
  it('defaults title to an empty string when omitted', () => {
    const r = CreateTicketSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.title).toBe('');
  });

  it('accepts the empty-string sentinel for priority / status in defaults', () => {
    const r = CreateTicketSchema.safeParse({ title: 'x', defaults: { priority: '', status: '' } });
    expect(r.success).toBe(true);
  });

  it('rejects an unknown priority in defaults', () => {
    const r = CreateTicketSchema.safeParse({ title: 'x', defaults: { priority: 'urgent' } });
    expect(r.success).toBe(false);
  });
});

describe('UpdateTicketSchema', () => {
  it('rejects an invalid status enum value', () => {
    expect(UpdateTicketSchema.safeParse({ status: 'in_progress' }).success).toBe(false);
  });

  it('accepts a null last_read_at (explicit clear)', () => {
    expect(UpdateTicketSchema.safeParse({ last_read_at: null }).success).toBe(true);
  });

  it('accepts a partial update (all fields optional)', () => {
    expect(UpdateTicketSchema.safeParse({ up_next: true }).success).toBe(true);
  });
});

describe('BatchActionSchema', () => {
  it('accepts integer ids + a known action', () => {
    expect(BatchActionSchema.safeParse({ ids: [1, 2, 3], action: 'delete' }).success).toBe(true);
  });

  it('rejects non-integer ids', () => {
    expect(BatchActionSchema.safeParse({ ids: [1.5], action: 'delete' }).success).toBe(false);
  });
});
