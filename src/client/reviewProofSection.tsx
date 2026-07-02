import { getReviewProof, launchGlassbox, type ReviewProofAttachment, type ReviewProofNote } from '../api/index.js';
import { byIdOrNull, toElement } from './dom.js';
import { getActiveProject } from './state.js';

/**
 * HS-9223 / HS-9293 / HS-9294 (docs/111) — the detail-panel "Review Proof" section:
 * the Glassbox `.pr-notes/` review notes whose `workItemUris` reference the active
 * ticket. Rendered into `#detail-review-proof`, just below the per-ticket telemetry
 * block, by `loadDetail`. **Presence-gated** (Q3b): the container stays empty (and
 * `:empty`-collapsed) when the repo has no `.pr-notes/` or nothing references the
 * ticket — no dependency on the `aiReviewNotes` inducement toggle.
 *
 * Light list → click-to-expand rich (Q2 "a then b"): each note = kind + `file:line`
 * + summary; clicking a row expands it to the **actual** artifacts inline —
 * screenshots as `<img>` (served by `GET /tickets/review-proof/artifact`, HS-9294)
 * and text output inlined (fetched lazily on first expand). An unpulled Git-LFS
 * screenshot (the artifact route 409s) falls back to a "not pulled" note; each note
 * carries an "Open in Glassbox" button for the full view. Mirrors
 * `ticketTelemetryStats.tsx`: cached per ticket + only repainted when the data
 * actually changes, so a background poll / auto-save reload neither flashes the
 * block nor collapses a row the user just expanded.
 */

const sigCache = new Map<string, string>();
let currentTicket: string | null = null;

/** Basename of an artifact URI (`.pr-notes/artifacts/shot.png` → `shot.png`). */
function artifactName(uri: string): string {
  const parts = uri.split(/[/\\]/);
  return parts[parts.length - 1] || uri;
}

/** URL to the HS-9294 artifact-serving route, project-scoped so the server resolves
 *  the active project's repo root (the same scoping `api.tsx` adds for GETs). */
function artifactSrc(uri: string): string {
  const params = new URLSearchParams({ path: uri });
  const proj = getActiveProject();
  if (proj !== null) params.set('project', proj.secret);
  return `/api/tickets/review-proof/artifact?${params.toString()}`;
}

/** An image attachment → an inline `<img>` that, on load failure (an unpulled LFS
 *  stub → the route 409s, or a missing file → 404), swaps to a "not pulled" note. */
function buildImageAttachment(a: ReviewProofAttachment): HTMLElement {
  const fig = toElement(
    <figure className="review-proof-figure">
      <img className="review-proof-img" loading="lazy" alt={a.description ?? artifactName(a.uri)} src={artifactSrc(a.uri)} />
      {a.description !== undefined ? <figcaption className="review-proof-attachment-desc">{a.description}</figcaption> : null}
    </figure>,
  );
  fig.querySelector<HTMLImageElement>('img')!.addEventListener('error', () => {
    fig.replaceChildren(toElement(
      <div className="review-proof-fallback">
        <span className="review-proof-attachment-name">{artifactName(a.uri)}</span>
        <span className="review-proof-fallback-note">not pulled (Git LFS) — use Open in Glassbox</span>
      </div>,
    ));
  });
  return fig;
}

/** A text attachment → a `<pre>` filled lazily on first expand (`loadLazyText`). */
function buildTextAttachment(a: ReviewProofAttachment): HTMLElement {
  return toElement(
    <div className="review-proof-text-wrap">
      <div className="review-proof-attachment-name">{artifactName(a.uri)}</div>
      <pre className="review-proof-text" data-artifact-uri={a.uri} data-loaded="0">Loading…</pre>
    </div>,
  );
}

/** Fetch + inline any not-yet-loaded text artifacts inside `detail` (called on the
 *  first expand, so text isn't fetched until the user opens the note). */
async function loadLazyText(detail: HTMLElement): Promise<void> {
  for (const pre of detail.querySelectorAll<HTMLPreElement>('.review-proof-text[data-loaded="0"]')) {
    pre.dataset.loaded = '1';
    const uri = pre.dataset.artifactUri ?? '';
    try {
      const res = await fetch(artifactSrc(uri));
      pre.textContent = res.status === 200 ? await res.text()
        : res.status === 409 ? '(not pulled — Git LFS)'
        : '(unavailable)';
    } catch {
      pre.textContent = '(failed to load)';
    }
  }
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
      <div className="review-proof-note-detail" hidden></div>
    </li>,
  );
  const head = row.querySelector<HTMLButtonElement>('.review-proof-note-head')!;
  const detail = row.querySelector<HTMLElement>('.review-proof-note-detail')!;

  // Build the expanded content imperatively (imgs carry an error→fallback listener;
  // text is lazy-fetched on first expand).
  if (note.attachments.length === 0) {
    detail.appendChild(toElement(<span className="review-proof-empty-detail">No attachments.</span>));
  } else {
    const list = toElement(<div className="review-proof-attachments"></div>);
    for (const a of note.attachments) {
      list.appendChild(a.kind === 'image' ? buildImageAttachment(a) : buildTextAttachment(a));
    }
    detail.appendChild(list);
  }
  const openBtn = toElement(<button type="button" className="review-proof-open-glassbox">Open in Glassbox</button>);
  openBtn.addEventListener('click', () => { void launchGlassbox(); });
  detail.appendChild(openBtn);

  head.addEventListener('click', () => {
    const open = detail.hasAttribute('hidden');
    detail.toggleAttribute('hidden', !open);
    head.setAttribute('aria-expanded', String(open));
    row.classList.toggle('is-open', open);
    if (open) void loadLazyText(detail); // fetch text artifacts on first expand
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
