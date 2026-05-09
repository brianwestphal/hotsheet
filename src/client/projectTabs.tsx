import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { getProjectAttentionSecrets, getProjectBusySecrets, setChannelAlive } from './channelUI.js';
import { byIdOrNull, toElement } from './dom.js';
import { ICON_CLOSE_LEFT, ICON_CLOSE_OTHERS, ICON_CLOSE_RIGHT, ICON_FOLDER, ICON_X } from './icons.js';
import { recordInteraction } from './longTaskObserver.js';
import { getMinimizedPermissionSecrets, reopenMinimizedForSecret } from './permissionOverlay.js';
import type { Signal } from './reactive.js';
import { effect, signal } from './reactive.js';
import { bindList } from './reactive-bind.js';
import type { ProjectInfo } from './state.js';
import { clearPerProjectSessionState, getActiveProject, setActiveProject } from './state.js';

/** Callback to reload all app data after switching projects. Set by app.tsx during init. */
let reloadCallback: (() => Promise<void>) | null = null;

/** Register the reload callback (called from app.tsx init). */
export function setProjectReloadCallback(cb: () => Promise<void>) {
  reloadCallback = cb;
}

/** Projects with pending feedback (managed by feedbackDialog.checkFeedbackState). */
const feedbackSecrets = new Set<string>();

export function setProjectFeedback(secret: string, hasFeedback: boolean) {
  if (hasFeedback) feedbackSecrets.add(secret);
  else feedbackSecrets.delete(secret);
  updateStatusDots();
}

/** Cached project list from the server.
 *
 * **HS-8235** — was a plain `let projectList: ProjectInfo[]`; now a kerf
 * signal so `bindList` (in `renderTabs`) can reactively reconcile the
 * tab-strip rows on every assignment without callers having to call
 * `renderTabs()` themselves. Mutations MUST assign a fresh array
 * (`projectListSignal.value = [...]`) — pushing to the existing array
 * doesn't trigger reactivity (signals don't deep-watch). */
const projectListSignal: Signal<readonly ProjectInfo[]> = signal([]);

/** **HS-8235** — mirrors `getActiveProject()?.secret` so per-row effects
 *  inside `bindList`'s row template can flip the `.active` class without
 *  re-mounting the row. Updated alongside every `setActiveProject()`
 *  call via the `setActive()` helper below. */
const activeSecretSignal: Signal<string | null> = signal(null);

/** **HS-8235** — wrap `setActiveProject` so the signal mirror always
 *  stays in sync with `state.tsx`'s `activeProject`. Every production
 *  caller of `setActiveProject` lives inside this module, so this is
 *  the only seam needed. */
function setActive(project: ProjectInfo): void {
  setActiveProject(project);
  activeSecretSignal.value = project.secret;
}

/**
 * Initialize project tabs. Fetches the project list, sets the active project,
 * and renders the tab bar if there are multiple projects.
 * Must be called before any other API calls so activeProject is set.
 */
export async function initProjectTabs(): Promise<void> {
  try {
    // HS-8085 — first call before `setActiveProject`, so the api helper
    // emits a plain GET with no `?project=` query (no active project to
    // auth against yet). That matches the pre-fix raw-fetch behaviour.
    projectListSignal.value = await api<ProjectInfo[]>('/projects');
  } catch {
    projectListSignal.value = [];
  }

  if (projectListSignal.value.length === 0) return;

  const urlParams = new URLSearchParams(window.location.search);
  const requestedSecret = urlParams.get('project');
  const requestedProject = requestedSecret !== null
    ? projectListSignal.value.find(p => p.secret === requestedSecret)
    : undefined;

  setActive(requestedProject ?? projectListSignal.value[0]);

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
  setActive(project);
  renderTabs();
  void api('/ensure-skills', { method: 'POST' });
  if (reloadCallback) {
    await reloadCallback();
  }
}

