import { describe, expect, it } from 'vitest';

import { isExactTicketIdSearch, splitSearchTerms } from './ticketNumber.js';

describe('isExactTicketIdSearch', () => {
  it('matches a complete ticket-number reference (case-insensitive, whitespace-tolerant)', () => {
    expect(isExactTicketIdSearch('HS-100')).toBe(true);
    expect(isExactTicketIdSearch('hs-100')).toBe(true);
    expect(isExactTicketIdSearch('  BUG-42  ')).toBe(true);
    expect(isExactTicketIdSearch('MIGRATION_V2-7')).toBe(true);
  });

  it('rejects partial / multi-word / non-id searches', () => {
    expect(isExactTicketIdSearch('HS-')).toBe(false);
    expect(isExactTicketIdSearch('HS-100 bug')).toBe(false);
    expect(isExactTicketIdSearch('login bug')).toBe(false);
    expect(isExactTicketIdSearch('')).toBe(false);
  });
});

describe('splitSearchTerms (HS-8646)', () => {
  it('returns a single term for a one-word search', () => {
    expect(splitSearchTerms('login')).toEqual(['login']);
  });

  it('splits a multi-word search on spaces', () => {
    expect(splitSearchTerms('login bug')).toEqual(['login', 'bug']);
  });

  it('splits on ANY whitespace run (multiple spaces, tabs, newlines)', () => {
    expect(splitSearchTerms('  login \t  bug\nflow ')).toEqual(['login', 'bug', 'flow']);
  });

  it('returns an empty array for an empty or all-whitespace search', () => {
    expect(splitSearchTerms('')).toEqual([]);
    expect(splitSearchTerms('   \t \n ')).toEqual([]);
  });

  it('preserves term case (callers lower-case as needed)', () => {
    expect(splitSearchTerms('Login BUG')).toEqual(['Login', 'BUG']);
  });
});
