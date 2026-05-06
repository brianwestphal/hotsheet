import './markdownSetup.js';

import { marked } from 'marked';

import { raw } from '../jsx-runtime.js';
import { byIdOrNull, requireChild, toElement } from './dom.js';
import { linkifyWithCachedPrefixes } from './ticketRefs.js';

/**
 * HS-7957 / HS-7961 — almost-full-viewport read-only markdown overlay used
 * by both the per-note book-icon button (`noteRenderer.tsx`) and the ticket
 * Details book-icon button (`detail.tsx`). See docs/49-reader-mode.md.
 *
 * The overlay is intentionally minimal: header (title + close `×`), body
 * (rendered markdown that reuses the inline `.note-markdown` CSS), three
 * equivalent dismiss paths (X / Escape / backdrop). Read-only — no editing,
 * no save-back. The caller passes the current `markdown` value at click time
 * so a mid-edit reader shows the in-memory state, not the persisted one.
 *
 * Tauri-safe — plain DOM `position: fixed; inset: 0` div mounted on
 * `document.body`. No native dialog APIs. Z-index 2400 sits below the
 * feedback dialog (2500) and above everything else (terminal dashboard,
 * popups), per §49.6.
 *
 * **HS-8233 (2026-05-06)** — optional `navigation` slot adds chevron-up /
 * chevron-down buttons in the header for stepping through a list of
 * entries (used by the per-note reader so the user can read through every
 * non-empty note without re-clicking the book icon for each). When
 * `navigation` is omitted (e.g. the Details reader), the buttons are not
 * rendered at all. See docs/59-reader-note-navigation.md.
 */

export interface ReaderEntry {
  /** Plain-text title shown in the overlay header. Pre-formatted by the
   *  caller — see `buildNoteReaderTitle` / `buildDetailsReaderTitle`. */
  title: string;
  /** Markdown source. Empty string renders an italic "(empty)" placeholder. */
  markdown: string;
}

export interface ReaderNavigationOptions {
  /** Every entry in display order. Index 0 is the topmost entry in the
   *  caller's list. Must contain at least one element. */
  entries: ReaderEntry[];
  /** Initial entry to render. Must be in `[0, entries.length)`. */
  initialIndex: number;
}

export interface OpenReaderOverlayOptions extends ReaderEntry {
  /**
   * HS-8233 — optional list-navigation context. When provided, the overlay
   * renders chevron-up (previous) + chevron-down (next) buttons in the
   * header next to the close X. Up navigates to `entries[index-1]`, down
   * to `entries[index+1]`; both are disabled at list boundaries. The
   * top-level `title` / `markdown` fields are ignored when navigation is
   * supplied — the overlay derives them from `entries[initialIndex]`
   * instead so a mis-matched call site can't surface inconsistent state.
   * Keyboard: ArrowUp / ArrowDown also navigate while the overlay has
   * focus.
   */
  navigation?: ReaderNavigationOptions;
}

const CLOSE_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
/** HS-8233 — Lucide `chevron-up` glyph for the previous-entry button. */
const CHEVRON_UP_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>';
/** HS-8233 — Lucide `chevron-down` glyph for the next-entry button. */
const CHEVRON_DOWN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

/** Render a single entry's markdown body to safe HTML, applying the same
 *  `linkifyWithCachedPrefixes` post-process the noteRenderer applies inline.
 *  Pure helper — DOM-free. Exported for unit testing. */
export function renderReaderBodyHtml(markdown: string): string {
  const trimmed = markdown.trim();
  if (trimmed === '') return '<p class="reader-mode-empty"><em>(empty)</em></p>';
  return linkifyWithCachedPrefixes(marked.parse(markdown, { async: false }));
}

/**
 * Open the reader overlay. Returns nothing — the overlay manages its own
 * lifecycle and tears itself down on dismiss. Calling twice in a row removes
 * any previous overlay before mounting the new one so a stuck overlay can't
 * pile up.
 */