/** Re-fetch and re-render tabs (e.g., after adding/removing a project). */
export async function refreshProjectTabs(): Promise<void> {
  try {
    projectListSignal.value = await api<ProjectInfo[]>('/projects');
  } catch {
    projectListSignal.value = [];
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
  const list = projectListSignal.value;
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
  if (projectListSignal.value.length <= 1) return;
  try {
    // HS-8085 — DELETE auths via the URL `:secret` param, not the
    // `X-Hotsheet-Secret` header (see `src/routes/projects.ts:90`); the
    // api helper still adds the active project's secret as the auth
    // header, which the route ignores. Acceptable.
    await api(`/projects/${encodeURIComponent(project.secret)}`, { method: 'DELETE' });
    clearPerProjectSessionState(project.secret);
    if (getActiveProject()?.secret === project.secret) {
      const remaining = projectListSignal.value.filter(p => p.secret !== project.secret);
      if (remaining.length > 0) await switchProject(remaining[0]);
    }
    await refreshProjectTabs();
  } catch (err) {
    console.error('Failed to remove project:', err);
  }
}

async function removeOtherProjects(keepProject: ProjectInfo): Promise<void> {
  const toRemove = projectListSignal.value.filter(p => p.secret !== keepProject.secret);
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
  const list = projectListSignal.value;
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

  const list = projectListSignal.value;
  const idx = list.findIndex(p => p.secret === project.secret);
  const hasLeft = idx > 0;
  const hasRight = idx < list.length - 1;
  const canClose = list.length > 1;

  // HS-7835 — Lucide icons on every entry (matches the §22 terminal-tab
  // context menu visually).
  const items: { label: string; action: () => void; disabled?: boolean; icon: string }[] = [
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
          <span className="tab-context-icon">{raw(item.icon)}</span>
          {item.label}
        </div>
      ))}
      <div className="tab-context-separator"></div>
      <div className="tab-context-item" data-action="reveal">
        <span className="tab-context-icon">{raw(folderIcon)}</span>
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
let dropTarget: { secret: string; side: 'before' | 'after' } | null = null;

function ensureDropIndicator(): HTMLElement {
  if (!dropIndicator) {
    dropIndicator = toElement(<div className="tab-drop-indicator" />);
  }
  return dropIndicator;
}

function positionIndicator(el: HTMLElement, side: 'before' | 'after') {
  const indicator = ensureDropIndicator();
  const container = el.closest('.project-tabs-inner');
  if (container === null) return;
  if (!indicator.parentElement) container.appendChild(indicator);

  const containerRect = container.getBoundingClientRect();
  const tabRect = el.getBoundingClientRect();
  const x = side === 'before'
    ? tabRect.left - containerRect.left + container.scrollLeft - 1
    : tabRect.right - containerRect.left + container.scrollLeft + 1;

  indicator.style.left = `${x}px`;
  indicator.style.display = '';
}

function hideIndicator() {
  if (dropIndicator) dropIndicator.style.display = 'none';
  dropTarget = null;
}

function handleDragStart(e: DragEvent, project: ProjectInfo) {
  dragSecret = project.secret;
  e.dataTransfer!.effectAllowed = 'move';
  (e.target as HTMLElement).classList.add('dragging');
}

function handleDragOver(e: DragEvent) {
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'move';
  const el = e.currentTarget as HTMLElement;
  const secret = el.dataset.secret;
  if (secret === dragSecret) {
    hideIndicator();
    return;
  }
  const rect = el.getBoundingClientRect();
  const side = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
  // Avoid redundant repositioning
  if (dropTarget && dropTarget.secret === secret && dropTarget.side === side) return;
  dropTarget = { secret: secret!, side };
  positionIndicator(el, side);
}

