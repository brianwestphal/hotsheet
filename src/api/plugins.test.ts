/**
 * HS-8637 — plugins typed-API module. Verifies the response schemas accept a
 * real payload / reject a malformed one (incl. the list-vs-detail optional
 * fields, the recursive `configLayout`, and the extra-field stripping on
 * `/sync/conflicts` + `/backends`), and that every caller hits the right path
 * + method (+ unwraps where it should).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiCallOpts, type ApiTransport, setApiTransport } from './_runner.js';
import {
  BackendInfoSchema, BundledPluginInfoSchema, disablePlugin, enablePlugin, enablePluginEverywhere,
  getBackends, getBundledPlugins, getPlugin, getPluginConfigLabels, getPluginGlobalConfig,
  getPluginUiElements, getSyncConflicts, getSyncedTickets, installBundledPlugin, installPlugin,
  listPlugins, PluginInfoSchema, PluginUIElementSchema, resolveSyncConflict, revealPlugin,
  runPluginAction, setPluginGlobalConfig, SyncConflictSchema, SyncResultSchema, triggerPluginSync,
  uninstallPlugin, validatePluginField,
} from './plugins.js';

const listItem = {
  id: 'github', name: 'GitHub Issues', version: '1.0.0', description: null,
  enabled: true, hasBackend: true, error: null, preferences: [],
  needsConfiguration: false, missingFields: [],
};
const detail = {
  ...listItem, author: 'acme', configLayout: [
    { type: 'group', title: 'Auth', items: [{ type: 'preference', key: 'token' }] },
  ], path: '/p',
};
const conflictRow = {
  id: 1, ticket_id: 42, plugin_id: 'github', remote_id: 'gh-9',
  sync_status: 'conflict', conflict_data: '{}',
  // Extra TicketSyncRecord columns the conflict list doesn't render — stripped.
  last_synced_at: 't', remote_updated_at: null, local_updated_at: 't',
};

let lastCall: { path: string; opts: ApiCallOpts } | undefined;
function stub(result: unknown): void {
  const t = vi.fn<ApiTransport>((path, opts) => { lastCall = { path, opts }; return Promise.resolve(result); });
  setApiTransport(t);
}

afterEach(() => { setApiTransport(null as unknown as ApiTransport); lastCall = undefined; });

describe('plugins schemas (HS-8637)', () => {
  it('one PluginInfoSchema covers both the list item (no author/configLayout/path) and the detail', () => {
    expect(PluginInfoSchema.safeParse(listItem).success).toBe(true);
    expect(PluginInfoSchema.safeParse(detail).success).toBe(true);
    // Recursive configLayout group nesting validates.
    const parsed = PluginInfoSchema.safeParse(detail);
    expect(parsed.success && parsed.data.configLayout?.[0].items?.[0].key).toBe('token');
    // A missing required field (preferences) fails.
    const { preferences: _p, ...noPrefs } = listItem;
    expect(PluginInfoSchema.safeParse(noPrefs).success).toBe(false);
  });

  it('accepts / rejects the smaller payloads', () => {
    expect(PluginUIElementSchema.safeParse({ id: 'x', type: 'button', location: 'toolbar' }).success).toBe(true);
    expect(BundledPluginInfoSchema.safeParse({ manifest: { id: 'a', name: 'A', version: '1' }, installed: false, dismissed: false }).success).toBe(true);
    expect(SyncResultSchema.safeParse({ ok: true, pulled: 2 }).success).toBe(true);
    expect(BackendInfoSchema.safeParse({ id: 'a', name: 'A' }).success).toBe(true);
    expect(PluginUIElementSchema.safeParse({ id: 'x', type: 'button' }).success).toBe(false); // missing location
  });

  it('SyncConflictSchema strips the extra TicketSyncRecord columns', () => {
    const parsed = SyncConflictSchema.safeParse(conflictRow);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({
      id: 1, ticket_id: 42, plugin_id: 'github', remote_id: 'gh-9',
      sync_status: 'conflict', conflict_data: '{}',
    });
  });

  it('BackendInfoSchema strips capabilities', () => {
    const parsed = BackendInfoSchema.safeParse({ id: 'a', name: 'A', capabilities: { push: true } });
    expect(parsed.success && parsed.data).toEqual({ id: 'a', name: 'A' });
  });
});

describe('plugins callers route to the right endpoint (HS-8637)', () => {
  it('GET reads', async () => {
    stub([listItem]);
    await listPlugins(); expect(lastCall?.path).toBe('/plugins');
    stub(detail);
    await getPlugin('git/hub'); expect(lastCall?.path).toBe('/plugins/git%2Fhub');
    stub([]);
    await getPluginUiElements(); expect(lastCall?.path).toBe('/plugins/ui');
    await getBundledPlugins(); expect(lastCall?.path).toBe('/plugins/bundled');
    await getBackends(); expect(lastCall?.path).toBe('/backends');
    await getSyncConflicts(); expect(lastCall?.path).toBe('/sync/conflicts');
    stub({});
    await getSyncedTickets(); expect(lastCall?.path).toBe('/sync/tickets');
    await getPluginConfigLabels('github'); expect(lastCall?.path).toBe('/plugins/config-labels/github');
  });

  it('enable / disable / enable-all / uninstall / reveal → POST {ok:true}', async () => {
    stub({ ok: true });
    await enablePlugin('github'); expect(lastCall).toEqual({ path: '/plugins/github/enable', opts: { method: 'POST' } });
    await disablePlugin('github'); expect(lastCall?.path).toBe('/plugins/github/disable');
    await enablePluginEverywhere('github'); expect(lastCall?.path).toBe('/plugins/github/enable-all');
    await uninstallPlugin('github'); expect(lastCall?.path).toBe('/plugins/github/uninstall');
    await revealPlugin('github'); expect(lastCall?.path).toBe('/plugins/github/reveal');
    await installBundledPlugin('github'); expect(lastCall?.path).toBe('/plugins/bundled/github/install');
  });

  it('installPlugin → POST /plugins/install with { path }', async () => {
    stub({ ok: true, installed: '/p' });
    expect(await installPlugin('/p')).toEqual({ ok: true, installed: '/p' });
    expect(lastCall).toEqual({ path: '/plugins/install', opts: { method: 'POST', body: { path: '/p' } } });
  });

  it('triggerPluginSync → POST /plugins/:id/sync returns SyncResult', async () => {
    stub({ ok: true, pulled: 1, pushed: 0 });
    expect(await triggerPluginSync('github')).toEqual({ ok: true, pulled: 1, pushed: 0 });
    expect(lastCall).toEqual({ path: '/plugins/github/sync', opts: { method: 'POST' } });
  });

  it('runPluginAction → POST /plugins/:id/action with the action body', async () => {
    stub({ ok: true, result: { redirect: 'sync' } });
    const r = await runPluginAction('github', { actionId: 'doSync', ticketIds: [1, 2] });
    expect(r.result?.redirect).toBe('sync');
    expect(lastCall).toEqual({ path: '/plugins/github/action', opts: { method: 'POST', body: { actionId: 'doSync', ticketIds: [1, 2] } } });
  });

  it('getPluginGlobalConfig unwraps to the value; setPluginGlobalConfig posts the pair', async () => {
    stub({ value: 'tok' });
    expect(await getPluginGlobalConfig('github', 'token')).toBe('tok');
    expect(lastCall?.path).toBe('/plugins/github/global-config/token');
    stub({ ok: true });
    await setPluginGlobalConfig('github', 'token', 'tok');
    expect(lastCall).toEqual({ path: '/plugins/github/global-config', opts: { method: 'POST', body: { key: 'token', value: 'tok' } } });
  });

  it('validatePluginField → POST /plugins/validate/:id, tolerates a null result', async () => {
    stub(null);
    expect(await validatePluginField('github', 'token', 'x')).toBeNull();
    expect(lastCall).toEqual({ path: '/plugins/validate/github', opts: { method: 'POST', body: { key: 'token', value: 'x' } } });
    stub({ status: 'error', message: 'bad' });
    expect(await validatePluginField('github', 'token', 'x')).toEqual({ status: 'error', message: 'bad' });
  });

  it('resolveSyncConflict → POST /sync/conflicts/:id/resolve with plugin_id + resolution', async () => {
    stub({ ok: true });
    await resolveSyncConflict(42, 'github', 'keep_local');
    expect(lastCall).toEqual({ path: '/sync/conflicts/42/resolve', opts: { method: 'POST', body: { plugin_id: 'github', resolution: 'keep_local' } } });
  });

  it('rejects a malformed list response', async () => {
    stub([{ ...listItem, enabled: 'yes' }]);
    await expect(listPlugins()).rejects.toThrow(/response shape mismatch/);
  });
});