export function openReaderOverlay(options: OpenReaderOverlayOptions): void {
  // Drop any prior overlay so a re-trigger doesn't stack two on top of each
  // other — only one at a time.
  document.querySelectorAll('.reader-mode-overlay').forEach(el => el.remove());

  const navigation = options.navigation ?? null;
  // HS-8233 — when navigation is provided, the active entry is the source
  // of truth; otherwise fall back to the top-level title/markdown so
  // existing call sites (Details reader, future single-entry callers) keep
  // working without change.
  let currentIndex = navigation === null
    ? 0
    : Math.max(0, Math.min(navigation.entries.length - 1, navigation.initialIndex));
  function currentEntry(): ReaderEntry {
    if (navigation !== null) return navigation.entries[currentIndex];
    return { title: options.title, markdown: options.markdown };
  }

  const initial = currentEntry();
  const overlay = toElement(
    <div className="reader-mode-overlay" role="dialog" aria-modal="true" aria-label={initial.title}>
      <div className="reader-mode-dialog">
        <div className="reader-mode-header">
          <span className="reader-mode-title">{initial.title}</span>
          <div className="reader-mode-header-actions">
            {navigation !== null
              ? <>
                  <button className="reader-mode-prev" type="button" title="Previous (Up)" aria-label="Previous note">
                    {raw(CHEVRON_UP_SVG)}
                  </button>
                  <button className="reader-mode-next" type="button" title="Next (Down)" aria-label="Next note">
                    {raw(CHEVRON_DOWN_SVG)}
                  </button>
                </>
              : null}
            <button className="reader-mode-close" type="button" title="Close" aria-label="Close reader">
              {raw(CLOSE_ICON_SVG)}
            </button>
          </div>
        </div>
        <div className="reader-mode-body note-markdown">
          {raw(renderReaderBodyHtml(initial.markdown))}
        </div>
      </div>
    </div>
  );

  const titleEl = requireChild<HTMLSpanElement>(overlay, '.reader-mode-title');
  const bodyEl = requireChild<HTMLDivElement>(overlay, '.reader-mode-body');
  const prevBtn = navigation === null ? null : requireChild<HTMLButtonElement>(overlay, '.reader-mode-prev');
  const nextBtn = navigation === null ? null : requireChild<HTMLButtonElement>(overlay, '.reader-mode-next');

  function paintCurrent(): void {
    const entry = currentEntry();
    titleEl.textContent = entry.title;
    overlay.setAttribute('aria-label', entry.title);
    bodyEl.innerHTML = renderReaderBodyHtml(entry.markdown);
    // Reset scroll on navigation so a long previous note doesn't leave the
    // new one mid-scrolled — fresh entry, fresh top-of-page.
    bodyEl.scrollTop = 0;
    if (navigation !== null && prevBtn !== null && nextBtn !== null) {
      prevBtn.disabled = currentIndex === 0;
      nextBtn.disabled = currentIndex === navigation.entries.length - 1;
    }
  }

  function navigatePrev(): void {
    if (navigation === null || currentIndex === 0) return;
    currentIndex -= 1;
    paintCurrent();
  }
  function navigateNext(): void {
    if (navigation === null || currentIndex === navigation.entries.length - 1) return;
    currentIndex += 1;
    paintCurrent();
  }

  const close = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', onKeydown, true);
  };

  // Capture-phase Escape so this beats the global blur-input handler in
  // shortcuts.tsx (which runs in the bubble phase). Without capture the Esc
  // would still close the overlay (the global handler doesn't preventDefault)
  // but the input-blur side-effect would also fire for any focused element
  // inside the overlay.
  // HS-8233 — ArrowUp / ArrowDown navigate when navigation is provided.
  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (navigation === null) return;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      navigatePrev();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      navigateNext();
      return;
    }
  };

  document.addEventListener('keydown', onKeydown, true);

  requireChild<HTMLButtonElement>(overlay, '.reader-mode-close').addEventListener('click', close);
  if (prevBtn !== null) prevBtn.addEventListener('click', navigatePrev);
  if (nextBtn !== null) nextBtn.addEventListener('click', navigateNext);
  overlay.addEventListener('click', (e) => {
    // Only dismiss when the click landed on the dimmed backdrop, not when
    // the user clicked anywhere inside the dialog itself.
    if (e.target === overlay) close();
  });

  // Initial paint to set the disabled state on the prev/next buttons (the
  // server-rendered DOM has them enabled — `paintCurrent` runs the boundary
  // check immediately).
  if (navigation !== null) paintCurrent();

  document.body.appendChild(overlay);
}

/**
 * Pure helper — build the overlay title for a note. Localises the timestamp
 * via `Date.toLocaleString()` and falls back to a date-less title when the
 * note has no `created_at`. Exported so the noteRenderer doesn't have to
 * know the formatting rule + so it's testable.
 */
export function buildNoteReaderTitle(createdAt: string | null | undefined): string {
  if (createdAt === null || createdAt === undefined || createdAt === '') return 'Note';
  const ts = new Date(createdAt);
  if (Number.isNaN(ts.getTime())) return 'Note';
  return `Note from ${ts.toLocaleString()}`;
}

/**
 * Pure helper — build the overlay title for the Details section. Combines
 * the ticket number + title; falls back to "Details" alone when both are
 * missing.
 */
export function buildDetailsReaderTitle(ticketNumber: string | null | undefined, ticketTitle: string | null | undefined): string {
  const num = (ticketNumber ?? '').trim();
  const title = (ticketTitle ?? '').trim();
  if (num !== '' && title !== '') return `Details for ${num}: ${title}`;
  if (num !== '') return `Details for ${num}`;
  if (title !== '') return `Details: ${title}`;
  return 'Details';
}

/** HS-7957 — sync the Details reader-mode book button's `disabled`
 *  attribute with the textarea's current emptiness. Lives here (rather than
 *  in app.tsx) so detail.tsx can call it after populating the textarea on
 *  ticket-load without forming a circular dependency on app.tsx. */
export function syncDetailReaderButton(): void {
  const btn = byIdOrNull<HTMLButtonElement>('detail-reader-btn');
  const detailsArea = byIdOrNull<HTMLTextAreaElement>('detail-details');
  if (btn === null || detailsArea === null) return;
  btn.disabled = detailsArea.value.trim() === '';
}
