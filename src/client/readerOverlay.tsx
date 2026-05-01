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
 */

export interface OpenReaderOverlayOptions {
  /** Plain-text title shown in the overlay header. Pre-formatted by the
   *  caller — see `buildNoteReaderTitle` / `buildDetailsReaderTitle`. */
  title: string;
  /** Markdown source. Empty string renders an italic "(empty)" placeholder. */
  markdown: string;
}

const CLOSE_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

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

  const { title, markdown } = options;
  const trimmed = markdown.trim();
  // HS-8036 — wrap ticket-number references in clickable anchors after
  // markdown renders so a `HS-1234` inside reader-mode body opens the
  // stacking ticket-reference dialog (the document-level click handler
  // intercepts `.ticket-ref` clicks regardless of mount surface).
  const renderedHtml = trimmed === ''
    ? '<p class="reader-mode-empty"><em>(empty)</em></p>'
    : linkifyWithCachedPrefixes(marked.parse(markdown, { async: false }));

  const overlay = toElement(
    <div className="reader-mode-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="reader-mode-dialog">
        <div className="reader-mode-header">
          <span className="reader-mode-title">{title}</span>
          <button className="reader-mode-close" type="button" title="Close" aria-label="Close reader">
            {raw(CLOSE_ICON_SVG)}
          </button>
        </div>
        <div className="reader-mode-body note-markdown">
          {raw(renderedHtml)}
        </div>
      </div>
    </div>
  );

  const close = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', onKeydown, true);
  };

  // Capture-phase Escape so this beats the global blur-input handler in
  // shortcuts.tsx (which runs in the bubble phase). Without capture the Esc
  // would still close the overlay (the global handler doesn't preventDefault)
  // but the input-blur side-effect would also fire for any focused element
  // inside the overlay.
  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  document.addEventListener('keydown', onKeydown, true);

  requireChild<HTMLButtonElement>(overlay, '.reader-mode-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    // Only dismiss when the click landed on the dimmed backdrop, not when
    // the user clicked anywhere inside the dialog itself.
    if (e.target === overlay) close();
  });

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
