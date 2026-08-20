import './markdownSetup.js'; // HS-9387 — escape-html marked config for note bodies

import { raw } from 'kerfjs';
import { marked } from 'marked';

import { type CommitGroup, getReviewProof, getTicketCommits, type GlassboxReviewReq, launchGlassbox, reviewInGlassbox, type ReviewProofAttachment, type ReviewProofNote, type TicketCommitsResponse } from '../api/index.js';
import { byIdOrNull, toElement } from './dom.js';
import { projectScoped } from './projectScoped.js';
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

/** HS-9402 — cache the DATA (not just a signature) per ticket, mirroring
 *  `ticketTelemetryStats.tsx`: a ticket switch repaints the new ticket's cached
 *  content immediately (or clears when unseen), so the previous ticket's section
 *  can never linger under the new ticket. */
interface CachedProof { sig: string; notes: ReviewProofNote[]; commits: TicketCommitsResponse | null }
// HS-9413 (docs/125 §125.3b / docs/126) — both cells are PROJECT-SCOPED. Keyed
// by ticket number alone, `proofCache` collided across projects: ticket numbers
// repeat whenever two projects share a prefix, and `HS-` is the default. Opening
// HS-42 in project B painted project A's review notes + commits immediately, and
// the deliberate keep-what's-shown-on-fetch-failure path below made that
// permanent.
const proofCache = projectScoped(() => new Map<string, CachedProof>(), 'reviewProof.proofCache');

/** HS-9413 — what the (single, global) `#detail-review-proof` node currently
 *  shows, as `secret::ticketNumber`. Deliberately NOT `projectScoped`: it
 *  describes the shared DOM element, so it is global by nature — and scoping it
 *  actively broke things. With a per-project `currentTicket`, switching back to
 *  project A found its stale `HS-42` and reported "not switching", so the
 *  unchanged-signature guard below (`prev?.sig === sig && childElementCount > 0`)
 *  accepted project B's DOM as already-painted and left B's review notes on
 *  screen. Including the secret makes a project switch a switch even when the
 *  ticket number is identical — the same reasoning as HS-9402, one level up. */
let paintedKey: string | null = null;

const keyFor = (ticketNumber: string): string => `${getActiveProject()?.secret ?? ''}::${ticketNumber}`;

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

  // HS-9387 — the expanded row leads with the FULL note text, markdown-rendered
  // and wrapping (the head's one-line ellipsis summary hides while open, via
  // `.is-open` CSS). `body` is optional on the wire (older server) — fall back
  // to the one-line summary rather than showing nothing.
  const bodyText = (note.body ?? note.summary).trim();
  if (bodyText !== '') {
    detail.appendChild(toElement(
      <div className="review-proof-body">
        {/* eslint-disable-next-line kerfjs/no-raw-with-dynamic-arg -- sanitized markdown HTML from `marked.parse(...)` (markdownSetup escapes raw HTML). */}
        {raw(marked.parse(bodyText, { async: false }))}
      </div>,
    ));
  }

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
  openBtn.addEventListener('click', () => {
    // HS-9295 — deep-link: open Glassbox focused on the note's anchored FILE (where
    // Glassbox renders its `.pr-notes/` note), via the `files`-mode review. Fall
    // back to the generic open when the note carries no location.
    if (note.file !== null && note.file !== '') {
      void reviewInGlassbox({ mode: 'files', patterns: [note.file] });
    } else {
      void launchGlassbox();
    }
  });
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

// --- HS-9393 (docs/122) — the aggregate "Open in Glassbox" action -------------

/** What the header button should do. `chooser` renders the option menu. */
export type AggregateReviewAction =
  | { kind: 'direct'; label: string; req: GlassboxReviewReq }
  | { kind: 'chooser'; label: string; options: { label: string; req: GlassboxReviewReq }[] }
  | { kind: 'none' };

