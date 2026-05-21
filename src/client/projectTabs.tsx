import type { SafeHtml } from '../jsx-runtime.js';
import { api } from './api.js';
import { getProjectAttentionSecrets, getProjectBusySecrets, setChannelAlive } from './channelUI.js';
import { byIdOrNull, toElement } from './dom.js';
import { ICON_CLOSE_LEFT, ICON_CLOSE_OTHERS, ICON_CLOSE_RIGHT, ICON_FOLDER, ICON_X } from './icons.js';
import { recordInteraction } from './longTaskObserver.js';
import { getMinimizedPermissionSecrets, reopenMinimizedForSecret } from './permissionOverlay.js';
import { activeProjectSignal, projectsStore } from './projectsStore.js';
import { computed, effect } from './reactive.js';
import { bindList } from './reactive-bind.js';
import type { ProjectInfo } from './state.js';
import { clearPerProjectSessionState, getActiveProject, setActiveProject } from './state.js';
import { getTelemetryCostMode } from './telemetryCostMode.js';

/** Callback to reload all app data after switching projects. Set by app.tsx during init. */
let reloadCallback: (() => Promise<void>) | null = null;

/** Register the reload callback (called from app.tsx init). */
export function setProjectReloadCallback(cb: () => Promise<void>) {
  reloadCallback = cb;
}

/** Projects with pending feedback. Pre-HS-8378 this set was only ever
 *  populated for the *active* project via the client-side
 *  `feedbackDialog.checkFeedbackState()` scan of `state.tickets`, so the
 *  project-tab purple dot was invisible on every non-active project. Now
 *  it's also bulk-refreshed from the server's `/api/projects/feedback-state`
 *  endpoint on every poll-version bump (see `refreshProjectFeedbackState`
 *  below). Active-project writes via `setProjectFeedback` still happen
 *  inline so the dot updates as soon as the user submits / resolves a
 *  feedback request without waiting for the next poll. */
const feedbackSecrets = new Set<string>();

export function setProjectFeedback(secret: string, hasFeedback: boolean) {
  if (hasFeedback) feedbackSecrets.add(secret);
  else feedbackSecrets.delete(secret);
  updateStatusDots();
}

/** HS-8378 — bulk refresh of `feedbackSecrets` from the server's cross-
 *  project aggregator. Called from `poll.tsx` on every poll-version bump
 *  so a FEEDBACK NEEDED note added on Project B shows up as a purple dot
 *  on the Project B tab even while the user is viewing Project A. */
export async function refreshProjectFeedbackState(): Promise<void> {
  try {
    const data = await api<{ projects: Record<string, boolean> }>('/projects/feedback-state');
    feedbackSecrets.clear();
    for (const [secret, hasFeedback] of Object.entries(data.projects)) {
      if (hasFeedback) feedbackSecrets.add(secret);
    }
  } catch { /* network blip — leave the previous snapshot in place */ }
  updateStatusDots();
}

/** Test-only — expose `feedbackSecrets` membership so unit tests can
 *  assert the bulk-refresh behavior without spying on the DOM. */
export function _hasProjectFeedbackForTests(secret: string): boolean {
  return feedbackSecrets.has(secret);
}

/** **HS-8317 (2026-05-10)** — pre-fix this file held its own
 *  `projectListSignal` + `activeSecretSignal` (HS-8235). Both were
 *  consolidated into the kerf `projectsStore` (`src/client/projectsStore.ts`)
 *  so the tab strip + the `getActiveProject()` accessor + every other
 *  consumer reads from a single source of truth. The bindList in
 *  `renderTabs` now binds against `projectsStore.state.value.projects`
 *  via a thin `projectsListSignal` computed below; per-row active-class
 *  effects read from `activeProjectSignal.value?.secret`. */
// Cheap helper so bindList can take a `ReadonlySignal<readonly
// ProjectInfo[]>` without leaking the full store shape into the binding
// helper. kerf's `computed()` re-tracks the parent state field; bindList
// only fires when the projects-array reference changes (i.e. setProjects
// calls).
const projectsListSignal = computed(() => projectsStore.state.value.projects);

/**
 * Initialize project tabs. Fetches the project list, sets the active project,
 * and renders the tab bar if there are multiple projects.
 * Must be called before any other API calls so activeProject is set.
 */
