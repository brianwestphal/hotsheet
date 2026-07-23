// @vitest-environment happy-dom
/**
 * HS-9406 — `loadSettings()` hydrates `state.settings.ai_tool` from the
 * resolved file-settings layer. Because `reloadAppState()` calls it on every
 * project switch, "leave the previous value alone when the new project doesn't
 * set one" is a stale-carryover bug, not a safe default: after visiting a
 * `codex` project, a Claude project's command editor kept saying "Codex".
 *
 * These are transition tests on purpose — a single-project "loads codex"
 * assertion passes on the buggy code. The bug only exists in the SEQUENCE.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSettings = vi.fn<() => Promise<Record<string, string>>>();
const getLayeredFileSettings = vi.fn<() => Promise<{ resolved: Record<string, unknown> }>>();

vi.mock('../api/index.js', () => ({
  getCategories: () => Promise.resolve([]),
  getSettings: () => getSettings(),
  getLayeredFileSettings: () => getLayeredFileSettings(),
}));

const { loadSettings } = await import('./settingsLoader.js');
const { state } = await import('./state.js');

/** Simulate opening a project whose resolved file settings are `fileSettings`. */
async function openProject(fileSettings: Record<string, unknown>) {
  getSettings.mockResolvedValue({});
  getLayeredFileSettings.mockResolvedValue({ resolved: fileSettings });
  await loadSettings();
}

describe('loadSettings — ai_tool hydration', () => {
  beforeEach(() => {
    // The tail of `loadSettings` applies detail-panel geometry, which does
    // hard `byId` lookups — mount the two elements it needs.
    document.body.innerHTML = '<div id="content-area"></div><div id="detail-panel"></div>';
    state.settings.ai_tool = 'auto';
    vi.clearAllMocks();
  });

  it('adopts the project\'s explicit ai_tool', async () => {
    await openProject({ ai_tool: 'codex' });
    expect(state.settings.ai_tool).toBe('codex');
  });

  it('resets to auto when the next project leaves ai_tool unset', async () => {
    await openProject({ ai_tool: 'codex' });
    await openProject({});
    expect(state.settings.ai_tool).toBe('auto');
  });

  it('resets to auto when the next project has an empty ai_tool', async () => {
    await openProject({ ai_tool: 'codex' });
    await openProject({ ai_tool: '' });
    expect(state.settings.ai_tool).toBe('auto');
  });

  it('swaps directly between two explicitly-set tools', async () => {
    await openProject({ ai_tool: 'codex' });
    await openProject({ ai_tool: 'opencode' });
    expect(state.settings.ai_tool).toBe('opencode');
  });

  it('survives a full round trip back to the codex project', async () => {
    await openProject({ ai_tool: 'codex' });
    await openProject({});
    await openProject({ ai_tool: 'codex' });
    expect(state.settings.ai_tool).toBe('codex');
  });

  it('keeps the current value when the file-settings fetch fails', async () => {
    await openProject({ ai_tool: 'codex' });
    getSettings.mockResolvedValue({});
    getLayeredFileSettings.mockRejectedValue(new Error('offline'));
    await loadSettings();
    expect(state.settings.ai_tool).toBe('codex');
  });
});