/** `2026-07-23T…` → `Jul 23` (locale-independent enough for a chip label). */
function shortDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** One chooser row's label for a commit group. No JS truncation — the label wraps
 *  and CSS clamps it to 2 lines, expandable by clicking the row (HS-9401). */
function groupLabel(g: CommitGroup): string {
  const subject = g.subjects[0] ?? '';
  const head = `${String(g.count)} commit${g.count === 1 ? '' : 's'} · ${shortDate(g.latestDate)}`;
  const refSuffix = g.ref !== undefined ? ` (on ${g.ref})` : '';
  return `${head}${refSuffix} — ${subject}`;
}

/** The review request for one group: a single commit reviews as `--commit` (its
 *  `<sha>^` base would break on a root commit and `--commit` is the sharper view). */
function groupReq(g: CommitGroup): GlassboxReviewReq {
  return g.count === 1 ? { mode: 'commit', sha: g.to } : { mode: 'range', from: g.from, to: g.to };
}

/**
 * Pure — decide the header button's behavior from the discovery result + the
 * notes' anchored files (docs/122 §122.3): one group → direct range/commit review;
 * several → chooser (+ the earliest→latest span option with its unrelated-count
 * caveat when the span exists — HEAD-interleaved case); no commits → the
 * started-and-dirty uncommitted fallback, else a files-mode aggregate over the
 * note-anchored files, else nothing.
 */
export function aggregateReviewAction(commits: TicketCommitsResponse | null, noteFiles: string[]): AggregateReviewAction {
  const groups = commits?.groups ?? [];
  if (groups.length === 1) {
    return { kind: 'direct', label: 'Open in Glassbox', req: groupReq(groups[0]) };
  }
  if (groups.length > 1) {
    const options = groups.map(g => ({ label: groupLabel(g), req: groupReq(g) }));
    if (commits?.span != null) {
      options.push({
        label: `Review all, earliest→latest (includes ${String(commits.span.unrelatedCount)} unrelated commit${commits.span.unrelatedCount === 1 ? '' : 's'})`,
        req: { mode: 'range', from: commits.span.from, to: commits.span.to },
      });
    }
    return { kind: 'chooser', label: 'Open in Glassbox', options };
  }
  if (commits !== null && commits.ticketStatus === 'started' && commits.dirty) {
    return { kind: 'direct', label: 'Review uncommitted changes', req: { mode: 'uncommitted' } };
  }
  const files = [...new Set(noteFiles.filter(f => f !== ''))];
  if (files.length > 0) {
    return { kind: 'direct', label: 'Open in Glassbox', req: { mode: 'files', patterns: files } };
  }
  return { kind: 'none' };
}

/** Build the header row: title + the aggregate button (with its chooser menu). */
function renderHeader(action: AggregateReviewAction): HTMLElement {
  const header = toElement(
    <div className="code-review-header">
      <h4 className="review-proof-label">Code Review</h4>
    </div>,
  );
  if (action.kind === 'none') return header;
  const btn = toElement(
    <button type="button" className="review-proof-open-glassbox code-review-aggregate-btn">
      {action.kind === 'chooser' ? `${action.label} ▾` : action.label}
    </button>,
  );
  header.appendChild(btn);
  if (action.kind === 'direct') {
    btn.addEventListener('click', () => { void reviewInGlassbox(action.req); });
    return header;
  }
  // Chooser: an inline option list toggled under the header (no floating layer;
  // collapses after a pick). HS-9401 — each row mirrors the git-status popover's
  // commit rows: the label wraps and clamps to 2 lines, clicking the ROW expands/
  // collapses it, and the explicit (keyboard-reachable) Review button launches.
  const menu = toElement(<div className="code-review-chooser" hidden></div>);
  for (const opt of action.options) {
    const optRow = toElement(
      <div className="code-review-chooser-option">
        <span className="code-review-option-label is-clamped">{opt.label}</span>
        <button type="button" className="code-review-option-review" title="Open this review in Glassbox">Review</button>
      </div>,
    );
    const label = optRow.querySelector<HTMLElement>('.code-review-option-label')!;
    optRow.addEventListener('click', () => {
      const expanded = optRow.classList.toggle('is-expanded');
      label.classList.toggle('is-clamped', !expanded);
    });
    optRow.querySelector<HTMLButtonElement>('.code-review-option-review')!.addEventListener('click', (e) => {
      e.stopPropagation(); // launching is not an expand/collapse
      void reviewInGlassbox(opt.req);
      menu.toggleAttribute('hidden', true);
    });
    menu.appendChild(optRow);
  }
  btn.addEventListener('click', () => { menu.toggleAttribute('hidden', !menu.hasAttribute('hidden')); });
  header.appendChild(menu);
  return header;
}