function handleDrop(e: DragEvent, targetProject: ProjectInfo) {
  e.preventDefault();
  hideIndicator();
  if (dragSecret === null || dragSecret === targetProject.secret) return;

  // HS-8235 — immutable update so the signal write fires reactivity.
  // Pre-fix this path mutated the array in place via two `splice` calls
  // and called `renderTabs()` to force a rebuild; the new tab strip
  // re-reconciles via `bindList` automatically on the signal write.
  const next = [...projectListSignal.value];
  const fromIdx = next.findIndex(p => p.secret === dragSecret);
  const toIdx = next.findIndex(p => p.secret === targetProject.secret);
  if (fromIdx === -1 || toIdx === -1) return;

  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const side = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
  const [moved] = next.splice(fromIdx, 1);
  let insertIdx = next.findIndex(p => p.secret === targetProject.secret);
  if (side === 'after') insertIdx++;
  next.splice(insertIdx, 0, moved);
  projectListSignal.value = next;

  void api('/projects/reorder', {
    method: 'POST',
    body: { secrets: next.map(p => p.secret) },
  });
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

// Watch for resize to keep active tab visible
let resizeObserver: ResizeObserver | null = null;

function setupScrollObserver() {
  resizeObserver?.disconnect();
  const container = document.querySelector('.project-tabs-inner');
  if (!container) return;
  resizeObserver = new ResizeObserver(() => scrollActiveTabIntoView());
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
 *  Listeners reference the current `projectListSignal.value` lazily
 *  (drag/drop etc. read the latest list inside `handleDrop`), so the
 *  closure doesn't go stale across reorder. */
function renderTabRow(p: ProjectInfo): { el: Element; dispose: () => void } {
  const row = toElement(
    <div className="project-tab" data-secret={p.secret} draggable={true}>
      <span className="project-tab-dot"></span>
      <span className="project-tab-name">{p.name}</span>
      <span className="project-tab-bell"></span>
    </div>,
  );

  // Per-row reactive: flip the `.active` class whenever the active
  // secret changes. Cheap on no-op (every row's effect re-runs on every
  // active-change, but only the entering / leaving rows actually mutate
  // a class). `bindList` calls the returned `dispose` when the row's
  // key drops out of `projectListSignal`, so this never leaks.
  const stopActive = effect(() => {
    if (activeSecretSignal.value === p.secret) row.classList.add('active');
    else row.classList.remove('active');
  });

  row.addEventListener('click', () => {
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

  if (projectListSignal.value.length < 2) {
    // Single project — show the project name as h1. Imperative because
    // the bindList path doesn't apply (one row, no keyed reconcile to
    // do); also tear down any previous multi-tab state so the inner
    // container's per-row effects don't keep firing against detached
    // nodes if we just transitioned multi → single.
    tearDownMultiTabState();
    const name = projectListSignal.value.length === 1 ? projectListSignal.value[0].name : 'Hot Sheet';
    titleArea.innerHTML = '';
    titleArea.appendChild(toElement(<h1>{name}</h1>));
    titleArea.classList.remove('has-tabs');
    return;
  }

  // Multi-tab path. Idempotent — set up the bindList exactly once per
  // single→multi transition, then return early on every subsequent
  // `renderTabs()` call. The bindList itself drives reconciliation off
  // every `projectListSignal.value = ...` write; we don't need the
  // pre-HS-8235 fingerprint short-circuit because the bindList only
  // mutates the DOM when keys actually change, and per-row effects
  // own their own attribute updates.
  if (multiTabState === null || !multiTabState.parent.isConnected) {
    if (multiTabState !== null) tearDownMultiTabState();
    titleArea.classList.add('has-tabs');
    titleArea.innerHTML = '';
    const inner = toElement(<div className="project-tabs-inner"></div>);
    titleArea.appendChild(inner);
    const dispose = bindList(inner, projectListSignal, (p) => p.secret, renderTabRow);
    multiTabState = { dispose, parent: inner };
  }

  updateStatusDots();
  // Re-apply the cross-project bell indicators against the last-known snapshot.
  // bellPoll would overwrite this on its next tick anyway, but that tick might
  // be up to 3 s away — re-applying here keeps freshly-rendered tabs from
  // missing known bells.
  void import('./bellPoll.js').then(m => { updateProjectBellIndicators(m.getBellState()); }).catch(() => {});
  // Scroll active tab into view after DOM settles
  requestAnimationFrame(scrollActiveTabIntoView);
  setupScrollObserver();
}

/** **HS-8235 — TEST ONLY.** Reset the multi-tab bindList state + the
 *  signals so a unit test can drive `renderTabs()` from a clean slate
 *  without the previous test's effects leaking across cases. */
export function _resetProjectTabsForTesting(): void {
  tearDownMultiTabState();
  projectListSignal.value = [];
  activeSecretSignal.value = null;
}

/** **HS-8235 — TEST ONLY.** Drive the signals from a unit test without
 *  going through the api → setActiveProject path. */
export function _setProjectsForTesting(projects: readonly ProjectInfo[], activeSecret: string | null): void {
  projectListSignal.value = projects;
  activeSecretSignal.value = activeSecret;
}

/** **HS-8235 — TEST ONLY.** Synchronous handle on `renderTabs()` for
 *  unit-tests that don't want to round-trip through the async
 *  `initProjectTabs` / `refreshProjectTabs` paths. */
export function _renderTabsForTesting(): void {
  renderTabs();
}
