/**
 * HS-8635 — settings / file-settings / global-config typed-API module.
 * Verifies the response schemas (incl. the `.loose()` passthrough + the
 * per-field `.catch(undefined)` graceful-degrade on a mistyped key) and that
 * each caller hits the right path + method, forwarding `secret` where given.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiCallOpts, type ApiTransport, setApiTransport } from './_runner.js';
import {
  CategoryPresetSchema, FileSettingsSchema, getCategories, getCategoryPresets, getFileSettings,
  getGlobalConfig, getSettings, getTags, GlobalConfigSchema, SettingsSchema, updateCategories,
  updateFileSettings, updateGlobalConfig, updateSettings,
} from './settings.js';

const cat = { id: 'bug', label: 'Bug', shortLabel: 'Bug', color: '#f00', shortcutKey: 'b', description: 'A bug' };

let lastCall: { path: string; opts: ApiCallOpts } | undefined;
function stub(result: unknown): void {
  setApiTransport(vi.fn<ApiTransport>((path, opts) => { lastCall = { path, opts }; return Promise.resolve(result); }));
}
afterEach(() => { setApiTransport(null as unknown as ApiTransport); lastCall = undefined; });

describe('settings schemas (HS-8635)', () => {
  it('SettingsSchema accepts a string map, rejects non-string values', () => {
    expect(SettingsSchema.safeParse({ layout: 'columns', sort_by: 'priority' }).success).toBe(true);
    expect(SettingsSchema.safeParse({ trash_cleanup_days: 30 }).success).toBe(false);
  });

  it('FileSettingsSchema enumerates known keys AND passes unknown keys through (.loose())', () => {
    const parsed = FileSettingsSchema.safeParse({
      appName: 'Proj', db_snapshot_protection: true, telemetry_retention_days: 30,
      terminals: [{ id: 'default' }], some_future_key: { nested: 1 },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.appName).toBe('Proj');
    expect(parsed.data?.db_snapshot_protection).toBe(true);
    // Unknown key survives via .loose().
    expect((parsed.data as Record<string, unknown>).some_future_key).toEqual({ nested: 1 });
  });

  it('FileSettingsSchema degrades a single mistyped known key to undefined (.catch), keeping the rest', () => {
    // db_snapshot_protection stored as a legacy string instead of boolean.
    const parsed = FileSettingsSchema.safeParse({ appName: 'P', db_snapshot_protection: 'true' });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.appName).toBe('P');
    expect(parsed.data?.db_snapshot_protection).toBeUndefined();
  });

  it('FileSettingsSchema tolerates the string-or-native unions (terminals, drawer_open, scrollback)', () => {
    expect(FileSettingsSchema.safeParse({ terminals: '[]', drawer_open: 'true', terminal_scrollback_bytes: '1000' }).success).toBe(true);
    expect(FileSettingsSchema.safeParse({ terminals: [], drawer_open: true, terminal_scrollback_bytes: 1000 }).success).toBe(true);
  });

  it('GlobalConfigSchema is the shared strict shape', () => {
    expect(GlobalConfigSchema.safeParse({ channelEnabled: true, dashboard: { layoutMode: 'flow' } }).success).toBe(true);
    // .strict() rejects an unknown top-level key.
    expect(GlobalConfigSchema.safeParse({ bogusKey: 1 }).success).toBe(false);
  });
});

describe('settings callers (HS-8635)', () => {
  it('getSettings / updateSettings → GET / PATCH /settings', async () => {
    stub({ layout: 'columns' });
    expect(await getSettings()).toEqual({ layout: 'columns' });
    expect(lastCall).toEqual({ path: '/settings', opts: {} });
    stub({ ok: true });
    await updateSettings({ layout: 'list' });
    expect(lastCall).toEqual({ path: '/settings', opts: { method: 'PATCH', body: { layout: 'list' } } });
  });

  it('getFileSettings / updateFileSettings → GET / PATCH /file-settings, forwarding secret', async () => {
    stub({ appName: 'P' });
    await getFileSettings();
    expect(lastCall).toEqual({ path: '/file-settings', opts: { secret: undefined } });
    await getFileSettings('sek');
    expect(lastCall).toEqual({ path: '/file-settings', opts: { secret: 'sek' } });
    stub({ db_snapshot_protection: true });
    await updateFileSettings({ db_snapshot_protection: true });
    expect(lastCall).toEqual({ path: '/file-settings', opts: { method: 'PATCH', body: { db_snapshot_protection: true }, secret: undefined } });
    await updateFileSettings({ confirm_quit_with_running_terminals: 'never' }, 'sek');
    expect(lastCall).toEqual({ path: '/file-settings', opts: { method: 'PATCH', body: { confirm_quit_with_running_terminals: 'never' }, secret: 'sek' } });
  });

  it('getGlobalConfig / updateGlobalConfig → GET / PATCH /global-config', async () => {
    stub({ channelEnabled: true });
    expect(await getGlobalConfig()).toEqual({ channelEnabled: true });
    expect(lastCall?.path).toBe('/global-config');
    stub({ channelEnabled: false, dashboard: { columnsPerRow: 3 } });
    await updateGlobalConfig({ dashboard: { columnsPerRow: 3 } });
    expect(lastCall).toEqual({ path: '/global-config', opts: { method: 'PATCH', body: { dashboard: { columnsPerRow: 3 } } } });
  });

  it('rejects a /settings response with a non-string value', async () => {
    stub({ trash_cleanup_days: 30 });
    await expect(getSettings()).rejects.toThrow(/response shape mismatch/);
  });

  it('getTags / getCategories / updateCategories / getCategoryPresets (HS-8638)', async () => {
    stub(['urgent', 'docs']);
    expect(await getTags()).toEqual(['urgent', 'docs']);
    expect(lastCall?.path).toBe('/tags');
    stub([cat]);
    expect(await getCategories()).toEqual([cat]);
    expect(lastCall?.path).toBe('/categories');
    stub([cat]);
    await updateCategories([cat]);
    expect(lastCall).toEqual({ path: '/categories', opts: { method: 'PUT', body: [cat] } });
    stub([{ id: 'software', name: 'Software', categories: [cat] }]);
    expect(await getCategoryPresets()).toEqual([{ id: 'software', name: 'Software', categories: [cat] }]);
    expect(lastCall?.path).toBe('/category-presets');
  });

  it('CategoryPresetSchema validates the preset shape', () => {
    expect(CategoryPresetSchema.safeParse({ id: 'p', name: 'P', categories: [cat] }).success).toBe(true);
    expect(CategoryPresetSchema.safeParse({ id: 'p', name: 'P', categories: [{ id: 'x' }] }).success).toBe(false);
  });
});
