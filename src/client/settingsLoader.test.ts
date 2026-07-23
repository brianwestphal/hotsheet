// @vitest-environment happy-dom
/**
 * HS-9406 / HS-9407 — `loadSettings()` hydrates the client's per-project state
 * (both from the DB key/value store and the resolved file-settings layer).
 * `reloadAppState()` calls it on EVERY project switch, so "leave the previous
 * value alone when the new project doesn't set one" is a stale-carryover bug,
 * not a safe default — the same class as HS-8451's frozen app title. HS-9406
 * was the `ai_tool` instance (a Claude project's command editor said "Codex");
 * HS-9407 is the rest of the block.
 *
 * These are transition tests on purpose — a single-project "loads X" assertion
 * passes on the buggy code. The bug only exists in the SEQUENCE, so every case
 * below walks at least two project opens.
 *
 * Note the wire shape: an unset setting is ABSENT from `/api/settings` (the
 * server builds the record from the keys actually present in `settings.json`),
 * so the fixtures omit keys rather than sending `''`.
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
const { DEFAULT_LAYOUT, DEFAULT_SETTINGS, DEFAULT_SORT_BY, DEFAULT_SORT_DIR, state } = await import('./state.js');

/** Simulate opening a project: `db` is its `/api/settings` record, `file` its
 *  resolved file-settings layer (the five local-only keys are read from there). */
async function openProject(db: Record<string, string> = {}, file: Record<string, unknown> = {}) {
  getSettings.mockResolvedValue(db);
  getLayeredFileSettings.mockResolvedValue({ resolved: file });
  await loadSettings();
}

beforeEach(() => {
  // The tail of `loadSettings` applies detail-panel geometry + visibility,
  // which does hard `byId` lookups — mount the elements it touches.
  document.body.innerHTML =
    '<div id="content-area"></div><div id="detail-panel"></div><div id="detail-resize-handle"></div>';
  Object.assign(state.settings, DEFAULT_SETTINGS);
  state.layout = DEFAULT_LAYOUT;
  state.sortBy = DEFAULT_SORT_BY;
  state.sortDir = DEFAULT_SORT_DIR;
  vi.clearAllMocks();
});

describe('loadSettings — ai_tool hydration (HS-9406)', () => {
  it('adopts the project\'s explicit ai_tool', async () => {
    await openProject({}, { ai_tool: 'codex' });
    expect(state.settings.ai_tool).toBe('codex');
  });

  it('resets to auto when the next project leaves ai_tool unset', async () => {
    await openProject({}, { ai_tool: 'codex' });
    await openProject();
    expect(state.settings.ai_tool).toBe('auto');
  });

  it('resets to auto when the next project has an empty ai_tool', async () => {
    await openProject({}, { ai_tool: 'codex' });
    await openProject({}, { ai_tool: '' });
    expect(state.settings.ai_tool).toBe('auto');
  });

  it('swaps directly between two explicitly-set tools', async () => {
    await openProject({}, { ai_tool: 'codex' });
    await openProject({}, { ai_tool: 'opencode' });
    expect(state.settings.ai_tool).toBe('opencode');
  });

  it('survives a full round trip back to the codex project', async () => {
    await openProject({}, { ai_tool: 'codex' });
    await openProject();
    await openProject({}, { ai_tool: 'codex' });
    expect(state.settings.ai_tool).toBe('codex');
  });

  it('keeps the current value when the file-settings fetch fails', async () => {
    await openProject({}, { ai_tool: 'codex' });
    getSettings.mockResolvedValue({});
    getLayeredFileSettings.mockRejectedValue(new Error('offline'));
    await loadSettings();
    expect(state.settings.ai_tool).toBe('codex');
  });
});

/**
 * HS-9407 — one set → unset → set walk per field. `read()` pulls the live value
 * out of state so the table stays honest about WHERE each setting lands
 * (`state.settings.*` vs the top-level `state.layout` / `sortBy` / `sortDir`).
 */
