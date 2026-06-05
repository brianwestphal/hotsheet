/**
 * §78 Announcer (HS-8747) — the transcript "picture-in-picture" panel.
 *
 * A fixed-position, non-modal floating panel (modeled on the §49 reader
 * overlay's mount/teardown, but persistent and draggable rather than a
 * full-viewport modal). Shows the current entry's title + spoken script and
 * the playback controls; the `AnnouncerPlayer` drives narration through the
 * runtime `SpeechEngine`.
 *
 * Stacking (§78.5): z-index 2200 — above normal chrome, below the reader
 * overlay (2400), the feedback dialog (2500), and the permission popup, so a
 * dialog/permission prompt is never obscured by the PIP.
 *
 * HS-8756 — the panel opens anchored beneath the Listen button, is **draggable**
 * by its header, and remembers its dragged position (localStorage).
 * HS-8757 — a **minimize** button hides the panel back into the Listen button
 * *without stopping playback*; the host glows the button while minimized and a
 * second click on the button restores the panel.
 */
import type { Announcement, AnnouncerProjectInfo } from '../api/announcer.js';
import { dismissAnnouncement } from '../api/index.js';
import { anchoredPosition, clampPosition, type Point } from './announcerPipPosition.js';
import { AnnouncerPlayer, type PlayerState } from './announcerPlayer.js';
import { getAnnouncerSpeechRate, RATE_STEPS, setAnnouncerSpeechRate } from './announcerSpeechRate.js';
import { byIdOrNull, requireChild, toElement } from './dom.js';
import { createSpeechEngine } from './tts.js';

const LUCIDE = {
  xmlns: 'http://www.w3.org/2000/svg',
  width: '16',
  height: '16',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '2',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
} as const;

const PREV_ICON = <svg {...LUCIDE}><polygon points="19 20 9 12 19 4 19 20"/><line x1="5" x2="5" y1="19" y2="5"/></svg>;
const NEXT_ICON = <svg {...LUCIDE}><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" x2="19" y1="5" y2="19"/></svg>;
const PLAY_ICON = <svg {...LUCIDE}><polygon points="6 3 20 12 6 21 6 3"/></svg>;
const PAUSE_ICON = <svg {...LUCIDE}><rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/></svg>;
const SKIP_ICON = <svg {...LUCIDE}><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/></svg>;
const MINIMIZE_ICON = <svg {...LUCIDE}><path d="M5 12h14"/></svg>;
const CLOSE_ICON = <svg {...LUCIDE}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>;

/** Remembered dragged position (HS-8756). localStorage so it survives reloads
 *  without a server round-trip — it's a pure UI preference. */
const POSITION_KEY = 'hotsheet:announcer-pip-pos';

function loadStoredPosition(): Point | null {
  try {
    const raw = window.localStorage.getItem(POSITION_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null
      && 'left' in parsed && 'top' in parsed
      && typeof parsed.left === 'number' && typeof parsed.top === 'number') {
      return { left: parsed.left, top: parsed.top };
    }
  } catch { /* corrupt / disabled — fall back to anchored */ }
  return null;
}

function saveStoredPosition(pos: Point): void {
  try { window.localStorage.setItem(POSITION_KEY, JSON.stringify(pos)); } catch { /* private mode etc. */ }
}

/** "All Projects" sentinel for the context dropdown (HS-8762). */
export const ALL_PROJECTS = 'all';

/** A reel entry annotated with its owning project so the PIP can show a chip and
 *  dismiss against the right project's DB (HS-8762). */
export interface ReelEntry extends Announcement {
  projectSecret: string;
  projectName: string;
}

export interface AnnouncerPipHandle {
  close(): void;
  minimize(): void;
  restore(): void;
  isMinimized(): boolean;
}

