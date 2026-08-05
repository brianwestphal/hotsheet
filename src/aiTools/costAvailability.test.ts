/**
 * HS-9605 — deciding whether a window's cost figure can be believed.
 *
 * The whole point is that a MISSING number must not look like a ZERO. Codex
 * reports no cost at all, so once its telemetry arrives every cost surface would
 * otherwise render `$0.00` — "this work was free" — which is a stronger and more
 * wrong claim than "we don't know".
 */
import { describe, expect, it } from 'vitest';

import { costAvailabilityFor, costAvailabilityNote } from './costAvailability.js';

describe('costAvailabilityFor (HS-9605)', () => {
  it('is available for Claude alone — the common case must not regress', () => {
    expect(costAvailabilityFor(['claude'])).toEqual({ status: 'available' });
  });

  it('is unavailable for codex alone', () => {
    expect(costAvailabilityFor(['codex'])).toEqual({ status: 'unavailable', toolsWithoutCost: ['codex'] });
  });

  it('is PARTIAL for a mixed window — the dangerous case', () => {
    // The figure is real and correctly computed, and it silently omits every
    // codex turn. An unqualified total here under-reports while looking normal,
    // which is more misleading than a blank.
    expect(costAvailabilityFor(['claude', 'codex'])).toEqual({
      status: 'partial', toolsWithoutCost: ['codex'],
    });
  });

  it('is available for an EMPTY window rather than warning about nothing', () => {
    // No cost to misreport, so the existing empty state renders unchanged
    // instead of sprouting a warning about tools that were never involved.
    expect(costAvailabilityFor([])).toEqual({ status: 'available' });
  });

  it('treats an UNRECOGNIZED emitter as not reporting cost', () => {
    // Fails toward honesty: we cannot know that it reported cost, and the point
    // of this module is to stop asserting cost we do not have.
    expect(costAvailabilityFor(['unknown']).status).toBe('unavailable');
    expect(costAvailabilityFor(['claude', 'unknown']).status).toBe('partial');
  });
});

describe('costAvailabilityNote (HS-9605)', () => {
  it('says nothing when there is nothing to explain', () => {
    expect(costAvailabilityNote({ status: 'available' })).toBeNull();
  });

  it('names the tool and what it means — a bare dash reads as a bug', () => {
    const note = costAvailabilityNote(costAvailabilityFor(['codex']));
    expect(note).toContain('Codex');
    expect(note).toMatch(/does not report cost/);
  });

  it('gives the DIRECTION of the error for a partial window', () => {
    // A reader deciding whether to trust a number needs to know it is an
    // under-count, not merely that it is "incomplete".
    const note = costAvailabilityNote(costAvailabilityFor(['claude', 'codex']));
    expect(note).toContain('Codex');
    expect(note).toMatch(/higher/);
  });

  it('names an unrecognized emitter by its id rather than dropping it', () => {
    expect(costAvailabilityNote(costAvailabilityFor(['mystery-tool']))).toContain('mystery-tool');
  });
});
