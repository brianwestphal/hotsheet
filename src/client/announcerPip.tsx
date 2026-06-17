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
 * HS-8757 — the header **X** hides the panel back into the Listen button
 * *without stopping playback*; the host glows the button while hidden and a
 * second click on the button restores the panel.
 * HS-8827 — header controls reworked: the X now HIDES (was: close); the
 * dedicated minimize button is gone; an explicit **Stop** button ends the
 * session. Footer gains a per-entry timestamp + a **Clear All** button, the
 * idle/working presence line and the "Speaking via …" hint are removed, and the
 * context dropdown is switchable WHILE LIVE (live retargets to the new context).
 */
import type { Announcement, AnnouncerProjectInfo } from '../api/announcer.js';
import { advanceAnnouncerCursor, clearAnnouncements, dismissAnnouncement, getAnnouncerEntries, markAnnouncementListened, setAnnouncerLive } from '../api/index.js';
import { renderScript } from './announcerEmphasis.js';
import { LiveSession } from './announcerLive.js';
import { anchoredPosition, clampPosition, type Point } from './announcerPipPosition.js';
import { AnnouncerPlayer, type PlayerState } from './announcerPlayer.js';
import { clearAnnouncerSession, reelPrefixListenTargets, saveAnnouncerSession } from './announcerSession.js';
import { getAnnouncerSpeechRate, RATE_STEPS, setAnnouncerSpeechRate } from './announcerSpeechRate.js';
import { getProjectBusySecrets } from './channelUI.js';
import { confirmDialog } from './confirm.js';
import { byIdOrNull, requireChild, toElement } from './dom.js';
import { renderEditDiffPreview } from './editDiffPreview.js';
import { timeAgo } from './timeAgo.js';
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
// lucide "square" (filled) — the explicit Stop button (HS-8827): ends the
// session entirely, as opposed to the X which now just hides the panel.
const STOP_ICON = <svg {...LUCIDE}><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/></svg>;
// lucide "trash-2" — clear all announcements in the current view (HS-8827).
const TRASH_ICON = <svg {...LUCIDE}><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>;
// lucide "radio" — the Live (tail work as it happens) toggle.
const LIVE_ICON = <svg {...LUCIDE}><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/></svg>;
// lucide "fast-forward" — skip-catch-up (jump to the newest entry).
const SKIP_LIVE_ICON = <svg {...LUCIDE}><polygon points="13 19 22 12 13 5 13 19"/><polygon points="2 19 11 12 2 5 2 19"/></svg>;
// lucide "maximize-2" / "minimize-2" — the expand/collapse (resize) toggle.
const EXPAND_ICON = <svg {...LUCIDE}><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/></svg>;
const COLLAPSE_ICON = <svg {...LUCIDE}><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" x2="21" y1="10" y2="3"/><line x1="3" x2="10" y1="21" y2="14"/></svg>;

/** Remembered expand (resize) state (HS-8749). */
const EXPANDED_KEY = 'hotsheet:announcer-pip-expanded';

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

/**
 * The text actually spoken for a reel entry (HS-8782). In "All Projects" mode
 * the listener can't see the visual project chip, so the spoken narration leads
 * with the owning project name to reiterate which project each entry is about;
 * in a single-project context the project is implicit, so it's just the script.
 * Pure + exported for unit testing.
 */
export function reelSpeechText(entry: ReelEntry, context: string): string {
  if (context !== ALL_PROJECTS) return entry.script;
  const name = entry.projectName.trim();
  return name === '' ? entry.script : `In ${name}: ${entry.script}`;
}

/**
 * HS-8827 — which project secrets a "Clear all" press wipes for a given context:
 * in "All Projects" mode every offered project; otherwise just the selected one.
 * Pure + exported for unit testing.
 */
export function clearTargetSecrets(context: string, projects: AnnouncerProjectInfo[]): string[] {
  return context === ALL_PROJECTS ? projects.map(p => p.secret) : [context];
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
  /** HS-8804 — restore a persisted session: start at this entry index (default 0),
   *  paused instead of auto-playing, and/or already minimized. */
  startIndex?: number;
  startPaused?: boolean;
  startMinimized?: boolean;
}