export interface OpenPipOptions {
  /** The current context: `ALL_PROJECTS` or a specific project secret (HS-8762). */
  context: string;
  /** Enabled projects offered in the context dropdown. */
  projects: AnnouncerProjectInfo[];
  /** Called when the user picks a different context; resolves the new reel. */
  onContextChange?(context: string): Promise<ReelEntry[]>;
  /** Called when the PIP closes (manual or after the reel finishes) with the
   *  final context, so the host can advance the listened cursor(s). */
  onClose?(context: string): void;
  /** Called when the panel is minimized (playback continues), so the host can
   *  glow the Listen button. */
  onMinimize?(): void;
  /** Called when the panel is restored from minimized, so the host can clear
   *  the glow. */
  onRestore?(): void;
  /** The Listen button — used to anchor the initial position near it. */
  anchorEl?: HTMLElement | null;
}

let openHandle: AnnouncerPipHandle | null = null;

/** True when a PIP session is currently mounted (visible or minimized). */
export function isAnnouncerPipOpen(): boolean {
  return openHandle !== null;
}

/** The live handle, so the host can restore a minimized session on button click. */
export function getAnnouncerPipHandle(): AnnouncerPipHandle | null {
  return openHandle;
}

/**
 * Mount the PIP for `entries` and start playing. Replaces any existing PIP.
 * Returns a handle whose `close()` tears everything down.
 */
