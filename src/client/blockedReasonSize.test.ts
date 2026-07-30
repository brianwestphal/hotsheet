// @vitest-environment happy-dom
// HS-9516 (docs/116) — the blocked-reason editor's height tracks whether it is in use.
//
// It shipped at a fixed 2 rows: taller than nothing when empty, shorter than Details when
// full — backwards, since a blocked reason is the rare case and Details is the common one.

import { beforeEach, describe, expect, it } from 'vitest';

import { syncBlockedReasonSize } from './blockedReasonSize.js';

// `rows` is typed `number` and IS one in a browser, but happy-dom hands back a string.
// Assertions compare via String() so they hold in both, without the production code
// carrying a coercion that exists only to satisfy the test environment.

let blocked: HTMLTextAreaElement;
let details: HTMLTextAreaElement;

beforeEach(() => {
  document.body.innerHTML = '<textarea id="b"></textarea><textarea id="d" rows="6"></textarea>';
  blocked = document.getElementById('b') as HTMLTextAreaElement;
  details = document.getElementById('d') as HTMLTextAreaElement;
});

describe('syncBlockedReasonSize', () => {
  it('collapses to one row when empty', () => {
    blocked.value = '';
    syncBlockedReasonSize(blocked, details);
    expect(String(blocked.rows)).toBe('1');
  });

  it("expands to the Details textarea's height once it has content", () => {
    blocked.value = 'waiting on HS-1234';
    syncBlockedReasonSize(blocked, details);
    expect(String(blocked.rows)).toBe('6');
  });

  it('MATCHES Details rather than hard-coding 6', () => {
    // The requirement is "the same height as details". A literal would silently stop
    // matching the moment Details is resized — and both fields would still look fine
    // individually, which is why this is asserted against a non-default value.
    details.rows = 9;
    blocked.value = 'blocked';
    syncBlockedReasonSize(blocked, details);
    expect(String(blocked.rows)).toBe('9');
  });

  it('treats whitespace-only as empty', () => {
    // A stray space shouldn't leave the field expanded when it reads as blank and counts
    // as unblocked everywhere else (docs/116 — non-empty is what marks a ticket blocked).
    blocked.value = '   \n  ';
    syncBlockedReasonSize(blocked, details);
    expect(String(blocked.rows)).toBe('1');
  });

  it('falls back to 6 when Details is absent, instead of collapsing or throwing', () => {
    blocked.value = 'blocked';
    syncBlockedReasonSize(blocked, null);
    expect(String(blocked.rows)).toBe('6');
  });

  it('is a no-op for a missing blocked field', () => {
    expect(() => { syncBlockedReasonSize(null, details); }).not.toThrow();
  });

  // The behavior that matters in use: typing expands, clearing collapses again. Each
  // direction passes in isolation; a one-way implementation would too.
  it('round-trips as the user types and clears', () => {
    syncBlockedReasonSize(blocked, details);
    expect(String(blocked.rows)).toBe('1');

    blocked.value = 'w';
    syncBlockedReasonSize(blocked, details);
    expect(String(blocked.rows)).toBe('6');

    blocked.value = '';
    syncBlockedReasonSize(blocked, details);
    expect(String(blocked.rows)).toBe('1');
  });
});
