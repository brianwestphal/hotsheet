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
import { toElement } from './dom.js';
import { createDraftRow, syncDraftBadge } from './draftRow.js';
import { state } from './state.js';
import { draftCategory, registerCallbacks, setDraftCategory } from './ticketListState.js';

describe('syncDraftBadge (HS-8375)', () => {
  beforeEach(() => {
    // Seed category state so `getCategoryColor` / `getCategoryLabel` can
    // resolve. The default-categories set is the same one Hot Sheet ships
    // with — six entries (issue / bug / feature / requirement_change /
    // task / investigation).
    state.categories = [...DEFAULT_CATEGORIES];
    // HS-8467 — TSX fixture instead of `innerHTML = '<html-string>'`.
    document.body.replaceChildren(toElement(
      <div className="ticket-row draft-row">
        <span className="ticket-checkbox-spacer"></span>
        <div className="draft-entry">
          <span className="ticket-category-badge" style="background-color: rgb(107, 114, 128)">ISS</span>
          <input className="ticket-title-input draft-input" type="text" />
        </div>
      </div>
    ));
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
    document.body.replaceChildren(toElement(<div className="some-other-view"></div>));
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

// Keyboard-shortcut path for changing the draft-row category while the
// user is still typing the title. Reported as: "cant change issue type
// while doing initial entry, only after submitted" — `ticketRow.tsx`
// already handled Cmd/Ctrl + <key> for existing rows, but the draft
// row's keydown listener only knew about Enter / ArrowDown, so the same
// shortcut silently did nothing pre-fix.
describe('createDraftRow keyboard shortcut (Cmd/Ctrl + <category-key>)', () => {
  beforeEach(() => {
    state.categories = [...DEFAULT_CATEGORIES];
    state.view = 'all';
    setDraftCategory(null);
    // The draft row's badge-click and shortcut paths both call
    // `callRenderTicketList()` / `callFocusDraftInput()`; register no-op
    // stubs so the call doesn't crash inside the test.
    registerCallbacks({
      renderTicketList: () => {},
      loadTickets: () => Promise.resolve(),
      updateSelectionClasses: () => {},
      updateBatchToolbar: () => {},
      updateColumnSelectionClasses: () => {},
      focusDraftInput: () => {},
    });
    document.body.replaceChildren(createDraftRow());
  });

  function pressShortcut(key: string, opts: { meta?: boolean; ctrl?: boolean; alt?: boolean } = { meta: true }): void {
    const input = document.querySelector<HTMLInputElement>('.draft-input')!;
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key, metaKey: opts.meta ?? false, ctrlKey: opts.ctrl ?? false,
      altKey: opts.alt ?? false, bubbles: true, cancelable: true,
    }));
  }

  it('switches the draft category and repaints the badge on Cmd+<key>', () => {
    const bugKey = DEFAULT_CATEGORIES.find(c => c.id === 'bug')!.shortcutKey;
    pressShortcut(bugKey, { meta: true });
    expect(draftCategory).toBe('bug');
    const badge = document.querySelector<HTMLElement>('.draft-row .ticket-category-badge')!;
    expect(badge.textContent).toBe(DEFAULT_CATEGORIES.find(c => c.id === 'bug')!.shortLabel);
  });

  it('also accepts Ctrl+<key> (for non-Mac platforms)', () => {
    const featureKey = DEFAULT_CATEGORIES.find(c => c.id === 'feature')!.shortcutKey;
    pressShortcut(featureKey, { ctrl: true });
    expect(draftCategory).toBe('feature');
  });

  it('does not change the category when no modifier is held (plain typing still works)', () => {
    const bugKey = DEFAULT_CATEGORIES.find(c => c.id === 'bug')!.shortcutKey;
    pressShortcut(bugKey, {});
    expect(draftCategory).toBeNull();
  });

  it('does not change the category when Cmd+Alt+<key> is held (avoids stomping other shortcuts)', () => {
    const bugKey = DEFAULT_CATEGORIES.find(c => c.id === 'bug')!.shortcutKey;
    pressShortcut(bugKey, { meta: true, alt: true });
    expect(draftCategory).toBeNull();
  });

  it('is a no-op in a category view (the badge is locked to match the view)', () => {
    state.view = 'category:feature';
    document.body.replaceChildren(createDraftRow());
    const bugKey = DEFAULT_CATEGORIES.find(c => c.id === 'bug')!.shortcutKey;
    pressShortcut(bugKey, { meta: true });
    expect(draftCategory).toBeNull();
  });
});

// HS-8736 — the type badge + title input are wrapped together in one
// rounded-rectangle border (`.draft-entry`) so the line reads as a single
// entry control with the type pill inside it; the decorative ○ status
// placeholder that mirrored real rows' status button is dropped.
describe('createDraftRow layout (HS-8736)', () => {
  beforeEach(() => {
    state.categories = [...DEFAULT_CATEGORIES];
    state.view = 'all';
    setDraftCategory(null);
    registerCallbacks({
      renderTicketList: () => {},
      loadTickets: () => Promise.resolve(),
      updateSelectionClasses: () => {},
      updateBatchToolbar: () => {},
      updateColumnSelectionClasses: () => {},
      focusDraftInput: () => {},
    });
    document.body.replaceChildren(createDraftRow());
  });

  it('wraps the type badge and the title input together inside .draft-entry', () => {
    const entry = document.querySelector<HTMLElement>('.draft-row .draft-entry')!;
    expect(entry).not.toBeNull();
    expect(entry.querySelector('.ticket-category-badge')).not.toBeNull();
    expect(entry.querySelector('.draft-input')).not.toBeNull();
  });

  it('drops the decorative ○ status placeholder from the new-ticket line', () => {
    const row = document.querySelector<HTMLElement>('.draft-row')!;
    expect(row.querySelector('.ticket-status-btn')).toBeNull();
    expect(row.textContent).not.toContain('○');
  });

  it('keeps the priority/star placeholders outside the bordered entry', () => {
    const entry = document.querySelector<HTMLElement>('.draft-row .draft-entry')!;
    expect(entry.querySelector('.ticket-priority-indicator')).toBeNull();
    expect(entry.querySelector('.ticket-star')).toBeNull();
    expect(document.querySelector('.draft-row > .ticket-priority-indicator')).not.toBeNull();
    expect(document.querySelector('.draft-row > .ticket-star')).not.toBeNull();
  });
});
