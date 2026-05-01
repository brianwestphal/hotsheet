import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { getProjectAttentionSecrets, getProjectBusySecrets, setChannelAlive } from './channelUI.js';
import { toElement } from './dom.js';
import { ICON_CLOSE_LEFT, ICON_CLOSE_OTHERS, ICON_CLOSE_RIGHT, ICON_FOLDER, ICON_X } from './icons.js';
import { recordInteraction } from './longTaskObserver.js';
import { getMinimizedPermissionSecrets, reopenMinimizedForSecret } from './permissionOverlay.js';
import { computeProjectTabsFingerprint } from './projectTabsFingerprint.js';
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

/** Cached project list from the server. */
let projectList: ProjectInfo[] = [];

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
    projectList = await api<ProjectInfo[]>('/projects');
  } catch {
    projectList = [];
  }

  if (projectList.length === 0) return;

  const urlParams = new URLSearchParams(window.location.search);
  const requestedSecret = urlParams.get('project');
  const requestedProject = requestedSecret !== null
    ? projectList.find(p => p.secret === requestedSecret)
    : undefined;

  setActiveProject(requestedProject ?? projectList[0]);

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
    await initPersistedHiddenTerminals(projectList);
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

/** Re-fetch and re-render tabs (e.g., after adding/removing a project). */
export async function refreshProjectTabs(): Promise<void> {
  try {
    projectList = await api<ProjectInfo[]>('/projects');
  } catch {
    projectList = [];
  }
  renderTabs();
  // HS-7825 — re-hydrate persisted hidden-terminal state when the project
  // list changes (a new project added) so its persisted filter is applied
  // before the user opens the dashboard.
  void (async () => {
    const { initPersistedHiddenTerminals } = await import('./persistedHiddenTerminals.js');
    await initPersistedHiddenTerminals(projectList);
  })();
}

/** Switch to the next or previous tab. */
export function switchTabByOffset(offset: number): void {
  if (projectList.length < 2) return;
  const activeSecret = getActiveProject()?.secret;
  const idx = projectList.findIndex(p => p.secret === activeSecret);
  if (idx === -1) return;
  const next = (idx + offset + projectList.length) % projectList.length;
  void switchProject(projectList[next]);
}

/** Close the active tab. */
export function closeActiveTab(): void {
  const active = getActiveProject();
  if (active) void removeProject(active);
}

// --- Remove helpers ---

async function removeProject(project: ProjectInfo): Promise<void> {
  if (projectList.length <= 1) return;
  try {
    // HS-8085 — DELETE auths via the URL `:secret` param, not the
    // `X-Hotsheet-Secret` header (see `src/routes/projects.ts:90`); the
    // api helper still adds the active project's secret as the auth
    // header, which the route ignores. Acceptable.
    await api(`/projects/${encodeURIComponent(project.secret)}`, { method: 'DELETE' });
    clearPerProjectSessionState(project.secret);
    if (getActiveProject()?.secret === project.secret) {
      const remaining = projectList.filter(p => p.secret !== project.secret);
      if (remaining.length > 0) await switchProject(remaining[0]);
    }
    await refreshProjectTabs();
  } catch (err) {
    console.error('Failed to remove project:', err);
  }
}