let openHandle: AnnouncerPipHandle | null = null;
/** The live player behind the open PIP, so the permission-announcement path can
 *  coordinate (speak between segments) without interrupting narration (HS-8781).
 *  Null when no PIP session is mounted. */
let activePlayer: AnnouncerPlayer<ReelEntry> | null = null;

/** The currently-mounted PIP's player, or null. Used by the permission-speech
 *  coordinator to pre-empt upcoming segments at a boundary (HS-8781). */
export function getActiveAnnouncerPlayer(): AnnouncerPlayer<ReelEntry> | null {
  return activePlayer;
}

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
  // HS-8827 — drop the "Speaking via system/browser voice" labels (noise); keep
  // only the actionable "no voice available" warning.
  const backendHint = engine.backend === 'none'
    ? 'No speech voice available — transcript only.'
    : '';

  const panel = toElement(
    <div className="announcer-pip" role="region" aria-label="Announcer transcript">
      <div className="announcer-pip-header">
        <span className="announcer-pip-eyebrow">Announcer</span>
        <span className="announcer-pip-title"></span>
        <button className="announcer-pip-expand" type="button" title="Expand" aria-label="Expand announcer" aria-pressed="false">{EXPAND_ICON}</button>
        {/* HS-8827 — the X now HIDES the panel (keeps playing); the dedicated
            minimize button is gone and the new Stop button ends the session. */}
        <button className="announcer-pip-close" type="button" title="Hide (keeps playing)" aria-label="Hide announcer">{CLOSE_ICON}</button>
        <button className="announcer-pip-stop" type="button" title="Stop and close" aria-label="Stop and close announcer">{STOP_ICON}</button>
      </div>
      <div className="announcer-pip-context">
        <select className="announcer-pip-context-select" aria-label="Announcer context">
          <option value={ALL_PROJECTS}>All Projects</option>
          {opts.projects.map(p => <option value={p.secret}>{p.name}</option>)}
        </select>
        {/* HS-8767 — Live toggle: tail work as it happens. */}
        <button className="announcer-pip-live" type="button" title="Live — narrate work as it happens" aria-pressed="false">{LIVE_ICON}<span>Live</span></button>
      </div>
      <div className="announcer-pip-body">
        <span className="announcer-pip-project-chip" hidden></span>
        <p className="announcer-pip-script"></p>
        {/* HS-8772 — tier-2 code-diff visual, shown only when the current entry
            carries one (curated via hotsheet_announce). */}
        <div className="announcer-pip-visual" hidden></div>
      </div>
      <div className="announcer-pip-footer">
        <div className="announcer-pip-controls">
          <button className="announcer-pip-btn announcer-pip-prev" type="button" title="Previous entry" aria-label="Previous entry">{PREV_ICON}</button>
          <button className="announcer-pip-btn announcer-pip-playpause" type="button" title="Play" aria-label="Play">{PLAY_ICON}</button>
          <button className="announcer-pip-btn announcer-pip-next" type="button" title="Next entry" aria-label="Next entry">{NEXT_ICON}</button>
          <button className="announcer-pip-btn announcer-pip-skip" type="button" title="Not interested — skip and dismiss" aria-label="Skip and dismiss entry">{SKIP_ICON}</button>
          <button className="announcer-pip-btn announcer-pip-skip-live" type="button" hidden title="Skip to live — jump to the newest entry" aria-label="Skip to live">{SKIP_LIVE_ICON}</button>
        </div>
        <div className="announcer-pip-meta">
          <span className="announcer-pip-position" aria-live="polite"></span>
          {/* HS-8827 — per-announcement timestamp (relative; absolute on hover). */}
          <span className="announcer-pip-timestamp"></span>
          <label className="announcer-pip-speed">
            Speed
            <select className="announcer-pip-rate" aria-label="Playback speed">
              {RATE_STEPS.map(s => <option value={String(s)}>{`${String(s)}×`}</option>)}
            </select>
          </label>
          {/* HS-8827 — clear every announcement in the current view. */}
          <button className="announcer-pip-clear" type="button" title="Clear all announcements" aria-label="Clear all announcements">{TRASH_ICON}</button>
          <span className="announcer-pip-hint" hidden={backendHint === ''}>{backendHint}</span>
        </div>
      </div>
    </div>,
  );

  const titleEl = requireChild<HTMLSpanElement>(panel, '.announcer-pip-title');
  const scriptEl = requireChild<HTMLParagraphElement>(panel, '.announcer-pip-script');
  const positionEl = requireChild<HTMLSpanElement>(panel, '.announcer-pip-position');
  const timestampEl = requireChild<HTMLSpanElement>(panel, '.announcer-pip-timestamp');
  const playPauseBtn = requireChild<HTMLButtonElement>(panel, '.announcer-pip-playpause');
  const rateSelect = requireChild<HTMLSelectElement>(panel, '.announcer-pip-rate');
  const contextSelect = requireChild<HTMLSelectElement>(panel, '.announcer-pip-context-select');
  const chipEl = requireChild<HTMLSpanElement>(panel, '.announcer-pip-project-chip');
  const visualEl = requireChild<HTMLDivElement>(panel, '.announcer-pip-visual');
  const liveBtn = requireChild<HTMLButtonElement>(panel, '.announcer-pip-live');
  const skipLiveBtn = requireChild<HTMLButtonElement>(panel, '.announcer-pip-skip-live');
  const header = requireChild<HTMLDivElement>(panel, '.announcer-pip-header');
  const expandBtn = requireChild<HTMLButtonElement>(panel, '.announcer-pip-expand');

  let closed = false;
  let minimized = false;
  // The reel currently in the player — kept in sync so the live session can seed
  // its dedup set + the consumer knows what's already shown (HS-8767).
  let currentEntries: ReelEntry[] = [...entries];

  // HS-8772 — render (or clear) the current entry's code-diff visual. Reuses the
  // §47 permission-overlay diff renderer (`renderEditDiffPreview`).
  const renderVisual = (entry: ReelEntry): void => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 'diff' is the only visual variant today; the discriminant check is forward-compat for image/chart variants.
    const diff = entry.visuals.find(v => v.type === 'diff');
    if (diff === undefined) { visualEl.replaceChildren(); visualEl.hidden = true; return; }
    visualEl.replaceChildren(renderEditDiffPreview({
      oldStr: diff.oldStr, newStr: diff.newStr, filePath: diff.filePath, replaceAll: diff.replaceAll, truncated: false,
    }));
    visualEl.hidden = false;
  };

  // HS-8804 — snapshot the session (context, position, play/paused, minimized) to
  // localStorage so a reload / relaunch restores exactly where the user was. A
  // function declaration so the player callbacks below can call it (hoisted); it
  // reads the live `player` / `minimized` / `currentContext` at call time, which
  // is always after construction.
  function persistSession(): void {
    if (closed) return;
    const entry = player.getCurrentEntry();
    saveAnnouncerSession({
      context: currentContext,
      entryId: entry?.id ?? null,
      entryProjectSecret: entry?.projectSecret ?? null,
      playing: player.getState() === 'playing',
      minimized,
    });
  }

  const player = new AnnouncerPlayer<ReelEntry>(entries, engine, {
    onEntryChange(index, entry, total) {
      titleEl.textContent = entry.title;
      renderScript(scriptEl, entry.script, entry.emphasis);
      renderVisual(entry);
      positionEl.textContent = `${String(index + 1)} / ${String(total)}`;
      // HS-8827 — per-announcement timestamp: relative text, absolute on hover.
      timestampEl.textContent = timeAgo(entry.created_at);
      timestampEl.title = new Date(entry.created_at).toLocaleString();
      // Show which project the entry is about, but only in "All Projects" mode
      // (in a single-project context it's redundant). HS-8762.
      if (currentContext === ALL_PROJECTS) {
        chipEl.textContent = entry.projectName;
        chipEl.hidden = false;
      } else {
        chipEl.hidden = true;
      }
      persistSession(); // HS-8804 — position changed
      // HS-8803 — landing on an entry (incl. skipping ahead / jumping to live)
      // marks the WHOLE consumed reel prefix heard, not just this entry, so the
      // pages the user leapt over clear instead of piling up. The reel can span
      // projects, so mark one representative per project (`reelPrefixListenTargets`);
      // the server stamps each project's whole prefix from there. Best-effort.
      const reel = player.getEntries();
      const nowIso = new Date().toISOString();
      for (let i = 0; i <= index && i < reel.length; i++) reel[i].listened_at = nowIso;
      for (const target of reelPrefixListenTargets(reel, index)) {
        markAnnouncementListened(target.id, target.projectSecret).catch(() => { /* best-effort */ });
      }
    },
    onStateChange(state: PlayerState) {
      const playing = state === 'playing';
      playPauseBtn.replaceChildren(toElement(playing ? PAUSE_ICON : PLAY_ICON));
      playPauseBtn.title = playing ? 'Pause' : 'Play';
      playPauseBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      panel.classList.toggle('is-playing', playing);
      panel.classList.toggle('is-done', state === 'done');
      persistSession(); // HS-8804 — play/paused changed
    },
    onRemove(entry) {
      // Persist the dismissal in the entry's OWN project (HS-8762 — ids aren't
      // unique across projects, so dismiss must target the owning project).
      dismissAnnouncement(entry.id, entry.projectSecret).catch(() => { /* best-effort */ });
    },
    // HS-8782 — in "All Projects" mode, speak the project name before the script
    // so the listener knows which project each entry refers to. Reads the live
    // `currentContext` so it follows context-dropdown switches.
    speechTextFor: (entry) => reelSpeechText(entry, currentContext),
  });

  // --- Context dropdown (HS-8762): switch which project's reel plays. ---
  // HS-8827 — switching is now allowed WHILE LIVE: if a live session is running
  // we stop it on the old context, swap the reel, then resume live tailing on
  // the new context's secrets. (Pre-fix the dropdown was disabled in live mode.)
  contextSelect.value = currentContext;
  contextSelect.addEventListener('change', () => {
    const next = contextSelect.value;
    if (next === currentContext) return;
    const wasLive = liveSession !== null;
    contextSelect.disabled = true;
    void (async () => {
      try {
        if (wasLive) await stopLive();
        const reel = await (opts.onContextChange?.(next) ?? Promise.resolve<ReelEntry[]>([]));
        currentContext = next;
        currentEntries = reel;
        player.setEntries(reel);
        persistSession(); // HS-8804 — context changed
        if (wasLive) await startLive(); // HS-8827 — retarget live to the new context
      } catch {
        contextSelect.value = currentContext;
      } finally {
        contextSelect.disabled = false;
      }
    })();
  });

  // --- Live mode (HS-8767): tail work as it happens, with a "still working"
  //     presence line + a skip-to-live control. ---
  let liveSession: LiveSession | null = null;
  let liveStarting = false; // guards the async disclosure window against double-clicks
  const liveSecrets = (): string[] => currentContext === ALL_PROJECTS
    ? opts.projects.filter(p => p.hasKey).map(p => p.secret)
    : [currentContext];
  const projectNameOf = (secret: string): string => opts.projects.find(p => p.secret === secret)?.name ?? '';
  const fetchReel = async (secret: string): Promise<ReelEntry[]> =>
    (await getAnnouncerEntries(secret)).map(e => ({ ...e, projectSecret: secret, projectName: projectNameOf(secret) }));
  const startLive = async (): Promise<void> => {
    if (liveStarting || liveSession !== null) return;
    liveStarting = true;
    try { await startLiveInner(); } finally { liveStarting = false; }
  };
  const startLiveInner = async (): Promise<void> => {
    // HS-8770 — one-time spend + privacy disclosure: live mode continuously
    // sends work to Anthropic on the user's key. Remembered once accepted.
    const DISCLOSED_KEY = 'hotsheet:announcer-live-disclosed';
    let disclosed = false;
    try { disclosed = window.localStorage.getItem(DISCLOSED_KEY) !== null; } catch { /* private mode */ }
    if (!disclosed) {
      const ok = await confirmDialog({
        title: 'Go Live?',
        message: 'Live mode continuously sends this project’s notes + activity to Anthropic using your API key as work happens — so it spends while it runs (a departure from Hot Sheet’s local-only default). It pauses when this window is in the background. Continue?',
        confirmLabel: 'Go Live',
        cancelLabel: 'Cancel',
      });
      if (!ok) return;
      try { window.localStorage.setItem(DISCLOSED_KEY, '1'); } catch { /* private mode */ }
    }
    liveSession = new LiveSession({
      projectSecrets: liveSecrets(),
      fetchEntries: fetchReel,
      setLive: (enabled, secret) => setAnnouncerLive(enabled, secret),
      isBusy: (ss) => { const busy = getProjectBusySecrets(); return ss.some(s => busy.has(s)); },
      onNewEntries: (es) => { currentEntries.push(...es); player.appendEntries(es); },
      // HS-8827 — the idle/working presence label was removed; live still polls
      // busy state to drive generation, it just no longer surfaces it as text.
      onPresence: () => { /* no-op */ },
    });
    liveSession.seed(currentEntries);
    panel.classList.add('is-live');
    liveBtn.setAttribute('aria-pressed', 'true');
    skipLiveBtn.hidden = false;
    await liveSession.start();
  };
  const stopLive = async (): Promise<void> => {
    const session = liveSession;
    liveSession = null;
    panel.classList.remove('is-live');
    liveBtn.setAttribute('aria-pressed', 'false');
    skipLiveBtn.hidden = true;
    await session?.stop();
  };
  liveBtn.addEventListener('click', () => {
    if (liveSession === null) void startLive();
    else void stopLive();
  });
  skipLiveBtn.addEventListener('click', () => {
    player.jumpToLast();
    for (const secret of liveSecrets()) advanceAnnouncerCursor(undefined, secret).catch(() => { /* best-effort */ });
  });
  // Catch up immediately when the window returns to the foreground.
  const onVisibilityChange = (): void => {
    if (liveSession !== null && document.visibilityState === 'visible') void liveSession.poll();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

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

  // --- Expand/collapse (HS-8749): a roomier panel for long scripts. The
  //     expanded size lives in SCSS (`.announcer-pip.is-expanded`); toggling it
  //     grows the box, so re-clamp the position to keep it fully on screen. ---
  const loadExpanded = (): boolean => {
    try { return window.localStorage.getItem(EXPANDED_KEY) !== null; } catch { return false; }
  };
  const applyExpanded = (expanded: boolean): void => {
    panel.classList.toggle('is-expanded', expanded);
    expandBtn.replaceChildren(toElement(expanded ? COLLAPSE_ICON : EXPAND_ICON));
    expandBtn.title = expanded ? 'Collapse' : 'Expand';
    expandBtn.setAttribute('aria-label', expanded ? 'Collapse announcer' : 'Expand announcer');
    expandBtn.setAttribute('aria-pressed', expanded ? 'true' : 'false');
    // The size just changed — re-clamp from the current top-left so a grown
    // panel doesn't spill off the viewport.
    const rect = panel.getBoundingClientRect();
    applyPosition({ left: rect.left, top: rect.top });
  };
  expandBtn.addEventListener('click', () => {
    const next = !panel.classList.contains('is-expanded');
    try {
      if (next) window.localStorage.setItem(EXPANDED_KEY, '1');
      else window.localStorage.removeItem(EXPANDED_KEY);
    } catch { /* private mode — still toggle for this session */ }
    applyExpanded(next);
  });

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (liveSession !== null) void stopLive();
    player.dispose();
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('hotsheet:announcer-rate-changed', onRateChanged);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    panel.remove();
    if (openHandle === handle) { openHandle = null; activePlayer = null; }
    // HS-8804 — an explicit close dismisses the session, so it must NOT be
    // restored on the next launch. (A quit/reload leaves the last snapshot in
    // place, which is what gets restored.)
    clearAnnouncerSession();
    opts.onClose?.(currentContext);
  };

  const minimize = (): void => {
    if (closed || minimized) return;
    minimized = true;
    panel.style.display = 'none';
    persistSession(); // HS-8804 — minimized changed
    opts.onMinimize?.();
  };

  const restore = (): void => {
    if (closed || !minimized) return;
    minimized = false;
    panel.style.display = '';
    placeInitial();
    persistSession(); // HS-8804 — minimized changed
    opts.onRestore?.();
  };

  // HS-8827 — render the "nothing to show" state after a Clear All (or any time
  // the reel empties). Leaves the panel open so live tailing can refill it.
  const renderEmptyState = (): void => {
    titleEl.textContent = '';
    scriptEl.textContent = 'No announcements.';
    positionEl.textContent = '0 / 0';
    timestampEl.textContent = '';
    timestampEl.title = '';
    chipEl.hidden = true;
    visualEl.replaceChildren();
    visualEl.hidden = true;
  };

  // HS-8827 — Clear All: permanently wipe every announcement in the current view
  // (all offered projects in "All Projects" mode, else the selected project),
  // behind a confirm. The reel empties; the panel stays open.
  const clearAll = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Clear all announcements?',
      message: 'This permanently removes every announcement in the current view. This cannot be undone.',
      confirmLabel: 'Clear All',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok || closed) return;
    const secrets = clearTargetSecrets(currentContext, opts.projects);
    await Promise.all(secrets.map(s => clearAnnouncements(s).catch(() => { /* best-effort per project */ })));
    currentEntries = [];
    player.setEntries([]); // interrupts narration + transitions to 'done'
    renderEmptyState();
    persistSession();
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

  // HS-8827 — the X now hides (minimizes); the new Stop button ends the session.
  requireChild<HTMLButtonElement>(panel, '.announcer-pip-close').addEventListener('click', minimize);
  requireChild<HTMLButtonElement>(panel, '.announcer-pip-stop').addEventListener('click', close);
  requireChild<HTMLButtonElement>(panel, '.announcer-pip-clear').addEventListener('click', () => { void clearAll(); });
  requireChild<HTMLButtonElement>(panel, '.announcer-pip-prev').addEventListener('click', () => player.prev());
  playPauseBtn.addEventListener('click', () => player.togglePlayPause());
  requireChild<HTMLButtonElement>(panel, '.announcer-pip-next').addEventListener('click', () => player.next());
  requireChild<HTMLButtonElement>(panel, '.announcer-pip-skip').addEventListener('click', () => player.removeCurrent());
  document.addEventListener('keydown', onKeydown, true);

  document.body.appendChild(panel);
  // Restore the remembered expanded state before placing, so placeInitial clamps
  // against the right (possibly larger) size.
  if (loadExpanded()) {
    panel.classList.add('is-expanded');
    expandBtn.replaceChildren(toElement(COLLAPSE_ICON));
    expandBtn.title = 'Collapse';
    expandBtn.setAttribute('aria-label', 'Collapse announcer');
    expandBtn.setAttribute('aria-pressed', 'true');
  }
  placeInitial();

  const handle: AnnouncerPipHandle = { close, minimize, restore, isMinimized: () => minimized };
  openHandle = handle;
  activePlayer = player;

  // Kick off narration. HS-8804 — on a restored session, start at the saved
  // entry, in the saved play/paused state, and minimized if it was minimized;
  // otherwise the default fresh open is index 0, auto-playing, visible.
  player.startAt(opts.startIndex ?? 0, opts.startPaused !== true);
  if (opts.startMinimized === true) {
    minimize();
  } else {
    // Focus the play/pause button so the keyboard shortcuts work immediately.
    playPauseBtn.focus();
  }

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