export async function initProjectTabs(): Promise<void> {
  try {
    // HS-8085 — first call before `setActiveProject`, so the api helper
    // emits a plain GET with no `?project=` query (no active project to
    // auth against yet). That matches the pre-fix raw-fetch behavior.
    projectsStore.actions.setProjects(await api<ProjectInfo[]>('/projects'));
  } catch {
    projectsStore.actions.setProjects([]);
  }

  if (projectsStore.state.value.projects.length === 0) return;

  const urlParams = new URLSearchParams(window.location.search);
  const requestedSecret = urlParams.get('project');
  const requestedProject = requestedSecret !== null
    ? projectsStore.state.value.projects.find(p => p.secret === requestedSecret)
    : undefined;

  setActiveProject(requestedProject ?? projectsStore.state.value.projects[0]);

  if (requestedSecret !== null) {
    const url = new URL(window.location.href);
    url.searchParams.delete('project');
    window.history.replaceState({}, '', url.toString());
  }

  renderTabs();
  void refreshProjectChannelStatus();
  // HS-7825 — hydrate persisted hidden-terminal state for every project so
  // the dashboard's per-project filter starts in the right state on first
  // open. Fire-and-forget; the dashboard renders an unfiltered view if the
  // hydration is slower than the user's first toggle.
  void (async () => {
    const { initPersistedHiddenTerminals } = await import('./persistedHiddenTerminals.js');
    await initPersistedHiddenTerminals();
  })();
}

/** Switch to a different project. */
export async function switchProject(project: ProjectInfo): Promise<void> {
  if (getActiveProject()?.secret === project.secret) return;
  // HS-8054 — record the interaction so any subsequent main-thread
  // longtask observation includes the project switch in its context
  // line.
  recordInteraction(`project-switch:${project.name}`);
  setActiveProject(project);
  renderTabs();
  void api('/ensure-skills', { method: 'POST' });
  if (reloadCallback) {
    await reloadCallback();
  }
}

/** **HS-8431** — secrets of the user's most recent drag-reorder, held
 *  here while the corresponding `/api/projects/reorder` POST is in
 *  flight (or just landed but the server's GET `/api/projects` hasn't
 *  caught up yet). `refreshProjectTabs` re-projects the server's
 *  response through this order before calling `setProjects`, so a
 *  poll-driven GET that races the unawaited POST can't snap the tabs
 *  back to their pre-drop arrangement. Cleared when the POST resolves
 *  (success or error). */
let pendingReorderSecrets: readonly string[] | null = null;

/** Re-fetch and re-render tabs (e.g., after adding/removing a project). */
export async function refreshProjectTabs(): Promise<void> {
  try {
    let list = await api<ProjectInfo[]>('/projects');
    // HS-8431 — re-sort the server response by the user's pending
    // reorder so a GET that races the unawaited reorder POST can't
    // visually revert the drop. The flag stays set until a GET
    // response actually confirms the server has applied the reorder
    // (i.e. its first N entries match `pendingReorderSecrets`). Only
    // then is it safe to forget the pending order — clearing earlier
    // (e.g. in the POST's `finally`) loses to in-flight GETs whose
    // responses arrive AFTER the POST's response but with the pre-
    // reorder server order. That was the production-only race the
    // user kept hitting: a fast POST + a GET issued mid-POST whose
    // response landed after the clear.
    if (pendingReorderSecrets !== null) {
      const matches = list.length >= pendingReorderSecrets.length
        && pendingReorderSecrets.every((s, i) => list[i].secret === s);
      if (matches) {
        // Server has caught up — the reorder is fully persisted and
        // visible. Forget the pending order so future GETs pass
        // through verbatim (a different-from-pending order from
        // here on represents real server state, not race lag).
        pendingReorderSecrets = null;
      } else {
        const byId = new Map(list.map(p => [p.secret, p]));
        const sorted: ProjectInfo[] = [];
        for (const s of pendingReorderSecrets) {
          const p = byId.get(s);
          if (p !== undefined) sorted.push(p);
        }
        for (const p of list) {
          if (!sorted.includes(p)) sorted.push(p);
        }
        list = sorted;
      }
    }
    projectsStore.actions.setProjects(list);
  } catch {
    projectsStore.actions.setProjects([]);
  }
  renderTabs();
  // HS-8293 — pre-fix this re-hydrated `dashboard.visibilityGroupings`
  // from `/api/global-config` on every poll-driven `refreshProjectTabs`.
  // Post-HS-8290 the visibility state lives entirely in the global config
  // (no per-project bits), so a project-list change has nothing to
  // re-hydrate. Worse, the re-hydrate destroyed in-flight in-memory
  // toggles: if the user toggled a row between the moment the previous
  // PATCH landed and the next poll's hydrate fired, the hydrate
  // overwrote the toggle with the (now-stale) server snapshot, and the
  // next debounced write's `lastPersisted` short-circuit suppressed the
  // PATCH that would have rescued it. Initial hydration still happens
  // exactly once from `initProjectTabs`.
}