export function openAnnouncerPip(entries: ReelEntry[], opts: OpenPipOptions): AnnouncerPipHandle {
  openHandle?.close();

  let currentContext = opts.context;

  const engine = createSpeechEngine();
  const backendHint = engine.backend === 'none'
    ? 'No speech voice available — transcript only.'
    : engine.backend === 'tauri' ? 'Speaking via system voice.' : 'Speaking via browser voice.';

  const panel = toElement(
    <div className="announcer-pip" role="region" aria-label="Announcer transcript">
      <div className="announcer-pip-header">
        <span className="announcer-pip-eyebrow">Announcer</span>
        <span className="announcer-pip-title"></span>
        <button className="announcer-pip-min" type="button" title="Minimize (keeps playing)" aria-label="Minimize announcer">{MINIMIZE_ICON}</button>
        <button className="announcer-pip-close" type="button" title="Close" aria-label="Close announcer">{CLOSE_ICON}</button>
      </div>
      <div className="announcer-pip-context">
        <select className="announcer-pip-context-select" aria-label="Announcer context">
          <option value={ALL_PROJECTS}>All Projects</option>
          {opts.projects.map(p => <option value={p.secret}>{p.name}</option>)}
        </select>
      </div>
      <div className="announcer-pip-body">
        <span className="announcer-pip-project-chip" hidden></span>
        <p className="announcer-pip-script"></p>
      </div>
      <div className="announcer-pip-footer">
        <div className="announcer-pip-controls">
          <button className="announcer-pip-btn announcer-pip-prev" type="button" title="Previous entry" aria-label="Previous entry">{PREV_ICON}</button>
          <button className="announcer-pip-btn announcer-pip-playpause" type="button" title="Play" aria-label="Play">{PLAY_ICON}</button>
          <button className="announcer-pip-btn announcer-pip-next" type="button" title="Next entry" aria-label="Next entry">{NEXT_ICON}</button>
          <button className="announcer-pip-btn announcer-pip-skip" type="button" title="Not interested — skip and dismiss" aria-label="Skip and dismiss entry">{SKIP_ICON}</button>
        </div>
        <div className="announcer-pip-meta">
          <span className="announcer-pip-position" aria-live="polite"></span>
          <label className="announcer-pip-speed">
            Speed
            <select className="announcer-pip-rate" aria-label="Playback speed">
              {RATE_STEPS.map(s => <option value={String(s)}>{`${String(s)}×`}</option>)}
            </select>
          </label>
          <span className="announcer-pip-hint">{backendHint}</span>
        </div>
      </div>
    </div>,
  );

  const titleEl = requireChild<HTMLSpanElement>(panel, '.announcer-pip-title');
  const scriptEl = requireChild<HTMLParagraphElement>(panel, '.announcer-pip-script');
  const positionEl = requireChild<HTMLSpanElement>(panel, '.announcer-pip-position');
  const playPauseBtn = requireChild<HTMLButtonElement>(panel, '.announcer-pip-playpause');
  const rateSelect = requireChild<HTMLSelectElement>(panel, '.announcer-pip-rate');
  const contextSelect = requireChild<HTMLSelectElement>(panel, '.announcer-pip-context-select');
  const chipEl = requireChild<HTMLSpanElement>(panel, '.announcer-pip-project-chip');
  const header = requireChild<HTMLDivElement>(panel, '.announcer-pip-header');

  let closed = false;
  let minimized = false;

  const player = new AnnouncerPlayer<ReelEntry>(entries, engine, {
    onEntryChange(index, entry, total) {
      titleEl.textContent = entry.title;
      scriptEl.textContent = entry.script;
      positionEl.textContent = `${String(index + 1)} / ${String(total)}`;
      // Show which project the entry is about, but only in "All Projects" mode
      // (in a single-project context it's redundant). HS-8762.
      if (currentContext === ALL_PROJECTS) {
        chipEl.textContent = entry.projectName;
        chipEl.hidden = false;
      } else {
        chipEl.hidden = true;
      }
    },
    onStateChange(state: PlayerState) {
      const playing = state === 'playing';
      playPauseBtn.replaceChildren(toElement(playing ? PAUSE_ICON : PLAY_ICON));
      playPauseBtn.title = playing ? 'Pause' : 'Play';
      playPauseBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      panel.classList.toggle('is-playing', playing);
      panel.classList.toggle('is-done', state === 'done');
    },
    onRemove(entry) {
      // Persist the dismissal in the entry's OWN project (HS-8762 — ids aren't
      // unique across projects, so dismiss must target the owning project).
      dismissAnnouncement(entry.id, entry.projectSecret).catch(() => { /* best-effort */ });
    },
  });

  // --- Context dropdown (HS-8762): switch which project's reel plays. ---
  contextSelect.value = currentContext;
  contextSelect.addEventListener('change', () => {
    const next = contextSelect.value;
    if (next === currentContext) return;
    contextSelect.disabled = true;
    void (opts.onContextChange?.(next) ?? Promise.resolve<ReelEntry[]>([]))
      .then((reel) => {
        currentContext = next;
        player.setEntries(reel);
      })
      .catch(() => { contextSelect.value = currentContext; })
      .finally(() => { contextSelect.disabled = false; });
  });

  // --- Speed control (HS-8754): seed from the global rate, write back on change,
  //     and stay in sync if it's changed from the settings panel meanwhile. ---
  rateSelect.value = String(getAnnouncerSpeechRate());
  player.setRate(getAnnouncerSpeechRate());
  rateSelect.addEventListener('change', () => {
    const v = Number(rateSelect.value);
    player.setRate(v);
    void setAnnouncerSpeechRate(v);
  });
  const onRateChanged = (): void => {
    const r = getAnnouncerSpeechRate();
    rateSelect.value = String(r);
    player.setRate(r);
  };
  document.addEventListener('hotsheet:announcer-rate-changed', onRateChanged);

  // --- Position (HS-8756): apply stored-or-anchored, then keep draggable. ---
  const panelSize = (): { width: number; height: number } => ({ width: panel.offsetWidth, height: panel.offsetHeight });
  const viewport = (): { width: number; height: number } => ({ width: window.innerWidth, height: window.innerHeight });

  const applyPosition = (pos: Point): void => {
    const clamped = clampPosition(pos, panelSize(), viewport());
    panel.style.left = `${String(clamped.left)}px`;
    panel.style.top = `${String(clamped.top)}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  };

  const placeInitial = (): void => {
    const stored = loadStoredPosition();
    if (stored !== null) { applyPosition(stored); return; }
    const anchor = opts.anchorEl?.getBoundingClientRect();
    if (anchor !== undefined && (anchor.width > 0 || anchor.height > 0)) {
      applyPosition(anchoredPosition(anchor, panelSize(), viewport()));
    }
    // else: leave the SCSS-default bottom-right anchoring in place.
  };

  // Drag via the header (but not its buttons).
  let dragState: { pointerId: number; offsetX: number; offsetY: number } | null = null;
  const onPointerDown = (e: PointerEvent): void => {
    if (e.target instanceof Element && e.target.closest('button') !== null) return;
    const rect = panel.getBoundingClientRect();
    dragState = { pointerId: e.pointerId, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top };
    header.setPointerCapture(e.pointerId);
    panel.classList.add('is-dragging');
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (dragState === null || e.pointerId !== dragState.pointerId) return;
    applyPosition({ left: e.clientX - dragState.offsetX, top: e.clientY - dragState.offsetY });
  };
  const onPointerUp = (e: PointerEvent): void => {
    if (dragState === null || e.pointerId !== dragState.pointerId) return;
    dragState = null;
    panel.classList.remove('is-dragging');
    header.releasePointerCapture(e.pointerId);
    const rect = panel.getBoundingClientRect();
    saveStoredPosition({ left: rect.left, top: rect.top });
  };
  header.addEventListener('pointerdown', onPointerDown);
  header.addEventListener('pointermove', onPointerMove);
  header.addEventListener('pointerup', onPointerUp);

  const close = (): void => {
    if (closed) return;
    closed = true;
    player.dispose();
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('hotsheet:announcer-rate-changed', onRateChanged);
    panel.remove();
    if (openHandle === handle) openHandle = null;
    opts.onClose?.(currentContext);
  };

  const minimize = (): void => {
    if (closed || minimized) return;
    minimized = true;
    panel.style.display = 'none';
    opts.onMinimize?.();
  };

  const restore = (): void => {
    if (closed || !minimized) return;
    minimized = false;
    panel.style.display = '';
    placeInitial();
    opts.onRestore?.();
  };

  const onKeydown = (e: KeyboardEvent): void => {
    // Only handle keys when the PIP holds focus, so global shortcuts and
    // ticket editing aren't hijacked while the PIP merely sits open.
    if (!panel.contains(document.activeElement)) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); minimize(); }
    else if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); player.togglePlayPause(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); player.prev(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); player.next(); }
  };

  requireChild<HTMLButtonElement>(panel, '.announcer-pip-close').addEventListener('click', close);
  requireChild<HTMLButtonElement>(panel, '.announcer-pip-min').addEventListener('click', minimize);
  requireChild<HTMLButtonElement>(panel, '.announcer-pip-prev').addEventListener('click', () => player.prev());
  playPauseBtn.addEventListener('click', () => player.togglePlayPause());
  requireChild<HTMLButtonElement>(panel, '.announcer-pip-next').addEventListener('click', () => player.next());
  requireChild<HTMLButtonElement>(panel, '.announcer-pip-skip').addEventListener('click', () => player.removeCurrent());
  document.addEventListener('keydown', onKeydown, true);

  document.body.appendChild(panel);
  placeInitial();

  const handle: AnnouncerPipHandle = { close, minimize, restore, isMinimized: () => minimized };
  openHandle = handle;

  // Kick off narration. Focus the play/pause button so the keyboard shortcuts
  // work immediately without an extra click.
  player.play();
  playPauseBtn.focus();

  return handle;
}

/** Close any open PIP (used on project switch / teardown). */
export function closeAnnouncerPip(): void {
  openHandle?.close();
}

/** Test seam — is the `#announcer-listen-btn` present (toolbar wired)? */
export function isListenButtonPresent(): boolean {
  return byIdOrNull('announcer-listen-btn') !== null;
}
