import { api } from './api.js';
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
    // Fetch projects without project context (this is a management endpoint)
    const res = await fetch('/api/projects');
    projectList = await res.json() as ProjectInfo[];
  } catch {
    projectList = [];
  }

  if (projectList.length === 0) {
    // No projects registered yet — leave activeProject null (backward compatible)
    return;
  }

  // Check URL for a specific project to activate (e.g., ?project=SECRET from CLI join)
  const urlParams = new URLSearchParams(window.location.search);
  const requestedSecret = urlParams.get('project');
  const requestedProject = requestedSecret !== null
    ? projectList.find(p => p.secret === requestedSecret)
    : undefined;

  // Set the requested project (or first) as active
  setActiveProject(requestedProject ?? projectList[0]);

  // Clean the URL to remove the project param (avoid stale state on reload)
  if (requestedSecret !== null) {
    const url = new URL(window.location.href);
    url.searchParams.delete('project');
    window.history.replaceState({}, '', url.toString());
  }

  renderTabs();
}

/** Switch to a different project. */
export async function switchProject(project: ProjectInfo): Promise<void> {
  if (getActiveProject()?.secret === project.secret) return;
  setActiveProject(project);

  // Update tab UI
  renderTabs();

  // Ensure skills are installed for this project
  void api('/ensure-skills', { method: 'POST' });

  // Reload all app data for the new project
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

/** Handle removing a project tab. */
async function removeProject(project: ProjectInfo): Promise<void> {
  if (projectList.length <= 1) return;
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(project.secret)}`, { method: 'DELETE' });
    if (!res.ok) return;
    if (getActiveProject()?.secret === project.secret) {
      const remaining = projectList.filter(p => p.secret !== project.secret);
      if (remaining.length > 0) {
        await switchProject(remaining[0]);
      }
    }
    await refreshProjectTabs();
  } catch (err) {
    console.error('Failed to remove project:', err);
  }
}

/** Render the tab bar into the #project-tabs element. */
function renderTabs() {
  const container = document.getElementById('project-tabs');
  if (!container) return;

  // Only show tabs when there are 2+ projects
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
        >
          <span className="project-tab-name">{p.name}</span>
          <button className="project-tab-close" type="button" title="Remove project">{'\u00d7'}</button>
        </div>
      ))}
      <button className="project-tab-add" type="button" title="Add project">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
      </button>
    </div>
  );

  // Bind click handlers — single handler per tab for reliability
  for (const tab of tabList.querySelectorAll('.project-tab')) {
    const secret = (tab as HTMLElement).dataset.secret!;
    const project = projectList.find(p => p.secret === secret);
    if (!project) continue;

    // Click the tab name area to switch project
    const nameSpan = tab.querySelector('.project-tab-name');
    if (nameSpan) {
      nameSpan.addEventListener('click', () => {
        void switchProject(project);
      });
    }

    // Close button removes project — separate element, separate handler
    const closeBtn = tab.querySelector('.project-tab-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        void removeProject(project);
      });
    }
  }

  // Add button (placeholder for Phase 4)
  const addBtn = tabList.querySelector('.project-tab-add');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      alert('Adding projects will be available in a future update. Use the CLI to register additional projects.');
    });
  }

  container.appendChild(tabList);
}
