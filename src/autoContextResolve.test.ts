/**
 * HS-9596 — the auto-context match rule, tested directly.
 *
 * It was inline in `formatTicket`, so its only coverage was through rendered
 * markdown — which meant the three subtleties below were asserted incidentally,
 * as substrings of a document, rather than as the rule they are. They are the
 * reason this is one shared function instead of a second implementation at each
 * new call site (HS-9593 adds several).
 */
import { describe, expect, it } from 'vitest';

import { resolveTicketAutoContext } from './autoContextResolve.js';
import type { AutoContextEntry } from './schemas.js';

const cat = (key: string, text: string): AutoContextEntry => ({ type: 'category', key, text });
const tag = (key: string, text: string): AutoContextEntry => ({ type: 'tag', key, text });

/** A ticket as the DB hands it over: `tags` is a JSON array STRING. */
const ticket = (category: string, tags?: string[]) =>
  ({ category, tags: tags === undefined ? undefined : JSON.stringify(tags) });

describe('resolveTicketAutoContext (HS-9596)', () => {
  it('returns the matching category entry', () => {
    const out = resolveTicketAutoContext(ticket('bug'), [cat('bug', 'Reproduce first.'), cat('feature', 'Design first.')]);
    expect(out).toEqual([{ source: 'category', key: 'bug', text: 'Reproduce first.' }]);
  });

  it('returns matching tag entries', () => {
    const out = resolveTicketAutoContext(ticket('task', ['urgent']), [tag('urgent', 'Drop everything.')]);
    expect(out).toEqual([{ source: 'tag', key: 'urgent', text: 'Drop everything.' }]);
  });

  it('CONCATENATES category and tags — neither suppresses the other', () => {
    // Precedence is not override. Both apply, category first.
    const out = resolveTicketAutoContext(ticket('bug', ['urgent']), [
      tag('urgent', 'TAG'),
      cat('bug', 'CATEGORY'),
    ]);
    expect(out.map(p => p.text)).toEqual(['CATEGORY', 'TAG']);
  });

  it('orders tags alphabetically by KEY, not by settings order or ticket order', () => {
    const out = resolveTicketAutoContext(ticket('task', ['zebra', 'alpha', 'middle']), [
      tag('zebra', 'Z'), tag('middle', 'M'), tag('alpha', 'A'),
    ]);
    expect(out.map(p => p.key)).toEqual(['alpha', 'middle', 'zebra']);
  });

  it('matches tags case-insensitively', () => {
    const out = resolveTicketAutoContext(ticket('task', ['URGENT']), [tag('urgent', 'text')]);
    expect(out).toHaveLength(1);
  });

  it('matches the CATEGORY case-SENSITIVELY — the two rules differ', () => {
    // Deliberately asymmetric, and worth pinning: categories are ids, tags are
    // free text the user types at any casing.
    expect(resolveTicketAutoContext(ticket('Bug'), [cat('bug', 'text')])).toEqual([]);
  });

  it('drops empty-text entries — an empty override is a SUPPRESSION (HS-9247)', () => {
    // An explicit empty-text entry exists to cancel a built-in default. Emitting
    // it would prepend blank lines to the ticket's details.
    const out = resolveTicketAutoContext(ticket('bug', ['urgent']), [
      cat('bug', '   '),
      tag('urgent', ''),
    ]);
    expect(out).toEqual([]);
  });

  it('returns nothing when no entry matches', () => {
    expect(resolveTicketAutoContext(ticket('feature', ['nope']), [cat('bug', 'B'), tag('urgent', 'U')])).toEqual([]);
  });

  it('handles a ticket with no tags, and with malformed tags', () => {
    // `tags` is a raw DB column; a legacy/garbled value must not throw on a
    // request path.
    expect(resolveTicketAutoContext(ticket('bug'), [cat('bug', 'B')])).toHaveLength(1);
    expect(resolveTicketAutoContext({ category: 'bug', tags: 'not json' }, [cat('bug', 'B')])).toHaveLength(1);
    expect(resolveTicketAutoContext({ category: 'bug', tags: 42 }, [cat('bug', 'B')])).toHaveLength(1);
  });

  it('keeps provenance, which the markdown rendering throws away', () => {
    // The reason this returns a structured list: a consumer should be able to
    // say WHERE a block came from without re-deriving the match.
    const out = resolveTicketAutoContext(ticket('bug', ['urgent']), [cat('bug', 'C'), tag('urgent', 'T')]);
    expect(out).toEqual([
      { source: 'category', key: 'bug', text: 'C' },
      { source: 'tag', key: 'urgent', text: 'T' },
    ]);
    // …and the markdown builder's exact rendering is still one line away.
    expect(out.map(p => p.text).join('\n\n')).toBe('C\n\nT');
  });

  it('is pure — the same inputs twice give equal, independent results', () => {
    const entries = [cat('bug', 'C'), tag('urgent', 'T')];
    const t = ticket('bug', ['urgent']);
    const a = resolveTicketAutoContext(t, entries);
    const b = resolveTicketAutoContext(t, entries);
    expect(a).toEqual(b);
    a[0].text = 'mutated';
    expect(resolveTicketAutoContext(t, entries)[0].text, 'entries must not be aliased into the result').toBe('C');
  });
});