/** Switch to the next or previous tab. */
export function switchTabByOffset(offset: number): void {
  const list = projectsStore.state.value.projects;
  if (list.length < 2) return;
  const activeSecret = getActiveProject()?.secret;
  const idx = list.findIndex(p => p.secret === activeSecret);
  if (idx === -1) return;
  const next = (idx + offset + list.length) % list.length;
  void switchProject(list[next]);
}

/** Close the active tab. */
export function closeActiveTab(): void {
  const active = getActiveProject();
  if (active) void removeProject(active);
}

// --- Remove helpers ---

async function removeProject(project: ProjectInfo): Promise<void> {
  if (projectsStore.state.value.projects.length <= 1) return;
  try {
    // HS-8085 — DELETE auths via the URL `:secret` param, not the
    // `X-Hotsheet-Secret` header (see `src/routes/projects.ts:90`); the
    // api helper still adds the active project's secret as the auth
    // header, which the route ignores. Acceptable.
    await api(`/projects/${encodeURIComponent(project.secret)}`, { method: 'DELETE' });
    clearPerProjectSessionState(project.secret);
    if (getActiveProject()?.secret === project.secret) {
      const remaining = projectsStore.state.value.projects.filter(p => p.secret !== project.secret);
      if (remaining.length > 0) await switchProject(remaining[0]);
    }
    await refreshProjectTabs();
  } catch (err) {
    console.error('Failed to remove project:', err);
  }
}

async function removeOtherProjects(keepProject: ProjectInfo): Promise<void> {
  const toRemove = projectsStore.state.value.projects.filter(p => p.secret !== keepProject.secret);
  for (const p of toRemove) {
    await api(`/projects/${encodeURIComponent(p.secret)}`, { method: 'DELETE' });
    clearPerProjectSessionState(p.secret);
  }
  if (getActiveProject()?.secret !== keepProject.secret) {
    await switchProject(keepProject);
  }
  await refreshProjectTabs();
}

async function removeProjectsInDirection(project: ProjectInfo, direction: 'left' | 'right'): Promise<void> {
  const list = projectsStore.state.value.projects;
  const idx = list.findIndex(p => p.secret === project.secret);
  if (idx === -1) return;
  const toRemove = direction === 'left' ? list.slice(0, idx) : list.slice(idx + 1);
  for (const p of toRemove) {
    await api(`/projects/${encodeURIComponent(p.secret)}`, { method: 'DELETE' });
    clearPerProjectSessionState(p.secret);
  }
  if (toRemove.some(p => p.secret === getActiveProject()?.secret)) {
    await switchProject(project);
  }
  await refreshProjectTabs();
}

// --- Context menu ---

function showTabContextMenu(e: MouseEvent, project: ProjectInfo) {
  e.preventDefault();
  // Remove any existing context menu
  byIdOrNull('tab-context-menu')?.remove();

  const list = projectsStore.state.value.projects;
  const idx = list.findIndex(p => p.secret === project.secret);
  const hasLeft = idx > 0;
  const hasRight = idx < list.length - 1;
  const canClose = list.length > 1;

  // HS-7835 — Lucide icons on every entry (matches the §22 terminal-tab
  // context menu visually).
  const items: { label: string; action: () => void; disabled?: boolean; icon: SafeHtml }[] = [
    { label: 'Close Tab', action: () => void removeProject(project), disabled: !canClose, icon: ICON_X },
    { label: 'Close Other Tabs', action: () => void removeOtherProjects(project), disabled: list.length <= 1, icon: ICON_CLOSE_OTHERS },
    { label: 'Close Tabs to the Left', action: () => void removeProjectsInDirection(project, 'left'), disabled: !hasLeft, icon: ICON_CLOSE_LEFT },
    { label: 'Close Tabs to the Right', action: () => void removeProjectsInDirection(project, 'right'), disabled: !hasRight, icon: ICON_CLOSE_RIGHT },
  ];

  const folderIcon = ICON_FOLDER;

  const menu = toElement(
    <div className="tab-context-menu" id="tab-context-menu">
      {items.map(item => (
        <div className={`tab-context-item${item.disabled === true ? ' disabled' : ''}`}>
          <span className="tab-context-icon">{item.icon}</span>
          {item.label}
        </div>
      ))}
      <div className="tab-context-separator"></div>
      <div className="tab-context-item" data-action="reveal">
        <span className="tab-context-icon">{folderIcon}</span>
        Show in Finder
      </div>
    </div>
  );

  // Bind click handlers for close items
  const menuItems = menu.querySelectorAll('.tab-context-item:not([data-action])');
  items.forEach((item, i) => {
    if (item.disabled !== true) {
      menuItems[i].addEventListener('click', () => {
        menu.remove();
        item.action();
      });
    }
  });

  // Bind "Show in Finder" handler
  menu.querySelector('[data-action="reveal"]')!.addEventListener('click', () => {
    menu.remove();
    void api(`/projects/${encodeURIComponent(project.secret)}/reveal`, { method: 'POST' });
  });

  // Position near click
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  document.body.appendChild(menu);

  // Close on outside click
  const close = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node)) {
      menu.remove();
      document.removeEventListener('click', close);
    }
  };
  setTimeout(() => document.addEventListener('click', close), 0);
}