async function removeOtherProjects(keepProject: ProjectInfo): Promise<void> {
  const toRemove = projectList.filter(p => p.secret !== keepProject.secret);
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
  const idx = projectList.findIndex(p => p.secret === project.secret);
  if (idx === -1) return;
  const toRemove = direction === 'left' ? projectList.slice(0, idx) : projectList.slice(idx + 1);
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
  document.getElementById('tab-context-menu')?.remove();

  const idx = projectList.findIndex(p => p.secret === project.secret);
  const hasLeft = idx > 0;
  const hasRight = idx < projectList.length - 1;
  const canClose = projectList.length > 1;

  // HS-7835 — Lucide icons on every entry (matches the §22 terminal-tab
  // context menu visually).
  const items: { label: string; action: () => void; disabled?: boolean; icon: string }[] = [
    { label: 'Close Tab', action: () => void removeProject(project), disabled: !canClose, icon: ICON_X },
    { label: 'Close Other Tabs', action: () => void removeOtherProjects(project), disabled: projectList.length <= 1, icon: ICON_CLOSE_OTHERS },
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

  const fromIdx = projectList.findIndex(p => p.secret === dragSecret);
  const toIdx = projectList.findIndex(p => p.secret === targetProject.secret);
  if (fromIdx === -1 || toIdx === -1) return;

  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const side = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
  const [moved] = projectList.splice(fromIdx, 1);
  let insertIdx = projectList.findIndex(p => p.secret === targetProject.secret);
  if (side === 'after') insertIdx++;
  projectList.splice(insertIdx, 0, moved);
  renderTabs();

  void api('/projects/reorder', {
    method: 'POST',
    body: { secrets: projectList.map(p => p.secret) },
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

/** HS-7972 — fingerprint of the rendered tab strip. Skipping the DOM rebuild
 *  when the strip is identical eliminates the per-poll-tick teardown that
 *  was clearing the user's `:hover` state mid-hover (causing the visible
 *  outline flicker the user reported). */
let lastRenderedTabsFingerprint: string | null = null;

function computeTabsFingerprint(activeSecret: string | null): string {
  return computeProjectTabsFingerprint(projectList, activeSecret);
}

function renderTabs() {
  const titleArea = document.getElementById('app-title-area');
  if (!titleArea) return;

  if (projectList.length < 2) {
    // Single project — show the project name as h1
    const name = projectList.length === 1 ? projectList[0].name : 'Hot Sheet';
    const fingerprint = computeTabsFingerprint(null);
    if (lastRenderedTabsFingerprint === fingerprint && document.querySelector('#app-title-area h1') !== null) return;
    lastRenderedTabsFingerprint = fingerprint;
    titleArea.innerHTML = '';
    titleArea.appendChild(toElement(<h1>{name}</h1>));
    titleArea.classList.remove('has-tabs');
    return;
  }

  // HS-7972 — skip the DOM rebuild when the strip is identical to what's
  // already there. Active-state changes are picked up by `setActiveProject`
  // → `renderTabs` so the fingerprint includes the active secret. Status
  // dots + bell glyphs are toggled in-place by `updateStatusDots` /
  // `updateProjectBellIndicators` and don't go through this path, so they
  // can't be missed by the fingerprint short-circuit.
  const activeSecret = getActiveProject()?.secret ?? null;
  const fingerprint = computeTabsFingerprint(activeSecret);
  if (lastRenderedTabsFingerprint === fingerprint && document.querySelector('.project-tabs-inner') !== null) {
    return;
  }
  lastRenderedTabsFingerprint = fingerprint;

  titleArea.classList.add('has-tabs');
  titleArea.innerHTML = '';

  const tabList = toElement(
    <div className="project-tabs-inner">
      {projectList.map(p => (
        <div
          className={`project-tab${p.secret === getActiveProject()?.secret ? ' active' : ''}`}
          data-secret={p.secret}
        >
          <span className="project-tab-dot"></span>
          <span className="project-tab-name">{p.name}</span>
          <span className="project-tab-bell"></span>
        </div>
      ))}
    </div>
  );

  for (const tab of tabList.querySelectorAll('.project-tab')) {
    const el = tab as HTMLElement;
    el.draggable = true;
    const secret = el.dataset.secret!;
    const project = projectList.find(p => p.secret === secret);
    if (!project) continue;

    el.addEventListener('click', () => {
      void (async () => {
        // HS-6832: clicking a project tab while the terminal dashboard is
        // active exits the dashboard first and then navigates to the clicked
        // project's normal ticket view (docs/25-terminal-dashboard.md §25.3).
        const { exitDashboard } = await import('./terminalDashboard.js');
        exitDashboard();
        await switchProject(project);
        // HS-6637: if this tab has a minimized permission popup, bring it back.
        reopenMinimizedForSecret(project.secret);
        // HS-8067 — same path for minimized §52 terminal-prompt overlays.
        // Lazy import to keep `bellPoll` out of the projectTabs hot
        // path; the call is fire-and-forget.
        void import('./bellPoll.js').then(m => { m.reopenMinimizedTerminalPromptForSecret(project.secret); }).catch(() => {});
      })();
    });
    el.addEventListener('contextmenu', (e) => showTabContextMenu(e as MouseEvent, project));
    el.addEventListener('dragstart', (e) => handleDragStart(e, project));
    el.addEventListener('dragover', (e) => handleDragOver(e));
    el.addEventListener('drop', (e) => handleDrop(e, project));
    el.addEventListener('dragend', (e) => handleDragEnd(e));
  }

  titleArea.appendChild(tabList);
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
