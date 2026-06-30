// @vitest-environment happy-dom
/**
 * HS-9216 / HS-9215 — guard the Views-tab row action buttons:
 *   - HS-9216: the action buttons render in ONE canonical order across the
 *     settings editors — reset → edit → hide/show → delete → move (transfer last).
 *   - HS-9215: the buttons reuse the shared `.cmd-outline-*-btn` classes (which
 *     carry the standalone icon-button style), so the Views tab styles identically
 *     to the command editor instead of falling back to the default darker/tighter
 *     button look.
 *
 * Without this, a reorder of the `addBtn(...)` calls (order) or a switch to a
 * bespoke button class (styling) would silently regress the consistency the
 * tickets fixed.
 */
import { describe, expect, it } from 'vitest';

import { renderViewsTabRow } from './customViews.js';
import type { CustomView } from './state.js';

const view: CustomView = { id: 'v1', name: 'My View', logic: 'all', conditions: [] };

/** Action button "roles" in DOM order, derived from each button's title. */
function actionRoles(row: HTMLElement): string[] {
  const btns = Array.from(row.querySelectorAll<HTMLButtonElement>('.settings-view-actions button'));
  return btns.map((b) => {
    const t = (b.getAttribute('title') ?? '').toLowerCase();
    if (t.startsWith('reset')) return 'reset';
    if (t.startsWith('edit')) return 'edit';
    if (t.startsWith('hide')) return 'hide';
    if (t.startsWith('unhide')) return 'show';
    if (t.startsWith('delete')) return 'delete';
    if (t.startsWith('move')) return 'move';
    return `?(${t})`;
  });
}

describe('Views-tab row action order (HS-9216)', () => {
  it('local view: edit → delete → move', () => {
    expect(actionRoles(renderViewsTabRow(view, 'local', false, 'local'))).toEqual(['edit', 'delete', 'move']);
  });

  it('shared view in Shared mode: edit → delete → move', () => {
    expect(actionRoles(renderViewsTabRow(view, 'shared', false, 'shared'))).toEqual(['edit', 'delete', 'move']);
  });

  it('shared view in Local mode (visible): edit → hide → move (no delete)', () => {
    expect(actionRoles(renderViewsTabRow(view, 'shared', false, 'local'))).toEqual(['edit', 'hide', 'move']);
  });

  it('shared view in Local mode (hidden): edit → show → move', () => {
    expect(actionRoles(renderViewsTabRow(view, 'shared', true, 'local'))).toEqual(['edit', 'show', 'move']);
  });
});

describe('Views-tab row action styling consistency (HS-9215)', () => {
  it('every action button uses a shared .cmd-outline-*-btn / .scope-reset-btn class', () => {
    const row = renderViewsTabRow(view, 'local', false, 'local');
    const btns = Array.from(row.querySelectorAll<HTMLButtonElement>('.settings-view-actions button'));
    expect(btns.length).toBeGreaterThan(0);
    for (const b of btns) {
      const cls = b.className;
      const shared = ['cmd-outline-edit-btn', 'cmd-outline-delete-btn', 'cmd-outline-move-btn', 'scope-reset-btn'].some((c) => cls.includes(c));
      expect(shared, `button "${b.getAttribute('title')}" has classes "${cls}"`).toBe(true);
    }
  });

  it('the delete button carries the dedicated delete class', () => {
    const row = renderViewsTabRow(view, 'local', false, 'local');
    const del = row.querySelector<HTMLButtonElement>('.settings-view-actions button[title^="Delete"]');
    expect(del?.classList.contains('cmd-outline-delete-btn')).toBe(true);
  });
});