// --- Drag & drop reorder ---

let dragSecret: string | null = null;
let dropIndicator: HTMLElement | null = null;
/** **HS-8432** — single insertion-index model over the visible tab strip
 *  (0..tabs.length). Pre-fix the handler tracked `{secret, side}` per
 *  tab, so "right half of tab N" and "left half of tab N+1" — which
 *  represent the SAME drop position — produced two different indicator
 *  X-coordinates (the +1 / -1 fudges around each tab's edge, plus the
 *  4 px CSS gap, added up to a visible ~2 px jitter as the cursor
 *  crossed the gap). Collapsing the model to one index per gap means
 *  there is genuinely one drop spot per position; the indicator stays
 *  put while the cursor traverses the gap. */
let dropInsertIdx: number | null = null;

function ensureDropIndicator(): HTMLElement {
  if (!dropIndicator) {
    dropIndicator = toElement(<div className="tab-drop-indicator" />);
  }
  return dropIndicator;
}

/** Position the 2 px indicator at gap `insertIdx` in the visible tab
 *  strip. Gap 0 is before the first tab; gap N is after the last; gaps
 *  in between sit centered in the 4 px CSS gap between adjacent tabs so
 *  "after tab N" and "before tab N+1" land on identical pixels. */
function positionIndicator(tabs: HTMLElement[], insertIdx: number) {
  if (tabs.length === 0) return;
  const indicator = ensureDropIndicator();
  const container = tabs[0].closest('.project-tabs-inner');
  if (container === null) return;
  if (!indicator.parentElement) container.appendChild(indicator);

  const containerRect = container.getBoundingClientRect();
  const indicatorWidth = indicator.offsetWidth || 2;
  const halfWidth = indicatorWidth / 2;

  let centerX: number;
  if (insertIdx <= 0) {
    centerX = tabs[0].getBoundingClientRect().left - 2;
  } else if (insertIdx >= tabs.length) {
    centerX = tabs[tabs.length - 1].getBoundingClientRect().right + 2;
  } else {
    const prev = tabs[insertIdx - 1].getBoundingClientRect();
    const next = tabs[insertIdx].getBoundingClientRect();
    centerX = (prev.right + next.left) / 2;
  }

  const x = centerX - containerRect.left + container.scrollLeft - halfWidth;
  indicator.style.left = `${x}px`;
  indicator.style.display = '';
}

function hideIndicator() {
  if (dropIndicator) dropIndicator.style.display = 'none';
  dropInsertIdx = null;
}

function handleDragStart(e: DragEvent, project: ProjectInfo) {
  dragSecret = project.secret;
  e.dataTransfer!.effectAllowed = 'move';
  (e.target as HTMLElement).classList.add('dragging');
}

/** HS-8432 — translate `(hovered tab, cursor side)` into a single gap
 *  index in the visible tab strip. The strip is the source of truth so
 *  every cursor position over a given gap (whether by hovering the
 *  right half of the preceding tab or the left half of the following
 *  tab) maps to the same insertion index. Returns null when the cursor
 *  is over the dragged tab itself (the visible drag opacity is the
 *  affordance for that — no indicator needed). */
function computeInsertIdx(el: HTMLElement, clientX: number, tabs: HTMLElement[]): number | null {
  const tabIdx = tabs.indexOf(el);
  if (tabIdx === -1) return null;
  if (el.dataset.secret === dragSecret) return null;
  const rect = el.getBoundingClientRect();
  const side = clientX < rect.left + rect.width / 2 ? 'before' : 'after';
  return side === 'before' ? tabIdx : tabIdx + 1;
}

function handleDragOver(e: DragEvent) {
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'move';
  const el = e.currentTarget as HTMLElement;
  const container = el.parentElement;
  if (container === null) return;
  const tabs = Array.from(container.querySelectorAll<HTMLElement>('.project-tab'));
  const insertIdx = computeInsertIdx(el, e.clientX, tabs);
  if (insertIdx === null) {
    hideIndicator();
    return;
  }
  if (dropInsertIdx === insertIdx) return;
  dropInsertIdx = insertIdx;
  positionIndicator(tabs, insertIdx);
}

