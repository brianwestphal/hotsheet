// @vitest-environment happy-dom
//
// HS-8375 — `syncDraftBadge` repaints the draft row's category badge in
// place after a type-dropdown selection. Pre-fix, the dropdown action
// called `callRenderTicketList()` expecting the full list re-render to
// rebuild the draft row with the new category — but after the HS-833x
// bindList refactor the draft row is mount-once, so `renderTicketList`
// no longer touches it. The user-visible symptom was the type button
// remaining on the original "ISS" badge after they picked Bug / Feature /
// etc. from the dropdown.
import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CATEGORIES } from '../types.js';
import { syncDraftBadge } from './draftRow.js';
import { state } from './state.js';

describe('syncDraftBadge (HS-8375)', () => {
  beforeEach(() => {
    // Seed category state so `getCategoryColor` / `getCategoryLabel` can
    // resolve. The default-categories set is the same one Hot Sheet ships
    // with — six entries (issue / bug / feature / requirement_change /
    // task / investigation).
    state.categories = [...DEFAULT_CATEGORIES];
    document.body.innerHTML = `
      <div class="ticket-row draft-row">
        <span class="ticket-checkbox-spacer"></span>
        <span class="ticket-status-btn"></span>
        <span class="ticket-category-badge" style="background-color: rgb(107, 114, 128)">ISS</span>
        <input class="ticket-title-input draft-input" type="text" />
      </div>
    `;
  });

  it('repaints the badge label and color when the category changes (issue → bug)', () => {
    syncDraftBadge('bug');
    const badge = document.querySelector<HTMLElement>('.draft-row .ticket-category-badge')!;
    expect(badge.textContent).toBe('BUG');
    // The default bug color is `#ef4444`; surface check rather than exact
    // hex so a future theme tweak to that one color doesn't fail the test.
    expect(badge.style.backgroundColor).not.toBe('');
    expect(badge.style.backgroundColor).not.toBe('rgb(107, 114, 128)');
  });

  it('uses the configured short label for built-in categories', () => {
    syncDraftBadge('feature');
    const badge = document.querySelector<HTMLElement>('.draft-row .ticket-category-badge')!;
    expect(badge.textContent).toBe(DEFAULT_CATEGORIES.find(c => c.id === 'feature')!.shortLabel);
  });

  it('falls back to the uppercased prefix for unknown categories', () => {
    // Mirrors `getCategoryLabel`'s fallback path. Defensive: a user with
    // a malformed `categories` setting picking something off the dropdown
    // shouldn't crash the badge update.
    syncDraftBadge('custom-thing');
    const badge = document.querySelector<HTMLElement>('.draft-row .ticket-category-badge')!;
    expect(badge.textContent).toBe('CUS');
  });

  it('is a no-op when no draft row is mounted', () => {
    document.body.innerHTML = '<div class="some-other-view"></div>';
    expect(() => { syncDraftBadge('bug'); }).not.toThrow();
  });

  it('updates an already-painted badge a second time (idempotent for the same value, switches for a new value)', () => {
    syncDraftBadge('bug');
    const badge = document.querySelector<HTMLElement>('.draft-row .ticket-category-badge')!;
    const firstColor = badge.style.backgroundColor;
    syncDraftBadge('bug');
    expect(badge.style.backgroundColor).toBe(firstColor);
    syncDraftBadge('task');
    expect(badge.textContent).toBe(DEFAULT_CATEGORIES.find(c => c.id === 'task')!.shortLabel);
    expect(badge.style.backgroundColor).not.toBe(firstColor);
  });
});