interface FieldCase {
  name: string;
  /** The `/api/settings` record for a project that HAS a non-default value. */
  set: Record<string, string>;
  /** What that project's value reads as in state. */
  expected: unknown;
  /** What a project with the key absent must read as. */
  fallback: unknown;
  read: () => unknown;
}

const DB_FIELDS: FieldCase[] = [
  {
    name: 'detail_position',
    set: { detail_position: 'bottom' },
    expected: 'bottom',
    fallback: DEFAULT_SETTINGS.detail_position,
    read: () => state.settings.detail_position,
  },
  {
    name: 'detail_visible',
    set: { detail_visible: 'false' },
    expected: false,
    fallback: DEFAULT_SETTINGS.detail_visible,
    read: () => state.settings.detail_visible,
  },
  {
    name: 'detail_width',
    set: { detail_width: '512' },
    expected: 512,
    fallback: DEFAULT_SETTINGS.detail_width,
    read: () => state.settings.detail_width,
  },
  {
    name: 'detail_height',
    set: { detail_height: '444' },
    expected: 444,
    fallback: DEFAULT_SETTINGS.detail_height,
    read: () => state.settings.detail_height,
  },
  {
    name: 'trash_cleanup_days',
    set: { trash_cleanup_days: '14' },
    expected: 14,
    fallback: DEFAULT_SETTINGS.trash_cleanup_days,
    read: () => state.settings.trash_cleanup_days,
  },
  {
    name: 'verified_cleanup_days',
    set: { verified_cleanup_days: '90' },
    expected: 90,
    fallback: DEFAULT_SETTINGS.verified_cleanup_days,
    read: () => state.settings.verified_cleanup_days,
  },
  {
    name: 'layout',
    set: { layout: 'list' },
    expected: 'list',
    fallback: DEFAULT_LAYOUT,
    read: () => state.layout,
  },
  {
    name: 'notify_permission',
    set: { notify_permission: 'none' },
    expected: 'none',
    fallback: DEFAULT_SETTINGS.notify_permission,
    read: () => state.settings.notify_permission,
  },
  {
    name: 'notify_completed',
    set: { notify_completed: 'persistent' },
    expected: 'persistent',
    fallback: DEFAULT_SETTINGS.notify_completed,
    read: () => state.settings.notify_completed,
  },
  {
    name: 'auto_order',
    set: { auto_order: 'false' },
    expected: false,
    fallback: DEFAULT_SETTINGS.auto_order,
    read: () => state.settings.auto_order,
  },
  {
    name: 'hide_verified_column',
    set: { hide_verified_column: 'true' },
    expected: true,
    fallback: DEFAULT_SETTINGS.hide_verified_column,
    read: () => state.settings.hide_verified_column,
  },
  {
    name: 'shell_integration_ui',
    set: { shell_integration_ui: 'true' },
    expected: true,
    fallback: DEFAULT_SETTINGS.shell_integration_ui,
    read: () => state.settings.shell_integration_ui,
  },
  {
    name: 'sort_by',
    set: { sort_by: 'modified' },
    expected: 'modified',
    fallback: DEFAULT_SORT_BY,
    read: () => state.sortBy,
  },
  {
    name: 'sort_dir',
    set: { sort_dir: 'asc' },
    expected: 'asc',
    fallback: DEFAULT_SORT_DIR,
    read: () => state.sortDir,
  },
];

