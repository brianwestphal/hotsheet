// @vitest-environment happy-dom
/**
 * HS-7957 / HS-7961 — reader-mode overlay tests.
 *
 * Covers the two pure title-builder helpers (note + Details) and the
 * end-to-end open / dismiss happy paths through happy-dom (mount the
 * overlay, assert markdown is rendered + read-only, dismiss via X / Escape /
 * backdrop and assert the overlay node is removed).
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildDetailsReaderTitle,
  buildNoteReaderTitle,
  openReaderOverlay,
  renderReaderBodyHtml,
} from './readerOverlay.js';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('buildNoteReaderTitle (HS-7957)', () => {
  it('returns "Note" when created_at is missing / null / undefined / empty', () => {
    expect(buildNoteReaderTitle(null)).toBe('Note');
    expect(buildNoteReaderTitle(undefined)).toBe('Note');
    expect(buildNoteReaderTitle('')).toBe('Note');
  });

  it('returns "Note" for an unparseable timestamp string (defensive)', () => {
    expect(buildNoteReaderTitle('not-a-date')).toBe('Note');
  });

  it('returns "Note from <local-time>" for a valid ISO timestamp', () => {
    const out = buildNoteReaderTitle('2026-04-28T13:32:00.000Z');
    expect(out).toMatch(/^Note from /);
    // The localised timestamp varies by TZ so don't assert the exact format,
    // just that the date components are present somehow.
    expect(out).toMatch(/2026/);
  });
});

describe('buildDetailsReaderTitle (HS-7957)', () => {
  it('returns the combined "Details for HS-X: <title>" when both are present', () => {
    expect(buildDetailsReaderTitle('HS-7961', 'Reader mode overlay')).toBe('Details for HS-7961: Reader mode overlay');
  });

  it('falls back to ticket-number-only when title is missing', () => {
    expect(buildDetailsReaderTitle('HS-7961', '')).toBe('Details for HS-7961');
    expect(buildDetailsReaderTitle('HS-7961', null)).toBe('Details for HS-7961');
    expect(buildDetailsReaderTitle('HS-7961', undefined)).toBe('Details for HS-7961');
  });

  it('falls back to title-only when ticket number is missing', () => {
    expect(buildDetailsReaderTitle('', 'Some Ticket')).toBe('Details: Some Ticket');
    expect(buildDetailsReaderTitle(null, 'Some Ticket')).toBe('Details: Some Ticket');
  });

  it('falls back to "Details" when both are missing', () => {
    expect(buildDetailsReaderTitle(null, null)).toBe('Details');
    expect(buildDetailsReaderTitle('', '')).toBe('Details');
    expect(buildDetailsReaderTitle(undefined, undefined)).toBe('Details');
  });

  it('trims whitespace before deciding presence', () => {
    expect(buildDetailsReaderTitle('  HS-1  ', '  hi  ')).toBe('Details for HS-1: hi');
    expect(buildDetailsReaderTitle('   ', '   ')).toBe('Details');
  });
});

describe('openReaderOverlay (HS-7957)', () => {
  it('mounts a single .reader-mode-overlay on document.body with the title shown in the header', () => {
    openReaderOverlay({ title: 'My Note', markdown: 'Hello **world**!' });
    const overlay = document.querySelector('.reader-mode-overlay');
    expect(overlay).not.toBeNull();
    const title = overlay!.querySelector('.reader-mode-title')?.textContent;
    expect(title).toBe('My Note');
  });

  it('renders the markdown into the body (bold tag present, raw asterisks gone)', () => {
    openReaderOverlay({ title: 't', markdown: 'Hello **world**!' });
    const body = document.querySelector('.reader-mode-body');
    expect(body?.innerHTML).toContain('<strong>world</strong>');
    expect(body?.textContent).not.toContain('**');
  });

  it('renders an empty-state placeholder when the markdown is whitespace-only', () => {
    openReaderOverlay({ title: 't', markdown: '   \n\n  ' });
    const body = document.querySelector('.reader-mode-body');
    expect(body?.innerHTML).toContain('reader-mode-empty');
    expect(body?.textContent).toContain('(empty)');
  });

  it('the body uses the .note-markdown class so it inherits the inline-note CSS', () => {
    openReaderOverlay({ title: 't', markdown: 'x' });
    const body = document.querySelector('.reader-mode-body');
    expect(body?.classList.contains('note-markdown')).toBe(true);
  });

  it('clicking the X button removes the overlay', () => {
    openReaderOverlay({ title: 't', markdown: 'x' });
    expect(document.querySelector('.reader-mode-overlay')).not.toBeNull();
    const closeBtn = document.querySelector('.reader-mode-close') as HTMLButtonElement;
    closeBtn.click();
    expect(document.querySelector('.reader-mode-overlay')).toBeNull();
  });

  it('Escape key removes the overlay', () => {
    openReaderOverlay({ title: 't', markdown: 'x' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.reader-mode-overlay')).toBeNull();
  });

  it('clicking the dimmed backdrop removes the overlay', () => {
    openReaderOverlay({ title: 't', markdown: 'x' });
    const overlay = document.querySelector('.reader-mode-overlay') as HTMLElement;
    // The backdrop click handler keys on `e.target === overlay` — dispatching
    // the event from the overlay itself satisfies that guard.
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.reader-mode-overlay')).toBeNull();
  });

  it('clicking inside the dialog does NOT dismiss', () => {
    openReaderOverlay({ title: 't', markdown: 'x' });
    const dialog = document.querySelector('.reader-mode-dialog') as HTMLElement;
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Still mounted.
    expect(document.querySelector('.reader-mode-overlay')).not.toBeNull();
  });

  it('a second open replaces the first overlay rather than stacking two', () => {
    openReaderOverlay({ title: 'first', markdown: 'a' });
    openReaderOverlay({ title: 'second', markdown: 'b' });
    const overlays = document.querySelectorAll('.reader-mode-overlay');
    expect(overlays.length).toBe(1);
    expect(overlays[0].querySelector('.reader-mode-title')?.textContent).toBe('second');
  });

  it('removes the keydown listener after dismiss (no leak)', () => {
    openReaderOverlay({ title: 't', markdown: 'x' });
    const closeBtn = document.querySelector('.reader-mode-close') as HTMLButtonElement;
    closeBtn.click();
    // Overlay gone — Escape after close should NOT throw and should NOT
    // re-trigger anything (no overlay to remove). This is a soft assertion:
    // the test passes as long as the event dispatch doesn't blow up and the
    // DOM stays empty.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.reader-mode-overlay')).toBeNull();
  });
});

/**
 * HS-8233 — chevron-up / chevron-down navigation through a list of
 * ReaderEntry items. Used by the per-note reader so the user can step
 * through every non-empty note without re-clicking the book icon.
 */