function render(container: HTMLElement, notes: ReviewProofNote[], commits: TicketCommitsResponse | null): void {
  const action = aggregateReviewAction(commits, notes.map(n => n.file ?? ''));
  // Presence rule (docs/122 §122.3): notes OR an actionable aggregate (commits /
  // the uncommitted fallback). A ticket with neither collapses the section.
  if (notes.length === 0 && action.kind === 'none') {
    container.replaceChildren();
    return;
  }
  const block = toElement(
    <div className="review-proof-block">
      <ul className="review-proof-list"></ul>
    </div>,
  );
  block.prepend(renderHeader(action));
  const list = block.querySelector<HTMLElement>('.review-proof-list')!;
  if (notes.length > 0) {
    list.before(toElement(<div className="code-review-notes-count">{`${String(notes.length)} review note${notes.length === 1 ? '' : 's'}`}</div>));
    // `renderNote` returns a live element with a click listener, so append the
    // built rows rather than embedding them as JSX children.
    for (const note of notes) list.appendChild(renderNote(note));
  }
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
  const key = keyFor(ticketNumber);
  const switching = paintedKey !== key;
  paintedKey = key;
  if (switching) {
    // HS-9402 — a direct ticket→ticket switch never goes through clearReviewProof,
    // so the container may still hold the PREVIOUS ticket's section. Repaint the
    // new ticket's cached content immediately when we have it, else clear — the
    // old `childElementCount > 0` unchanged-guard below would otherwise accept the
    // stale DOM as "already painted" and leave the wrong ticket's section showing.
    const cached = proofCache.get().get(ticketNumber);
    if (cached !== undefined) render(container, cached.notes, cached.commits);
    else container.replaceChildren();
  }

  // HS-9393 / HS-9398 — the two fetches degrade INDEPENDENTLY: a commits failure
  // (older server, non-repo) keeps the notes-only view, and a notes failure keeps
  // the commits-only view (the section must not require `.pr-notes/` to exist —
  // docs/122 §122.3). Only both failing keeps whatever's shown.
  const [proof, commits] = await Promise.all([
    getReviewProof(ticketNumber).catch(() => null),
    getTicketCommits(ticketNumber).catch(() => null),
  ]);
  if (proof === null && commits === null) return; // transient failure — keep whatever's shown
  const notes: ReviewProofNote[] = proof?.notes ?? [];
  if (paintedKey !== key) return; // switched away mid-fetch (different ticket OR project)

  const sig = JSON.stringify({ notes, commits });
  const prev = proofCache.get().get(ticketNumber);
  proofCache.get().set(ticketNumber, { sig, notes, commits });
  if (prev?.sig === sig && container.childElementCount > 0) return; // unchanged — preserve expansions
  render(container, notes, commits);
}

/** Clear the section on detail close so a reopen of a DIFFERENT ticket can't
 *  briefly show this one's proof. The data cache is kept so a revisit repaints
 *  instantly without a flash. */
export function clearReviewProof(): void {
  byIdOrNull('detail-review-proof')?.replaceChildren();
  paintedKey = null;
}

/** Test hook — reset module state. */
export function _resetReviewProofForTests(): void {
  proofCache.get().clear();
  paintedKey = null;
}
