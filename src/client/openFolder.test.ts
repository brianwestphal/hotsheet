// @vitest-environment happy-dom
// HS-9144 — branch coverage for the open-folder dialog (Tauri vs browser picker,
// entry rendering, and the register→switch flow).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bindOpenFolder, showOpenFolderDialog } from './openFolder.js';

const h = vi.hoisted(() => ({
  browse: vi.fn(),
  registerProject: vi.fn(),
  refreshProjectTabs: vi.fn(() => Promise.resolve()),
  switchProject: vi.fn(() => Promise.resolve()),
  showErrorPopup: vi.fn(),
  getTauriInvoke: vi.fn(),
}));
vi.mock('../api/index.js', () => ({ browse: h.browse, registerProject: h.registerProject }));
vi.mock('./projectTabs.js', () => ({ refreshProjectTabs: h.refreshProjectTabs, switchProject: h.switchProject }));
vi.mock('./api.js', () => ({ showErrorPopup: h.showErrorPopup }));
vi.mock('./tauriIntegration.js', () => ({ getTauriInvoke: h.getTauriInvoke }));

function installDom(): void {
  document.body.innerHTML = `
    <div id="open-folder-overlay" style="display:none">
      <div id="open-folder-breadcrumb"></div>
      <div id="open-folder-list"></div>
      <span id="open-folder-path"></span>
      <button id="open-folder-select-btn"></button>
      <button id="open-folder-close"></button>
    </div>`;
}

const browseResult = (entries: { name: string; path: string; hasHotsheet: boolean }[] = []) =>
  Promise.resolve({ path: '/home/me', entries });

beforeEach(() => {
  vi.clearAllMocks();
  h.getTauriInvoke.mockReturnValue(null);
  h.browse.mockReturnValue(browseResult());
  h.registerProject.mockReturnValue(Promise.resolve({ name: 'Proj', secret: 's', dataDir: '/p/.hotsheet' }));
  installDom();
});
afterEach(() => { document.body.replaceChildren(); });

describe('showOpenFolderDialog (browser picker)', () => {
  it('shows the overlay and browses the root when not under Tauri', async () => {
    showOpenFolderDialog();
    expect((document.getElementById('open-folder-overlay') as HTMLElement).style.display).toBe('flex');
    await vi.waitFor(() => expect(h.browse).toHaveBeenCalledWith(''));
  });

  it('renders "No subfolders" for an empty directory', async () => {
    h.browse.mockReturnValue(browseResult([]));
    showOpenFolderDialog();
    await vi.waitFor(() => expect(document.querySelector('.open-folder-empty')).not.toBeNull());
  });

  it('renders a row per entry, badging Hot Sheet folders, and selects on click', async () => {
    h.browse.mockReturnValue(browseResult([
      { name: 'projA', path: '/home/me/projA', hasHotsheet: true },
      { name: 'plain', path: '/home/me/plain', hasHotsheet: false },
    ]));
    showOpenFolderDialog();
    await vi.waitFor(() => expect(document.querySelectorAll('.open-folder-entry')).toHaveLength(2));
    expect(document.querySelectorAll('.open-folder-entry-badge')).toHaveLength(1);
    const firstRow = document.querySelector('.open-folder-entry') as HTMLElement;
    firstRow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(firstRow.classList.contains('selected')).toBe(true);
    expect((document.getElementById('open-folder-select-btn') as HTMLButtonElement).dataset.selectedPath).toBe('/home/me/projA');
  });
});

describe('showOpenFolderDialog (Tauri picker)', () => {
  it('registers the picked folder when the native dialog returns a path', async () => {
    h.getTauriInvoke.mockReturnValue(vi.fn((_c: string) => Promise.resolve('/picked/dir')));
    showOpenFolderDialog();
    await vi.waitFor(() => expect(h.registerProject).toHaveBeenCalledWith('/picked/dir/.hotsheet'));
  });

  it('does not register when the native dialog is canceled (null)', async () => {
    h.getTauriInvoke.mockReturnValue(vi.fn((_c: string) => Promise.resolve(null)));
    showOpenFolderDialog();
    await new Promise(r => setTimeout(r, 0));
    expect(h.registerProject).not.toHaveBeenCalled();
  });

  it('falls back to the browser dialog when the native picker throws', async () => {
    h.getTauriInvoke.mockReturnValue(vi.fn((_c: string) => Promise.reject(new Error('no dialog'))));
    showOpenFolderDialog();
    await vi.waitFor(() => expect((document.getElementById('open-folder-overlay') as HTMLElement).style.display).toBe('flex'));
  });
});

describe('the register → switch flow (via the Select button)', () => {
  it('registers, refreshes tabs, runs onRegistered, then switches', async () => {
    const onRegistered = vi.fn(() => Promise.resolve());
    bindOpenFolder();
    showOpenFolderDialog({ onRegistered });
    const selectBtn = document.getElementById('open-folder-select-btn') as HTMLButtonElement;
    selectBtn.dataset.selectedPath = '/home/me/projA';
    selectBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(h.switchProject).toHaveBeenCalled());
    expect(h.registerProject).toHaveBeenCalledWith('/home/me/projA/.hotsheet');
    expect(h.refreshProjectTabs).toHaveBeenCalled();
    expect(onRegistered).toHaveBeenCalled();
  });

  it('surfaces an error popup when registration fails', async () => {
    h.registerProject.mockReturnValue(Promise.reject(new Error('not a hotsheet folder')));
    bindOpenFolder();
    const selectBtn = document.getElementById('open-folder-select-btn') as HTMLButtonElement;
    selectBtn.dataset.selectedPath = '/bad';
    selectBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(h.showErrorPopup).toHaveBeenCalledWith('not a hotsheet folder'));
    expect(h.switchProject).not.toHaveBeenCalled();
  });

  it('does not double-append the .hotsheet suffix', async () => {
    bindOpenFolder();
    const selectBtn = document.getElementById('open-folder-select-btn') as HTMLButtonElement;
    selectBtn.dataset.selectedPath = '/home/me/projA/.hotsheet';
    selectBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(h.registerProject).toHaveBeenCalledWith('/home/me/projA/.hotsheet'));
  });
});