describe('loadSettings — per-project settings do not carry across a switch (HS-9407)', () => {
  for (const f of DB_FIELDS) {
    it(`${f.name}: set → unset → set`, async () => {
      await openProject(f.set);
      expect(f.read(), `project A (${f.name} set)`).toEqual(f.expected);

      // Project B never persisted the key: it must read the DEFAULT, not A's value.
      await openProject();
      expect(f.read(), `project B (${f.name} unset)`).toEqual(f.fallback);

      // …and coming back restores A's value (the reset isn't sticky).
      await openProject(f.set);
      expect(f.read(), `back to project A (${f.name})`).toEqual(f.expected);
    });
  }

  it('resets EVERY field at once when switching to a project with no settings', async () => {
    const everything = Object.assign({}, ...DB_FIELDS.map(f => f.set)) as Record<string, string>;
    await openProject(everything);
    await openProject();
    for (const f of DB_FIELDS) {
      expect(f.read(), f.name).toEqual(f.fallback);
    }
  });

  // The five local-only keys are read from the resolved FILE layer, which
  // overlays the DB record (HS-9170). A project whose file layer omits them
  // must still fall back to the default rather than the previous project's.
  it('resets the file-layer-sourced settings too (notify / auto_order / hide_verified / shell_integration)', async () => {
    await openProject({}, {
      notify_permission: 'none',
      notify_completed: 'persistent',
      auto_order: false,
      hide_verified_column: true,
      shell_integration_ui: true,
    });
    expect(state.settings.notify_permission).toBe('none');
    expect(state.settings.auto_order).toBe(false);
    expect(state.settings.hide_verified_column).toBe(true);
    expect(state.settings.shell_integration_ui).toBe(true);

    await openProject();
    expect(state.settings.notify_permission).toBe(DEFAULT_SETTINGS.notify_permission);
    expect(state.settings.notify_completed).toBe(DEFAULT_SETTINGS.notify_completed);
    expect(state.settings.auto_order).toBe(DEFAULT_SETTINGS.auto_order);
    expect(state.settings.hide_verified_column).toBe(DEFAULT_SETTINGS.hide_verified_column);
    expect(state.settings.shell_integration_ui).toBe(DEFAULT_SETTINGS.shell_integration_ui);
  });

  it('the file layer wins over the DB for the local-only keys', async () => {
    await openProject({ auto_order: 'true', notify_permission: 'persistent' }, { auto_order: false, notify_permission: 'none' });
    expect(state.settings.auto_order).toBe(false);
    expect(state.settings.notify_permission).toBe('none');
  });

  it('falls back for a present-but-unparseable numeric value', async () => {
    await openProject({ detail_width: '512' });
    await openProject({ detail_width: 'not-a-number' });
    expect(state.settings.detail_width).toBe(DEFAULT_SETTINGS.detail_width);
  });

  it('falls back for a present-but-invalid enum value', async () => {
    await openProject({ detail_position: 'bottom', layout: 'list', notify_permission: 'none' });
    await openProject({ detail_position: 'sideways', layout: 'grid', notify_permission: 'sometimes' });
    expect(state.settings.detail_position).toBe(DEFAULT_SETTINGS.detail_position);
    expect(state.layout).toBe(DEFAULT_LAYOUT);
    expect(state.settings.notify_permission).toBe(DEFAULT_SETTINGS.notify_permission);
  });

  it('keeps the previous values when the settings fetch fails entirely', async () => {
    await openProject({ layout: 'list', sort_by: 'modified' });
    getSettings.mockRejectedValue(new Error('offline'));
    await loadSettings();
    expect(state.layout).toBe('list');
    expect(state.sortBy).toBe('modified');
  });
});

describe('loadSettings — detail-panel visibility follows state both ways (HS-9407)', () => {
  const panelDisplay = () => document.getElementById('detail-panel')?.style.display;
  const handleDisplay = () => document.getElementById('detail-resize-handle')?.style.display;

  it('hides the panel for a project that persisted detail_visible=false', async () => {
    await openProject({ detail_visible: 'false' });
    expect(panelDisplay()).toBe('none');
    expect(handleDisplay()).toBe('none');
  });

  it('re-shows the panel when switching to a project that never hid it', async () => {
    await openProject({ detail_visible: 'false' });
    expect(panelDisplay()).toBe('none');
    // Pre-fix `loadSettings` only ever hid, so the panel stayed hidden here even
    // though `state.settings.detail_visible` was back to true.
    await openProject();
    expect(state.settings.detail_visible).toBe(true);
    expect(panelDisplay()).toBe('flex');
    expect(handleDisplay()).toBe('');
  });
});