function handleDrop(e: DragEvent, _targetProject: ProjectInfo) {
  e.preventDefault();
  const insertIdx = dropInsertIdx;
  hideIndicator();
  if (dragSecret === null || insertIdx === null) return;

  // HS-8431 — write through the kerf `reorderProjects` action so the
  // signal's `set(...)` contract fires and `bindList` reconciles the
  // tab strip; direct mutation on `projectsStore.state.value.projects`
  // doesn't change the value reference, so kerf signals never emit.
  const current = projectsStore.state.value.projects;
  const sourceIdx = current.findIndex(p => p.secret === dragSecret);
  if (sourceIdx === -1) return;
  // No-op when the gap is on either side of the dragged tab itself —
  // the resulting order would be identical, so skip the store action
  // and the network POST.
  if (insertIdx === sourceIdx || insertIdx === sourceIdx + 1) return;

  const withoutDragged = current.filter(p => p.secret !== dragSecret);
  // Translate strip-index → without-dragged-index. Gaps strictly to the
  // right of the source's original position shift down by one once the
  // source is removed.
  const insertAt = insertIdx > sourceIdx ? insertIdx - 1 : insertIdx;
  const orderedSecrets = [
    ...withoutDragged.slice(0, insertAt).map(p => p.secret),
    dragSecret,
    ...withoutDragged.slice(insertAt).map(p => p.secret),
  ];
  projectsStore.actions.reorderProjects(orderedSecrets);

  // HS-8431 — guard against a poll-driven `refreshProjectTabs` racing
  // ahead with a stale GET response and undoing the optimistic local
  // update. The flag stays set until a refresh CONFIRMS the server's
  // GET response now reflects this order — clearing on POST success
  // alone is too early because GETs issued mid-POST can resolve AFTER
  // the POST response with stale order, and a cleared flag means no
  // re-projection. `refreshProjectTabs` clears the flag itself once
  // the server's first-N entries match `orderedSecrets`. On POST
  // failure we DO clear here, so the next refresh shows actual server
  // state instead of pinning to an order the server never accepted.
  pendingReorderSecrets = orderedSecrets;
  void (async () => {
    try {
      await api('/projects/reorder', {
        method: 'POST',
        body: { secrets: orderedSecrets },
      });
    } catch (err) {
      console.error('reorder POST failed:', err);
      // Only clear if this drop is still the latest pending one —
      // a second drop landing before this POST resolves overwrites
      // the flag with a fresher order that must outlive this catch.
      if (pendingReorderSecrets === orderedSecrets) {
        pendingReorderSecrets = null;
      }
    }
  })();
}

function handleDragEnd(e: DragEvent) {
  (e.target as HTMLElement).classList.remove('dragging');
  hideIndicator();
  dragSecret = null;
}

// --- Status dots (updated from long-poll, not periodic timer) ---

// Per-project alive state from bulk endpoint
const aliveProjects = new Set<string>();

/** Called from the long-poll handler to refresh per-project channel status. */
export async function refreshProjectChannelStatus() {
  try {
    const data = await api<{ enabled: boolean; projects: Record<string, boolean> }>('/projects/channel-status');
    aliveProjects.clear();
    if (data.enabled) {
      for (const [secret, alive] of Object.entries(data.projects)) {
        if (alive) aliveProjects.add(secret);
      }
    }
  } catch { /* ignore */ }
  // Sync the active project's disconnected warning
  const activeSecret = getActiveProject()?.secret;
  if (activeSecret !== undefined && activeSecret !== '') {
    setChannelAlive(aliveProjects.has(activeSecret));
  }
  updateStatusDots();
}

export function isProjectAlive(secret: string): boolean {
  return aliveProjects.has(secret);
}

export function updateStatusDots() {
  const attentionSecrets = getProjectAttentionSecrets();
  const busySecrets = getProjectBusySecrets();
  const minimizedSecrets = getMinimizedPermissionSecrets();

  for (const dot of document.querySelectorAll('.project-tab-dot')) {
    const tab = dot.closest<HTMLElement>('.project-tab');
    if (tab === null) continue;
    const secret = tab.dataset.secret ?? '';

    if (feedbackSecrets.has(secret)) {
      dot.className = 'project-tab-dot feedback';
    } else if (minimizedSecrets.has(secret)) {
      // Pulsating blue — a permission popup is waiting in the background (HS-6637).
      dot.className = 'project-tab-dot attention minimized';
    } else if (attentionSecrets.has(secret)) {
      dot.className = 'project-tab-dot attention';
    } else if (busySecrets.has(secret)) {
      dot.className = 'project-tab-dot busy';
    } else {
      dot.className = 'project-tab-dot';
    }
  }
}

// Lucide `bell` glyph. Matches the terminal-drawer Phase 1 indicator so the
// two bell affordances read as the same concept.
const PROJECT_TAB_BELL_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';

