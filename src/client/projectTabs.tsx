import { api } from './api.js';
import { isChannelBusy, isPermissionPending } from './channelUI.js';
import { toElement } from './dom.js';
import type { ProjectInfo } from './state.js';
import { getActiveProject, setActiveProject } from './state.js';

/** Callback to reload all app data after switching projects. Set by app.tsx during init. */
let reloadCallback: (() => Promise<void>) | null = null;

/** Register the reload callback (called from app.tsx init). */
export function setProjectReloadCallback(cb: () => Promise<void>) {
  reloadCallback = cb;
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
    const res = await fetch('/api/projects');
    projectList = await res.json() as ProjectInfo[];
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
  startStatusDotPolling();
}

/** Switch to a different project. */
export async function switchProject(project: ProjectInfo): Promise<void> {
  if (getActiveProject()?.secret === project.secret) return;
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
    const res = await fetch('/api/projects');
    projectList = await res.json() as ProjectInfo[];
  } catch {
    projectList = [];
  }
  renderTabs();
}

// --- Remove helpers ---

async function removeProject(project: ProjectInfo): Promise<void> {
  if (projectList.length <= 1) return;
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(project.secret)}`, { method: 'DELETE' });
    if (!res.ok) return;
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
    await fetch(`/api/projects/${encodeURIComponent(p.secret)}`, { method: 'DELETE' });
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
    await fetch(`/api/projects/${encodeURIComponent(p.secret)}`, { method: 'DELETE' });
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

  const items: { label: string; action: () => void; disabled?: boolean }[] = [
    { label: 'Close Tab', action: () => void removeProject(project), disabled: !canClose },
    { label: 'Close Other Tabs', action: () => void removeOtherProjects(project), disabled: projectList.length <= 1 },
    { label: 'Close Tabs to the Left', action: () => void removeProjectsInDirection(project, 'left'), disabled: !hasLeft },
    { label: 'Close Tabs to the Right', action: () => void removeProjectsInDirection(project, 'right'), disabled: !hasRight },
  ];

  const menu = toElement(
    <div className="tab-context-menu" id="tab-context-menu">
      {items.map(item => (
        <div className={`tab-context-item${item.disabled ? ' disabled' : ''}`}>
          {item.label}
        </div>
      ))}
    </div>
  );

  // Bind click handlers
  const menuItems = menu.querySelectorAll('.tab-context-item');
  items.forEach((item, i) => {
    if (!item.disabled) {
      menuItems[i].addEventListener('click', () => {
        menu.remove();
        item.action();
      });
    }
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

function handleDragStart(e: DragEvent, project: ProjectInfo) {
  dragSecret = project.secret;
  e.dataTransfer!.effectAllowed = 'move';
  (e.target as HTMLElement).classList.add('dragging');
}

function handleDragOver(e: DragEvent) {
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'move';
}

function handleDragEnter(e: DragEvent) {
  (e.currentTarget as HTMLElement).classList.add('drag-over');
}

function handleDragLeave(e: DragEvent) {
  const related = e.relatedTarget as Node | null;
  if (!related || !(e.currentTarget as HTMLElement).contains(related)) {
    (e.currentTarget as HTMLElement).classList.remove('drag-over');
  }
}

function handleDrop(e: DragEvent, targetProject: ProjectInfo) {
  e.preventDefault();
  (e.currentTarget as HTMLElement).classList.remove('drag-over');
  if (dragSecret === null || dragSecret === targetProject.secret) return;

  const fromIdx = projectList.findIndex(p => p.secret === dragSecret);
  const toIdx = projectList.findIndex(p => p.secret === targetProject.secret);
  if (fromIdx === -1 || toIdx === -1) return;

  // Reorder locally
  const [moved] = projectList.splice(fromIdx, 1);
  projectList.splice(toIdx, 0, moved);
  renderTabs();

  // Persist order to server
  void api('/projects/reorder', {
    method: 'POST',
    body: { secrets: projectList.map(p => p.secret) },
  });
}

function handleDragEnd(e: DragEvent) {
  (e.target as HTMLElement).classList.remove('dragging');
  dragSecret = null;
}

// --- Status dot polling ---

let statusDotInterval: ReturnType<typeof setInterval> | null = null;

function startStatusDotPolling() {
  if (statusDotInterval) return;
  statusDotInterval = setInterval(updateStatusDots, 2000);
}

function updateStatusDots() {
  const permPending = isPermissionPending();
  const busy = isChannelBusy();

  for (const dot of document.querySelectorAll('.project-tab-dot')) {
    const tab = dot.closest('.project-tab') as HTMLElement | null;
    if (!tab) continue;
    const isActive = tab.classList.contains('active');

    if (permPending && isActive) {
      dot.className = 'project-tab-dot attention';
    } else if (busy && isActive) {
      dot.className = 'project-tab-dot busy';
    } else {
      dot.className = 'project-tab-dot';
    }
  }
}

// --- Render ---

function renderTabs() {
  const container = document.getElementById('project-tabs');
  if (!container) return;

  if (projectList.length < 2) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  container.style.display = '';
  container.innerHTML = '';

  const tabList = toElement(
    <div className="project-tabs-inner">
      {projectList.map(p => (
        <div
          className={`project-tab${p.secret === getActiveProject()?.secret ? ' active' : ''}`}
          data-secret={p.secret}
          draggable={true}
        >
          <span className="project-tab-dot"></span>
          <span className="project-tab-name">{p.name}</span>
        </div>
      ))}
    </div>
  );

  for (const tab of tabList.querySelectorAll('.project-tab')) {
    const el = tab as HTMLElement;
    const secret = el.dataset.secret!;
    const project = projectList.find(p => p.secret === secret);
    if (!project) continue;

    // Click to switch
    el.addEventListener('click', () => void switchProject(project));

    // Right-click context menu
    el.addEventListener('contextmenu', (e) => showTabContextMenu(e as MouseEvent, project));

    // Drag & drop
    el.addEventListener('dragstart', (e) => handleDragStart(e as DragEvent, project));
    el.addEventListener('dragover', (e) => handleDragOver(e as DragEvent));
    el.addEventListener('dragenter', (e) => handleDragEnter(e as DragEvent));
    el.addEventListener('dragleave', (e) => handleDragLeave(e as DragEvent));
    el.addEventListener('drop', (e) => handleDrop(e as DragEvent, project));
    el.addEventListener('dragend', (e) => handleDragEnd(e as DragEvent));
  }

  container.appendChild(tabList);
  updateStatusDots();
}
