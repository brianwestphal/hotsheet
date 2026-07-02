import { getReviewProof, type ReviewProofNote } from '../api/index.js';
import { byIdOrNull, toElement } from './dom.js';

/**
 * HS-9223 / HS-9293 (docs/111) — the detail-panel "Review Proof" section: the
 * Glassbox `.pr-notes/` review notes whose `workItemUris` reference the active
 * ticket. Rendered into `#detail-review-proof`, just below the per-ticket telemetry
 * block, by `loadDetail`. **Presence-gated** (Q3b): the container stays empty (and
 * `:empty`-collapsed) when the repo has no `.pr-notes/` or nothing references the
 * ticket — no dependency on the `aiReviewNotes` inducement toggle.
 *
 * Light list (Q2a): each note = kind + `file:line` + summary; clicking a row
 * expands it to its attachment chips (Q2 "click into" — the actual inline
 * screenshot/text rendering + LFS-aware artifact serving is a follow-up slice).
 * Mirrors `ticketTelemetryStats.tsx`: cached per ticket + only repainted when the
 * data actually changes, so a background poll / auto-save reload neither flashes
 * the block nor collapses a row the user just expanded.
 */

const sigCache = new Map<string, string>();
let currentTicket: string | null = null;

/** Basename of an artifact URI (`.pr-notes/artifacts/shot.png` → `shot.png`). */
function artifactName(uri: string): string {
  const parts = uri.split(/[/\\]/);
  return parts[parts.length - 1] || uri;
}

function fileLineLabel(note: ReviewProofNote): string | null {
  if (note.file === null) return null;
  if (note.startLine === null) return note.file;
  const range = note.endLine !== null && note.endLine !== note.startLine ? `${String(note.startLine)}–${String(note.endLine)}` : String(note.startLine);
  return `${note.file}:${range}`;
}

function renderNote(note: ReviewProofNote): HTMLElement {
  const loc = fileLineLabel(note);
  const row = toElement(
    <li className="review-proof-note">
      <button type="button" className="review-proof-note-head" aria-expanded="false">
        {note.noteKind !== null ? <span className="review-proof-kind" data-kind={note.noteKind}>{note.noteKind}</span> : null}
        {loc !== null ? <span className="review-proof-loc">{loc}</span> : null}
        <span className="review-proof-summary">{note.summary || '(no summary)'}</span>
        {note.attachments.length > 0 ? <span className="review-proof-count">{`${String(note.attachments.length)} 📎`}</span> : null}
      </button>
      <div className="review-proof-note-detail" hidden>
        {note.attachments.length === 0
          ? <span className="review-proof-empty-detail">No attachments.</span>
          : <ul className="review-proof-attachments">
              {note.attachments.map(a =>
                <li className="review-proof-attachment" data-kind={a.kind}>
                  <span className="review-proof-attachment-icon">{a.kind === 'image' ? '🖼️' : '📄'}</span>
                  <span className="review-proof-attachment-name">{artifactName(a.uri)}</span>
                  {a.description !== undefined ? <span className="review-proof-attachment-desc">{a.description}</span> : null}
                </li>,
              )}
            </ul>}
      </div>
    </li>,
  );
  const head = row.querySelector<HTMLButtonElement>('.review-proof-note-head')!;
  const detail = row.querySelector<HTMLElement>('.review-proof-note-detail')!;
  head.addEventListener('click', () => {
    const open = detail.hasAttribute('hidden');
    detail.toggleAttribute('hidden', !open);
    head.setAttribute('aria-expanded', String(open));
    row.classList.toggle('is-open', open);
  });
  return row;
}

function render(container: HTMLElement, notes: ReviewProofNote[]): void {
  if (notes.length === 0) {
    container.replaceChildren();
    return;
  }
  const block = toElement(
    <div className="review-proof-block">
      <h4 className="review-proof-label">{`Review Proof (${String(notes.length)})`}</h4>
      <ul className="review-proof-list"></ul>
    </div>,
  );
  // `renderNote` returns a live element with a click listener, so append the built
  // rows rather than embedding them as JSX children (the runtime builds SafeHtml,
  // not DOM).
  const list = block.querySelector<HTMLElement>('.review-proof-list')!;
  for (const note of notes) list.appendChild(renderNote(note));
  container.replaceChildren(block);
}

/**
 * Fetch + render the review-proof section for `ticketNumber`. Repaints only when
 * the data changed (a stable signature over the notes) so expanded rows survive a
 * background reload; skips the repaint entirely when the user has switched tickets
 * mid-fetch. A network hiccup keeps whatever's shown.
 */
export async function loadAndRenderReviewProof(ticketNumber: string): Promise<void> {
  const container = byIdOrNull('detail-review-proof');
  if (container === null) return;
  const switching = currentTicket !== ticketNumber;
  currentTicket = ticketNumber;
  if (switching && !sigCache.has(ticketNumber)) container.replaceChildren();

  let notes: ReviewProofNote[];
  try {
    ({ notes } = await getReviewProof(ticketNumber));
  } catch {
    return; // transient failure — keep whatever's shown
  }
  if (currentTicket !== ticketNumber) return; // switched away mid-fetch

  const sig = JSON.stringify(notes);
  if (sigCache.get(ticketNumber) === sig && container.childElementCount > 0) return; // unchanged — preserve expansions
  sigCache.set(ticketNumber, sig);
  render(container, notes);
}

/** Clear the section on detail close so a reopen of a DIFFERENT ticket can't
 *  briefly show this one's proof. The signature cache is kept so a revisit repaints
 *  instantly without a flash. */
export function clearReviewProof(): void {
  byIdOrNull('detail-review-proof')?.replaceChildren();
  currentTicket = null;
}

/** Test hook — reset module state. */
export function _resetReviewProofForTests(): void {
  sigCache.clear();
  currentTicket = null;
}