/**
 * Cross-project bell indicator (HS-6603 §24.4.2). Called by bellPoll on every
 * long-poll tick. Toggles the .has-bell class + bell SVG on each project tab
 * whose secret has `anyTerminalPending: true`, but suppresses the glyph on
 * the *active* project — the user is already looking there; the in-drawer
 * per-terminal indicator (§24.4.3) covers that case.
 */
export function updateProjectBellIndicators(
  bellStates: Map<string, { anyTerminalPending: boolean }>,
): void {
  const activeSecret = getActiveProject()?.secret ?? null;
  for (const tab of document.querySelectorAll<HTMLElement>('.project-tab')) {
    const secret = tab.dataset.secret ?? '';
    const entry = bellStates.get(secret);
    const pending = entry?.anyTerminalPending === true;
    const shouldShow = pending && secret !== activeSecret;
    const hadBell = tab.classList.contains('has-bell');
    tab.classList.toggle('has-bell', shouldShow);

    const bellSpan = tab.querySelector<HTMLElement>('.project-tab-bell');
    if (bellSpan === null) continue;

    if (shouldShow && !hadBell) {
      // First-time add: inject the icon and let the 350 ms wiggle animation
      // run once. Re-adding .has-bell to a tab that already had it should NOT
      // replay the animation (innerHTML stays in place).
      bellSpan.innerHTML = PROJECT_TAB_BELL_ICON;
    } else if (!shouldShow && hadBell) {
      bellSpan.innerHTML = '';
    }
  }
}

/**
 * HS-8147 — update the per-project "today's cost" chip on every tab.
 * `costs` is the bulk-query response keyed by project secret; a secret
 * not in the map has zero cost today (the chip stays hidden).
 *
 * Renders cost as `$N.NN` (or sub-cent indicator for very small values); shows
 * nothing when cost is zero per §67.10.1 (chip only rendered when
 * today's value is non-zero). Polled from `bellPoll.subscribers` so the
 * refresh cadence matches the existing bell-state long-poll.
 */
