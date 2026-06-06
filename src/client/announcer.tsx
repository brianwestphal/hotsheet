/**
 * §78 Announcer — the header "Listen" affordance and the generate→play flow
 * that ties the typed API callers (`src/api/announcer.ts`) to the transcript
 * PIP (`announcerPip.tsx`).
 *
 * HS-8762/8758 — the announcer is now **cross-project**:
 *  - The Listen button is shown whenever *any* project has the announcer
 *    enabled + keyed (`getAnnouncerOverview`), on every tab — not just when the
 *    active project is configured.
 *  - The PIP has a **context dropdown** ("All Projects" + each enabled project).
 *    Default context = the active project when launched from a project tab, or
 *    "All Projects" from a global surface (terminal dashboard / cross-project
 *    stats). "All Projects" aggregates each enabled project's already-generated
 *    entries, interleaved chronologically, with a per-entry project chip.
 *  - Only a *specific-project* launch generates a fresh batch (one Anthropic
 *    round-trip for that project); "All Projects" aggregates existing entries
 *    only. The listened cursor advances per relevant project when the PIP closes.
 */
import { advanceAnnouncerCursor, type AnnouncerProjectInfo, generateAnnouncements, getAnnouncerEntries, getAnnouncerOverview } from '../api/index.js';
import { ALL_PROJECTS, getAnnouncerPipHandle, openAnnouncerPip, type ReelEntry } from './announcerPip.js';
import { byIdOrNull } from './dom.js';
import { showToast } from './toast.js';

function listenButton(): HTMLButtonElement | null {
  return byIdOrNull<HTMLButtonElement>('announcer-listen-btn');
}

/** Are we on a global surface (no single active project in focus)? Then the
 *  announcer defaults to "All Projects" rather than a specific project. */
function isGlobalContext(): boolean {
  return document.body.classList.contains('terminal-dashboard-active')
    || document.body.classList.contains('cross-project-stats-active');
}

/** Show/hide the Listen button. Visible whenever ANY project has the announcer
 *  enabled + configured (HS-8758). Called at init, after settings changes, and
 *  on project switch. */
export async function refreshAnnouncerVisibility(): Promise<void> {
  const btn = listenButton();
  if (btn === null) return;
  try {
    const overview = await getAnnouncerOverview();
    // HS-8790/8792 — a project is narratable with an Anthropic key OR an on-device
    // provider (Apple Foundation Models / a reachable local endpoint), both
    // machine-global. `overview.projects` is already filtered to enabled projects,
    // so any of them + on-device availability is enough.
    const onDevice = overview.appleAvailable || overview.localAvailable;
    const usable = overview.projects.some(p => p.hasKey) || (onDevice && overview.projects.length > 0);
    btn.style.display = usable ? '' : 'none';
  } catch {
    btn.style.display = 'none';
  }
}

/** Glow + relabel the Listen button while a session is minimized (HS-8757). */
function setMinimizedState(btn: HTMLButtonElement, minimized: boolean): void {
  btn.classList.toggle('is-active', minimized);
  btn.title = minimized ? 'Show announcer (still playing)' : 'Listen to recent work';
  btn.setAttribute('aria-label', btn.title);
}

/** Build the reel for a context from already-generated entries (HS-8762).
 *  "All Projects" unions every enabled project's entries, interleaved by time. */
async function loadReel(context: string, projects: AnnouncerProjectInfo[]): Promise<ReelEntry[]> {
  if (context === ALL_PROJECTS) {
    const perProject = await Promise.all(projects.map(async (p) => {
      try {
        return (await getAnnouncerEntries(p.secret)).map(e => ({ ...e, projectSecret: p.secret, projectName: p.name }));
      } catch { return []; }
    }));
    return perProject.flat().sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  const name = projects.find(p => p.secret === context)?.name ?? '';
  try {
    return (await getAnnouncerEntries(context)).map(e => ({ ...e, projectSecret: context, projectName: name }));
  } catch { return []; }
}

/** Advance the listened cursor for the project(s) the closed reel covered. */
function advanceCursors(context: string, projects: AnnouncerProjectInfo[]): void {
  const targets = context === ALL_PROJECTS ? projects.map(p => p.secret) : [context];
  for (const secret of targets) advanceAnnouncerCursor(undefined, secret).catch(() => { /* best-effort */ });
}

async function startListening(btn: HTMLButtonElement): Promise<void> {
  // HS-8757 / HS-8788 — if a session is already running, the button TOGGLES the
  // panel rather than starting a new reel: minimized → restore, visible →
  // minimize (playback continues either way).
  const existing = getAnnouncerPipHandle();
  if (existing !== null) {
    if (existing.isMinimized()) existing.restore();
    else existing.minimize();
    return;
  }
  if (btn.classList.contains('is-busy')) return;
  btn.classList.add('is-busy');
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  // HS-8753 — generation can take several seconds (an Anthropic round-trip), so
  // give immediate feedback that the click registered. The button also shows a
  // spinner via `.is-busy` (styles.scss) for the whole wait.
  showToast('Preparing your narration…', { variant: 'info', durationMs: 2500 });
  try {
    const overview = await getAnnouncerOverview();
    const projects = overview.projects;
    if (projects.length === 0) {
      showToast('No projects have the Announcer enabled.', { durationMs: 4000 });
      return;
    }

    // Default context: the active project from a project tab; "All Projects"
    // from a global surface (dashboard / stats).
    let context = ALL_PROJECTS;
    if (!isGlobalContext() && overview.activeSecret !== null
      && projects.some(p => p.secret === overview.activeSecret)) {
      context = overview.activeSecret;
    }

    // Generate fresh work ONLY for a specific-project launch (per the design,
    // "All Projects" aggregates existing entries without new generation).
    // HS-8790/8792 — generation needs an Anthropic key OR an on-device provider
    // (Apple Foundation Models / a reachable local endpoint).
    const canGenerate = (projects.find(p => p.secret === context)?.hasKey ?? false) || overview.appleAvailable || overview.localAvailable;
    if (context !== ALL_PROJECTS && canGenerate) {
      try {
        await generateAnnouncements({}, context);
      } catch {
        showToast('Announcer: could not generate new entries (check your API key).', { variant: 'warning', durationMs: 5000 });
      }
    }

    const reel = await loadReel(context, projects);
    if (reel.length === 0) {
      showToast('Nothing new to announce yet — do some work and try again.', { durationMs: 4000 });
      return;
    }

    openAnnouncerPip(reel, {
      context,
      projects,
      anchorEl: btn,
      onContextChange: (ctx) => loadReel(ctx, projects),
      onMinimize: () => { setMinimizedState(btn, true); },
      onRestore: () => { setMinimizedState(btn, false); },
      onClose: (finalContext) => {
        setMinimizedState(btn, false);
        advanceCursors(finalContext, projects);
        void refreshAnnouncerVisibility();
      },
    });
  } finally {
    btn.classList.remove('is-busy');
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  }
}

/** Bind the header Listen button + set its initial visibility. */
export function initAnnouncer(): void {
  const btn = listenButton();
  if (btn === null) return;
  btn.addEventListener('click', () => { void startListening(btn); });
  void refreshAnnouncerVisibility();
}
