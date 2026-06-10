// @vitest-environment happy-dom
// HS-8511 — the pure DOM half of the sidebar count badges: distributing a
// `viewId → count` map onto the rendered `.sidebar-item[data-view]` rows.
import { beforeEach, describe, expect, it } from 'vitest';

import { toElement } from './dom.js';
import { applySidebarCounts } from './sidebarCounts.js';

function sidebar(views: string[]): void {
  document.body.replaceChildren(
    toElement(
      <div className="sidebar">
        {views.map(v => <button className="sidebar-item" data-view={v}>{v}</button>)}
      </div>,
    ),
  );
}

function badgeText(view: string): string | null {
  const badge = document.querySelector<HTMLElement>(`.sidebar-item[data-view="${view}"] .sidebar-count`);
  return badge?.textContent ?? null;
}

describe('applySidebarCounts (HS-8511)', () => {
  beforeEach(() => { document.body.replaceChildren(); });

  it('writes a count badge into each sidebar item', () => {
    sidebar(['open', 'completed', 'category:bug', 'custom:cv1']);
    applySidebarCounts({ open: 5, completed: 3, 'category:bug': 2, 'custom:cv1': 7 });
    expect(badgeText('open')).toBe('5');
    expect(badgeText('completed')).toBe('3');
    expect(badgeText('category:bug')).toBe('2');
    expect(badgeText('custom:cv1')).toBe('7');
  });

  it('renders an empty, is-zero badge for a zero or absent count (no "0")', () => {
    sidebar(['open', 'archive']);
    applySidebarCounts({ open: 4 }); // archive absent → treated as 0
    expect(badgeText('open')).toBe('4');
    expect(badgeText('archive')).toBe('');
    const archiveBadge = document.querySelector('.sidebar-item[data-view="archive"] .sidebar-count');
    expect(archiveBadge?.classList.contains('is-zero')).toBe(true);
    const openBadge = document.querySelector('.sidebar-item[data-view="open"] .sidebar-count');
    expect(openBadge?.classList.contains('is-zero')).toBe(false);
  });

  it('reuses the existing badge on a re-apply (no duplicate badges)', () => {
    sidebar(['open']);
    applySidebarCounts({ open: 1 });
    applySidebarCounts({ open: 9 });
    const badges = document.querySelectorAll('.sidebar-item[data-view="open"] .sidebar-count');
    expect(badges.length).toBe(1);
    expect(badgeText('open')).toBe('9');
  });
});