export function updateProjectCostChips(costs: Record<string, number>): void {
  lastCostsForChipRefresh = costs;
  // HS-8497 — when the user is on a Claude Pro/Max subscription, the
  // dollar amount reported by Claude Code's `cost.usage` metric is an
  // API-equivalent estimate, NOT what they actually pay. Hide the chip
  // entirely in subscription mode rather than show a misleading number;
  // the drawer + dashboard still surface the values for users who want
  // to see consumption volume, gated behind a clarifying notice.
  const mode = getTelemetryCostMode();
  for (const chip of document.querySelectorAll<HTMLElement>('.project-tab-cost')) {
    const secret = chip.dataset.secret ?? '';
    const cost = costs[secret] ?? 0;
    if (cost > 0 && mode === 'api') {
      chip.textContent = cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`;
      chip.style.display = '';
    } else {
      chip.textContent = '';
      chip.style.display = 'none';
    }
  }
}

/**
 * HS-8497 — re-render every cost chip using the most recently observed
 * `costs` payload. Called by `settingsDialog.tsx` immediately after the
 * billing-model select changes so the chips appear/disappear without
 * waiting for the next bell-state tick.
 */
let lastCostsForChipRefresh: Record<string, number> = {};
export function refreshAllCostChips(): void {
  updateProjectCostChips(lastCostsForChipRefresh);
}

// --- Scroll active tab into view ---

function scrollActiveTabIntoView() {
  const container = document.querySelector('.project-tabs-inner');
  if (!container) return;
  const activeTab = container.querySelector('.project-tab.active');
  if (!activeTab) return;

  const containerRect = container.getBoundingClientRect();
  const tabRect = activeTab.getBoundingClientRect();

  if (tabRect.left < containerRect.left) {
    container.scrollLeft -= containerRect.left - tabRect.left;
  } else if (tabRect.right > containerRect.right) {
    container.scrollLeft += tabRect.right - containerRect.right;
  }
}

/** **HS-8494 follow-up** — toggle the `.has-overflow` class on the tab
 *  strip whenever the JS measurement disagrees with the current class
 *  state. The CSS rule pairs `body.scrollbars-always-visible` with
 *  `.project-tabs-inner.has-overflow` to flip the strip from
 *  `overflow-x: auto` to `overflow-x: scroll`, which forces webkit to
 *  always render the iOS thumb when actual overflow exists. Pre-fix
 *  the implicit `auto` mode occasionally failed to repaint the
 *  scrollbar after a rapid resize from "fits" to "overflows".
 *
 *  Cheap (one `scrollWidth` + one `clientWidth` read + a `classList`
 *  no-op on the common no-change path). Called from the ResizeObserver
 *  + once after every `renderTabs()` mount. */
function updateProjectTabsOverflow(): void {
  const container = document.querySelector<HTMLElement>('.project-tabs-inner');
  if (container === null) return;
  const overflows = container.scrollWidth > container.clientWidth + 1;
  container.classList.toggle('has-overflow', overflows);
}

// Watch for resize to keep active tab visible
let resizeObserver: ResizeObserver | null = null;

function setupScrollObserver() {
  resizeObserver?.disconnect();
  const container = document.querySelector('.project-tabs-inner');
  if (!container) return;
  resizeObserver = new ResizeObserver(() => {
    scrollActiveTabIntoView();
    updateProjectTabsOverflow();
  });
  resizeObserver.observe(container);
}

// --- Render ---

/** **HS-8235** — the multi-tab strip is wired through `bindList` against
 *  `projectListSignal` exactly once per single↔multi transition. Tracks
 *  the disposer + the live `<div class="project-tabs-inner">` parent so
 *  subsequent `renderTabs()` calls are idempotent (no DOM thrash on
 *  every project switch / poll tick). On a transition back to the
 *  single-project h1 path, the disposer fires + `multiTabState` is
 *  cleared so the next multi-project mount sets up cleanly. */
let multiTabState: { dispose: () => void; parent: HTMLElement } | null = null;

function tearDownMultiTabState(): void {
  if (multiTabState !== null) {
    try { multiTabState.dispose(); } catch { /* swallow */ }
    multiTabState = null;
  }
}

/** Render a single tab row + wire its event listeners + per-row reactive
 *  effects (active-class flip via `activeSecretSignal`). Returns the
 *  `bindList` row contract: the element + a `dispose` that tears down
 *  the per-row `effect` so removed tabs don't keep firing.
 *
 *  Listeners reference the current `projectsStore.state.value.projects` lazily
 *  (drag/drop etc. read the latest list inside `handleDrop`), so the
 *  closure doesn't go stale across reorder. */
function renderTabRow(p: ProjectInfo): { el: Element; dispose: () => void } {
  const row = toElement(
    <div className="project-tab" data-secret={p.secret} draggable="true">
      <span className="project-tab-dot"></span>
      <span className="project-tab-name">{p.name}</span>
      {/* HS-8147 — per-project "today's cost" chip (§67.10.1). Hidden
          by default; `updateProjectCostChips` populates + reveals when
          today's cost > 0. Click → opens the drawer Telemetry tab
          scoped to this project. */}
      <span className="project-tab-cost" data-secret={p.secret} style="display:none" title="Claude usage today (resets at local midnight)"></span>
      <span className="project-tab-bell"></span>
    </div>,
  );

  // Per-row reactive: flip the `.active` class whenever the active
  // project changes. Cheap on no-op (every row's effect re-runs on
  // every active-change, but only the entering / leaving rows actually
  // mutate a class). `bindList` calls the returned `dispose` when the
  // row's key drops out of `projectsListSignal`, so this never leaks.
  const stopActive = effect(() => {
    if (activeProjectSignal.value?.secret === p.secret) row.classList.add('active');
    else row.classList.remove('active');
  });

  row.addEventListener('click', (e) => {
    // HS-8147 — clicking the cost chip switches to this project and
    // opens the analytics dashboard, which carries the per-project
    // "Claude usage" sub-region (HS-8508 / §71). Pre-HS-8509 this
    // opened the drawer Telemetry tab; that tab was removed in
    // Phase 5 of the HS-8503 telemetry-surface reshape and the
    // analytics dashboard is the new home for per-project rollups.
    const target = e.target as HTMLElement | null;
    if (target !== null && target.closest('.project-tab-cost') !== null) {
      e.stopPropagation();
      void (async () => {
        if (activeProjectSignal.value?.secret !== p.secret) await switchProject(p);
        const { enterDashboardMode } = await import('./dashboardMode.js');
        enterDashboardMode();
      })();
      return;
    }
    void (async () => {
      // HS-6832: clicking a project tab while the terminal dashboard is
      // active exits the dashboard first and then navigates to the clicked
      // project's normal ticket view (docs/25-terminal-dashboard.md §25.3).
      const { exitDashboard } = await import('./terminalDashboard.js');
      exitDashboard();
      await switchProject(p);
      // HS-6637: if this tab has a minimized permission popup, bring it back.
      reopenMinimizedForSecret(p.secret);
    })();
  });
  row.addEventListener('contextmenu', (e) => showTabContextMenu(e as MouseEvent, p));
  row.addEventListener('dragstart', (e) => handleDragStart(e, p));
  row.addEventListener('dragover', (e) => handleDragOver(e));
  row.addEventListener('drop', (e) => handleDrop(e, p));
  row.addEventListener('dragend', (e) => handleDragEnd(e));

  return { el: row, dispose: stopActive };
}

function renderTabs() {
  const titleArea = byIdOrNull('app-title-area');
  if (!titleArea) return;

  if (projectsStore.state.value.projects.length < 2) {
    // Single project — show the project name as h1. Imperative because
    // the bindList path doesn't apply (one row, no keyed reconcile to
    // do); also tear down any previous multi-tab state so the inner
    // container's per-row effects don't keep firing against detached
    // nodes if we just transitioned multi → single.
    tearDownMultiTabState();
    const name = projectsStore.state.value.projects.length === 1 ? projectsStore.state.value.projects[0].name : 'Hot Sheet';
    titleArea.innerHTML = '';
    titleArea.appendChild(toElement(<h1>{name}</h1>));
    titleArea.classList.remove('has-tabs');
    return;
  }

  // Multi-tab path. Idempotent — set up the bindList exactly once per
  // single→multi transition, then return early on every subsequent
  // `renderTabs()` call. The bindList itself drives reconciliation off
  // every `projectsStore.state.value.projects = ...` write; we don't need the
  // pre-HS-8235 fingerprint short-circuit because the bindList only
  // mutates the DOM when keys actually change, and per-row effects
  // own their own attribute updates.
  if (multiTabState === null || !multiTabState.parent.isConnected) {
    if (multiTabState !== null) tearDownMultiTabState();
    titleArea.classList.add('has-tabs');
    titleArea.innerHTML = '';
    const inner = toElement(<div className="project-tabs-inner"></div>);
    titleArea.appendChild(inner);
    const dispose = bindList(inner, projectsListSignal, (p) => p.secret, renderTabRow);
    multiTabState = { dispose, parent: inner };
  }

  updateStatusDots();
  // Re-apply the cross-project bell indicators against the last-known snapshot.
  // bellPoll would overwrite this on its next tick anyway, but that tick might
  // be up to 3 s away — re-applying here keeps freshly-rendered tabs from
  // missing known bells.
  void import('./bellPoll.js').then(m => { updateProjectBellIndicators(m.getBellState()); }).catch(() => {});
  // Scroll active tab into view after DOM settles
  requestAnimationFrame(() => {
    scrollActiveTabIntoView();
    updateProjectTabsOverflow();
  });
  setupScrollObserver();
}

/** **HS-8235 / HS-8317 — TEST ONLY.** Reset the multi-tab bindList state
 *  + the underlying `projectsStore` so a unit test can drive
 *  `renderTabs()` from a clean slate without the previous test's
 *  effects leaking across cases. */
export function _resetProjectTabsForTesting(): void {
  tearDownMultiTabState();
  projectsStore.reset();
  pendingReorderSecrets = null;
  dragSecret = null;
  dropInsertIdx = null;
  if (dropIndicator?.parentElement) dropIndicator.parentElement.removeChild(dropIndicator);
  dropIndicator = null;
}

/** **HS-8432 — TEST ONLY.** Read the current drop-insertion gap index so
 *  unit tests can verify that `dragover` collapses "right half of N" and
 *  "left half of N+1" into the same insertion position without poking
 *  at the indicator DOM. */
export function _getDropInsertIdxForTesting(): number | null {
  return dropInsertIdx;
}

/** **HS-8432 — TEST ONLY.** Drive a synthetic drag start so tests can
 *  exercise `handleDragOver` / `handleDrop` without dispatching a full
 *  DragEvent chain (happy-dom's DragEvent constructor doesn't set the
 *  `dataTransfer` we need on `dragstart`). */
export function _setDragSecretForTesting(secret: string | null): void {
  dragSecret = secret;
}

/** **HS-8431 — TEST ONLY.** Drive the pending-reorder guard from a unit
 *  test so the race-during-refresh path can be exercised without
 *  reaching through `handleDrop`. */
export function _setPendingReorderSecretsForTesting(secrets: readonly string[] | null): void {
  pendingReorderSecrets = secrets;
}

/** **HS-8235 / HS-8317 — TEST ONLY.** Drive the store from a unit test
 *  without going through the api → setActiveProject path. */
export function _setProjectsForTesting(projects: readonly ProjectInfo[], activeSecret: string | null): void {
  projectsStore.actions.setProjects(projects);
  const active = activeSecret === null ? null : projects.find(p => p.secret === activeSecret) ?? null;
  projectsStore.actions.setActive(active);
}

/** **HS-8235 — TEST ONLY.** Synchronous handle on `renderTabs()` for
 *  unit-tests that don't want to round-trip through the async
 *  `initProjectTabs` / `refreshProjectTabs` paths. */
export function _renderTabsForTesting(): void {
  renderTabs();
}
