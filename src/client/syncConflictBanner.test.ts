// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getSyncConflictsSummary } from '../api/index.js';
import { formatConflictBannerLabel, refreshSyncConflictBanner } from './syncConflictBanner.js';

// The banner module only calls the typed `getSyncConflictsSummary`; mock it.
vi.mock('../api/index.js', () => ({ getSyncConflictsSummary: vi.fn() }));
const mockGet = vi.mocked(getSyncConflictsSummary);

function buildDom(): void {
  document.body.innerHTML = `
    <button id="settings-btn"></button>
    <button id="settings-tab-plugins"></button>
    <div id="plugin-conflicts-section"></div>
    <div id="sync-conflict-banner" style="display:none">
      <span class="sync-conflict-banner-main">
        <span id="sync-conflict-banner-icon"></span>
        <span id="sync-conflict-banner-label"></span>
        <span id="sync-conflict-banner-count"></span>
      </span>
    </div>`;
}

describe('formatConflictBannerLabel (HS-8959)', () => {
  it('names the single plugin and pluralizes by count', () => {
    expect(formatConflictBannerLabel([{ pluginId: 'gh', pluginName: 'GitHub Issues', icon: null, count: 1 }]))
      .toBe('GitHub Issues: 1 sync conflict needs resolution');
    expect(formatConflictBannerLabel([{ pluginId: 'gh', pluginName: 'GitHub Issues', icon: null, count: 3 }]))
      .toBe('GitHub Issues: 3 sync conflicts need resolution');
  });

  it('summarizes across multiple plugins', () => {
    expect(formatConflictBannerLabel([
      { pluginId: 'gh', pluginName: 'GitHub', icon: null, count: 3 },
      { pluginId: 'jr', pluginName: 'Jira', icon: null, count: 1 },
    ])).toBe('4 sync conflicts need resolution across 2 plugins');
  });

  it('returns empty string with no conflicts', () => {
    expect(formatConflictBannerLabel([])).toBe('');
  });
});

describe('refreshSyncConflictBanner (HS-8959)', () => {
  beforeEach(() => {
    buildDom();
    mockGet.mockReset();
  });

  it('shows the banner with count, label, and plugin icon when conflicts exist', async () => {
    mockGet.mockResolvedValue([{ pluginId: 'gh', pluginName: 'GitHub Issues', icon: '<svg id="gh-icon"></svg>', count: 2 }]);
    await refreshSyncConflictBanner();

    const banner = document.getElementById('sync-conflict-banner')!;
    expect(banner.style.display).toBe('flex');
    expect(document.getElementById('sync-conflict-banner-count')!.textContent).toBe('2');
    expect(document.getElementById('sync-conflict-banner-label')!.textContent).toContain('GitHub Issues');
    expect(document.querySelector('#sync-conflict-banner-icon svg')).not.toBeNull();
  });

  it('hides the banner when there are no conflicts', async () => {
    mockGet.mockResolvedValue([]);
    await refreshSyncConflictBanner();
    expect(document.getElementById('sync-conflict-banner')!.style.display).toBe('none');
  });

  it('caps the count display at 99+', async () => {
    mockGet.mockResolvedValue([{ pluginId: 'gh', pluginName: 'GitHub', icon: null, count: 150 }]);
    await refreshSyncConflictBanner();
    expect(document.getElementById('sync-conflict-banner-count')!.textContent).toBe('99+');
  });

  it('clicking the banner opens Settings → Plugins', async () => {
    mockGet.mockResolvedValue([{ pluginId: 'gh', pluginName: 'GitHub', icon: null, count: 1 }]);
    await refreshSyncConflictBanner();

    const settingsClick = vi.fn();
    const tabClick = vi.fn();
    document.getElementById('settings-btn')!.addEventListener('click', settingsClick);
    document.getElementById('settings-tab-plugins')!.addEventListener('click', tabClick);

    document.getElementById('sync-conflict-banner')!.click();
    expect(settingsClick).toHaveBeenCalled();
    expect(tabClick).toHaveBeenCalled();
  });

  it('leaves the banner unchanged on a transient fetch error', async () => {
    mockGet.mockResolvedValueOnce([{ pluginId: 'gh', pluginName: 'GitHub', icon: null, count: 5 }]);
    await refreshSyncConflictBanner();
    expect(document.getElementById('sync-conflict-banner-count')!.textContent).toBe('5');
    mockGet.mockRejectedValueOnce(new Error('network'));
    await refreshSyncConflictBanner();
    expect(document.getElementById('sync-conflict-banner-count')!.textContent).toBe('5');
  });
});
