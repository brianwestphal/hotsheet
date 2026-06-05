/**
 * §78 Announcer (HS-8747) — the transcript "picture-in-picture" panel.
 *
 * A fixed-position, non-modal floating panel (modeled on the §49 reader
 * overlay's mount/teardown, but persistent and corner-docked rather than a
 * full-viewport modal). Shows the current entry's title + spoken script and
 * the playback controls; the `AnnouncerPlayer` drives narration through the
 * runtime `SpeechEngine`.
 *
 * Stacking (§78.5): z-index 2200 — above normal chrome, below the reader
 * overlay (2400), the feedback dialog (2500), and the permission popup, so a
 * dialog/permission prompt is never obscured by the PIP.
 *
 * Phase 1b scope: text transcript + play/pause/prev/next/skip + entry
 * position. Draggable/resizable, code-diff visuals, the 10s audio-timeline
 * seeks, and playback-speed are later phases (see follow-up tickets + docs/78
 * §78.5 content tiers).
 */
import type { Announcement } from '../api/announcer.js';
import { dismissAnnouncement } from '../api/index.js';
import { AnnouncerPlayer, type PlayerState } from './announcerPlayer.js';
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
const CLOSE_ICON = <svg {...LUCIDE}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>;

export interface AnnouncerPipHandle {
  close(): void;
}

export interface OpenPipOptions {
  /** Called when the PIP closes (manual or after the reel finishes), so the
   *  host can advance the listened cursor. */
  onClose?(): void;
}

let openHandle: AnnouncerPipHandle | null = null;

/** True when a PIP is currently mounted. */
export function isAnnouncerPipOpen(): boolean {
  return openHandle !== null;
}

/**
 * Mount the PIP for `entries` and start playing. Replaces any existing PIP.
 * Returns a handle whose `close()` tears everything down.
 */
export function openAnnouncerPip(entries: Announcement[], opts: OpenPipOptions = {}): AnnouncerPipHandle {
  openHandle?.close();

  const engine = createSpeechEngine();
  const backendHint = engine.backend === 'none'
    ? 'No speech voice available — transcript only.'
    : engine.backend === 'tauri' ? 'Speaking via system voice.' : 'Speaking via browser voice.';

  const panel = toElement(
    <div className="announcer-pip" role="region" aria-label="Announcer transcript">
      <div className="announcer-pip-header">
        <span className="announcer-pip-eyebrow">Announcer</span>
        <span className="announcer-pip-title"></span>
        <button className="announcer-pip-close" type="button" title="Close" aria-label="Close announcer">{CLOSE_ICON}</button>
      </div>
      <div className="announcer-pip-body">
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
          <span className="announcer-pip-hint">{backendHint}</span>
        </div>
      </div>
    </div>,
  );

  const titleEl = requireChild<HTMLSpanElement>(panel, '.announcer-pip-title');
  const scriptEl = requireChild<HTMLParagraphElement>(panel, '.announcer-pip-script');
  const positionEl = requireChild<HTMLSpanElement>(panel, '.announcer-pip-position');
  const playPauseBtn = requireChild<HTMLButtonElement>(panel, '.announcer-pip-playpause');

  let closed = false;

  const player = new AnnouncerPlayer(entries, engine, {
    onEntryChange(index, entry, total) {
      titleEl.textContent = entry.title;
      scriptEl.textContent = entry.script;
      positionEl.textContent = `${String(index + 1)} / ${String(total)}`;
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
      // Persist the dismissal so the reel + counts stay in sync server-side.
      dismissAnnouncement(entry.id).catch(() => { /* best-effort */ });
    },
  });

  const close = (): void => {
    if (closed) return;
    closed = true;
    player.dispose();
    document.removeEventListener('keydown', onKeydown, true);
    panel.remove();
    if (openHandle === handle) openHandle = null;
    opts.onClose?.();
  };

  const onKeydown = (e: KeyboardEvent): void => {
    // Only handle keys when the PIP holds focus, so global shortcuts and
    // ticket editing aren't hijacked while the PIP merely sits open.
    if (!panel.contains(document.activeElement)) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); player.togglePlayPause(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); player.prev(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); player.next(); }
  };

  requireChild<HTMLButtonElement>(panel, '.announcer-pip-close').addEventListener('click', close);
  requireChild<HTMLButtonElement>(panel, '.announcer-pip-prev').addEventListener('click', () => player.prev());
  playPauseBtn.addEventListener('click', () => player.togglePlayPause());
  requireChild<HTMLButtonElement>(panel, '.announcer-pip-next').addEventListener('click', () => player.next());
  requireChild<HTMLButtonElement>(panel, '.announcer-pip-skip').addEventListener('click', () => player.removeCurrent());
  document.addEventListener('keydown', onKeydown, true);

  document.body.appendChild(panel);

  const handle: AnnouncerPipHandle = { close };
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