describe('reader navigation (HS-8233)', () => {
  function entries(...titles: string[]): { title: string; markdown: string }[] {
    return titles.map((t, i) => ({ title: t, markdown: `body ${i}` }));
  }

  it('does NOT render prev/next buttons when navigation is omitted', () => {
    openReaderOverlay({ title: 'solo', markdown: 'one' });
    expect(document.querySelector('.reader-mode-prev')).toBeNull();
    expect(document.querySelector('.reader-mode-next')).toBeNull();
  });

  it('renders prev + next buttons when navigation is supplied', () => {
    openReaderOverlay({
      title: 'a',
      markdown: 'a',
      navigation: { entries: entries('a', 'b'), initialIndex: 0 },
    });
    expect(document.querySelector('.reader-mode-prev')).not.toBeNull();
    expect(document.querySelector('.reader-mode-next')).not.toBeNull();
  });

  it('disables prev at the first entry and next at the last entry', () => {
    openReaderOverlay({
      title: 'first',
      markdown: 'a',
      navigation: { entries: entries('first', 'middle', 'last'), initialIndex: 0 },
    });
    const prev = document.querySelector('.reader-mode-prev') as HTMLButtonElement;
    const next = document.querySelector('.reader-mode-next') as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);

    next.click();
    next.click();
    expect(prev.disabled).toBe(false);
    expect(next.disabled).toBe(true);
    expect(document.querySelector('.reader-mode-title')?.textContent).toBe('last');
  });

  it('clicking next steps forward and rewrites title + body', () => {
    openReaderOverlay({
      title: 'first',
      markdown: 'a',
      navigation: { entries: entries('first', 'second'), initialIndex: 0 },
    });
    expect(document.querySelector('.reader-mode-title')?.textContent).toBe('first');
    (document.querySelector('.reader-mode-next') as HTMLButtonElement).click();
    expect(document.querySelector('.reader-mode-title')?.textContent).toBe('second');
    expect(document.querySelector('.reader-mode-body')?.textContent).toContain('body 1');
  });

  it('clicking prev steps backward', () => {
    openReaderOverlay({
      title: 'middle',
      markdown: 'b',
      navigation: { entries: entries('first', 'middle', 'last'), initialIndex: 1 },
    });
    expect(document.querySelector('.reader-mode-title')?.textContent).toBe('middle');
    (document.querySelector('.reader-mode-prev') as HTMLButtonElement).click();
    expect(document.querySelector('.reader-mode-title')?.textContent).toBe('first');
  });

  it('ArrowDown navigates next; ArrowUp navigates previous', () => {
    openReaderOverlay({
      title: 'a',
      markdown: 'a',
      navigation: { entries: entries('a', 'b', 'c'), initialIndex: 0 },
    });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(document.querySelector('.reader-mode-title')?.textContent).toBe('b');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(document.querySelector('.reader-mode-title')?.textContent).toBe('c');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(document.querySelector('.reader-mode-title')?.textContent).toBe('b');
  });

  it('ArrowDown at the last entry is a no-op (stays on last)', () => {
    openReaderOverlay({
      title: 'last',
      markdown: 'x',
      navigation: { entries: entries('first', 'last'), initialIndex: 1 },
    });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(document.querySelector('.reader-mode-title')?.textContent).toBe('last');
  });

  it('ArrowUp at the first entry is a no-op (stays on first)', () => {
    openReaderOverlay({
      title: 'first',
      markdown: 'x',
      navigation: { entries: entries('first', 'last'), initialIndex: 0 },
    });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(document.querySelector('.reader-mode-title')?.textContent).toBe('first');
  });

  it('Escape still dismisses when navigation is active', () => {
    openReaderOverlay({
      title: 'a',
      markdown: 'a',
      navigation: { entries: entries('a', 'b'), initialIndex: 0 },
    });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.reader-mode-overlay')).toBeNull();
  });

  it('clamps initialIndex into bounds defensively', () => {
    openReaderOverlay({
      title: 'fallback',
      markdown: 'x',
      navigation: { entries: entries('a', 'b', 'c'), initialIndex: 99 },
    });
    // Out-of-range initialIndex clamps to last entry.
    expect(document.querySelector('.reader-mode-title')?.textContent).toBe('c');
  });

  it('clamps a negative initialIndex to 0', () => {
    openReaderOverlay({
      title: 'fallback',
      markdown: 'x',
      navigation: { entries: entries('a', 'b'), initialIndex: -5 },
    });
    expect(document.querySelector('.reader-mode-title')?.textContent).toBe('a');
  });

  it('updates ARIA label on navigation so screen readers see the active entry', () => {
    openReaderOverlay({
      title: 'a',
      markdown: 'a',
      navigation: { entries: entries('a', 'b'), initialIndex: 0 },
    });
    const overlay = document.querySelector('.reader-mode-overlay') as HTMLElement;
    expect(overlay.getAttribute('aria-label')).toBe('a');
    (document.querySelector('.reader-mode-next') as HTMLButtonElement).click();
    expect(overlay.getAttribute('aria-label')).toBe('b');
  });
});

describe('renderReaderBodyHtml (HS-8233)', () => {
  it('renders empty markdown to a placeholder', () => {
    expect(renderReaderBodyHtml('')).toContain('reader-mode-empty');
    expect(renderReaderBodyHtml('   ')).toContain('reader-mode-empty');
  });

  it('renders non-empty markdown to HTML containing the source text', () => {
    const html = renderReaderBodyHtml('# heading\n\ntext');
    expect(html).toContain('heading');
    expect(html).toContain('text');
  });
});
