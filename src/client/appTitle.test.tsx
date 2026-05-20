// @vitest-environment happy-dom
/**
 * HS-8451 — regression tests for the unified app-title helper. Pins the
 * three invariants that the user-reported "title always shows the first
 * project" bug needs to stay closed against:
 *
 *   1. `setAppTitle` updates `document.title` AND the in-app `<h1>`.
 *   2. `setAppTitleFromActiveProject` follows the project switch — pre-fix
 *      `loadAppName` ONLY wrote the title when `appName` was a non-empty
 *      string, so flipping from a project-with-appName to one without left
 *      the title frozen at the previous project's value.
 *   3. Tauri's `set_window_title` command is invoked when the runtime is
 *      present and skipped (no throw) when it isn't, so the WKWebView's
 *      native window chrome stays in lockstep with the browser-tab title.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setAppTitle, setAppTitleFromActiveProject } from './appTitle.js';
import { toElement } from './dom.js';
import type { ProjectInfo } from './state.js';

let mockActiveProject: ProjectInfo | null = null;
const mockInvoke = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();
let invokeAvailable = false;

vi.mock('./state.js', () => ({
  getActiveProject: () => mockActiveProject,
}));

vi.mock('./tauriIntegration.js', () => ({
  getTauriInvoke: () => (invokeAvailable ? mockInvoke : null),
}));

beforeEach(() => {
  // HS-8467 — TSX fixture instead of `innerHTML = '<html-string>'`.
  document.body.replaceChildren(toElement(<div className="app-title"><h1>initial</h1></div>));
  document.title = 'initial';
  mockActiveProject = null;
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
  invokeAvailable = false;
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('setAppTitle (HS-8451)', () => {
  it('updates document.title and the .app-title h1 text in lockstep', () => {
    setAppTitle('Kerf');
    expect(document.title).toBe('Kerf');
    expect(document.querySelector('.app-title h1')?.textContent).toBe('Kerf');
  });

  it('invokes the Tauri set_window_title command when the runtime is present', () => {
    invokeAvailable = true;
    setAppTitle('Domotion');
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith('set_window_title', { title: 'Domotion' });
  });

  it('does not throw when no Tauri runtime is present (browser context)', () => {
    invokeAvailable = false;
    expect(() => setAppTitle('Browser')).not.toThrow();
    expect(document.title).toBe('Browser');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('swallows a Tauri invoke rejection without surfacing to the caller', async () => {
    invokeAvailable = true;
    mockInvoke.mockRejectedValueOnce(new Error('window not found'));
    expect(() => setAppTitle('Fragile')).not.toThrow();
    // Let the failure-open .catch run.
    await new Promise<void>((resolve) => { queueMicrotask(resolve); });
    expect(document.title).toBe('Fragile');
  });
});

describe('setAppTitleFromActiveProject (HS-8451)', () => {
  it('uses the active project name', () => {
    mockActiveProject = { name: 'Kerf', dataDir: '/k', secret: 'a' };
    setAppTitleFromActiveProject();
    expect(document.title).toBe('Kerf');
  });

  it('falls back to "Hot Sheet" when no project is active', () => {
    mockActiveProject = null;
    setAppTitleFromActiveProject();
    expect(document.title).toBe('Hot Sheet');
  });

  it('reflects a project switch when called twice in a row (regression for the user-reported "first project sticks" bug)', () => {
    mockActiveProject = { name: 'First Project', dataDir: '/a', secret: 'a' };
    setAppTitleFromActiveProject();
    expect(document.title).toBe('First Project');
    // Switch — second project has its own name field (the projects-list endpoint
    // already does the appName-or-folder-name fallback server-side).
    mockActiveProject = { name: 'Second Project', dataDir: '/b', secret: 'b' };
    setAppTitleFromActiveProject();
    expect(document.title).toBe('Second Project');
  });
});
