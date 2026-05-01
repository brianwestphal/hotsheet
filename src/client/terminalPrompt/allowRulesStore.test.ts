// @vitest-environment happy-dom
/**
 * HS-7987 / HS-7988 — async store tests. We mock the `api()` helper so
 * the store's network calls become inspectable without a running server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetAllowRulesCacheForTests,
  appendAllowRule,
  getAllowRules,
  loadAllowRules,
  removeAllowRule,
  subscribeToAllowRules,
} from './allowRulesStore.js';

const apiMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const apiWithSecretMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock('../api.js', () => ({
  api: (...args: unknown[]) => apiMock(...args),
  apiWithSecret: (...args: unknown[]) => apiWithSecretMock(...args),
}));

beforeEach(() => {
  apiMock.mockReset();
  apiWithSecretMock.mockReset();
  __resetAllowRulesCacheForTests();
});

afterEach(() => {
  __resetAllowRulesCacheForTests();
});

describe('loadAllowRules (HS-7987)', () => {
  it('hydrates the cache from /file-settings', async () => {
    apiMock.mockResolvedValueOnce({
      terminal_prompt_allow_rules: [{
        id: 'r1', parser_id: 'claude-numbered', question_hash: 'abc',
        choice_index: 0, created_at: '',
      }],
    });
    const rules = await loadAllowRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe('r1');
  });

  it('returns an empty list when the key is absent', async () => {
    apiMock.mockResolvedValueOnce({});
    expect(await loadAllowRules()).toEqual([]);
  });
});

describe('getAllowRules pre-hydration (HS-7987)', () => {
  it('returns [] before hydration completes', () => {
    apiMock.mockResolvedValueOnce({});
    expect(getAllowRules()).toEqual([]);
  });
});

describe('appendAllowRule (HS-7987)', () => {
  it('PATCHes the new rule into settings + updates the cache', async () => {
    apiMock.mockResolvedValueOnce({ terminal_prompt_allow_rules: [] });
    apiMock.mockResolvedValueOnce({});
    await appendAllowRule({
      id: 'r-new', parser_id: 'yesno', question_hash: 'aabb',
      choice_index: 0, created_at: '2026-04-28T00:00:00Z',
    });
    expect(apiMock.mock.calls.length).toBe(2);
    expect(apiMock.mock.calls[0][0]).toBe('/file-settings');
    expect(apiMock.mock.calls[1][0]).toBe('/file-settings');
    const patchBody = (apiMock.mock.calls[1][1] as { method: string; body: { terminal_prompt_allow_rules: unknown[] } }).body;
    expect(patchBody.terminal_prompt_allow_rules).toHaveLength(1);
    expect((patchBody.terminal_prompt_allow_rules[0] as { id: string }).id).toBe('r-new');
    expect(getAllowRules()).toHaveLength(1);
  });

  it('preserves prior rules when appending', async () => {
    apiMock.mockResolvedValueOnce({
      terminal_prompt_allow_rules: [{
        id: 'r-old', parser_id: 'yesno', question_hash: 'aabb',
        choice_index: 0, created_at: '',
      }],
    });
    apiMock.mockResolvedValueOnce({});
    await appendAllowRule({
      id: 'r-new', parser_id: 'claude-numbered', question_hash: 'cccd',
      choice_index: 1, created_at: '',
    });
    const patchBody = (apiMock.mock.calls[1][1] as { method: string; body: { terminal_prompt_allow_rules: unknown[] } }).body;
    expect(patchBody.terminal_prompt_allow_rules).toHaveLength(2);
    expect(getAllowRules()).toHaveLength(2);
  });
});

/**
 * HS-8057 — when the cross-project bell-poll dispatcher surfaces a
 * prompt from a project that ISN'T the active one, "Always choose this"
 * has to write the rule into the originating project's settings.json
 * (the server-side scanner gate at `registry.ts::findMatchingRuleForProject`
 * reads each project's settings via its dataDir, so a rule written into
 * the active project's settings would never match an originating
 * project's prompt). Pre-fix `appendAllowRule(rule)` always routed
 * through `api()` (active project's secret); fix routes through
 * `apiWithSecret(secret)` when the optional `secret` argument is
 * provided.
 */
describe('appendAllowRule cross-project secret routing (HS-8057)', () => {
  it('routes through apiWithSecret with the originating project secret + does NOT use active-project api()', async () => {
    apiWithSecretMock.mockResolvedValueOnce({ terminal_prompt_allow_rules: [] });
    apiWithSecretMock.mockResolvedValueOnce({});
    await appendAllowRule({
      id: 'r-cross', parser_id: 'claude-numbered', question_hash: 'xx',
      choice_index: 0, created_at: '2026-05-01T00:00:00Z',
    }, 'origin-secret');
    expect(apiMock).not.toHaveBeenCalled();
    expect(apiWithSecretMock.mock.calls.length).toBe(2);
    expect(apiWithSecretMock.mock.calls[0][0]).toBe('/file-settings');
    expect(apiWithSecretMock.mock.calls[0][1]).toBe('origin-secret');
    expect(apiWithSecretMock.mock.calls[1][0]).toBe('/file-settings');
    expect(apiWithSecretMock.mock.calls[1][1]).toBe('origin-secret');
    const patchBody = (apiWithSecretMock.mock.calls[1][2] as { method: string; body: { terminal_prompt_allow_rules: unknown[] } }).body;
    expect(patchBody.terminal_prompt_allow_rules).toHaveLength(1);
    expect((patchBody.terminal_prompt_allow_rules[0] as { id: string }).id).toBe('r-cross');
  });

  it('skips the in-memory cache update when secret is provided (cache tracks active project only)', async () => {
    apiWithSecretMock.mockResolvedValueOnce({ terminal_prompt_allow_rules: [] });
    apiWithSecretMock.mockResolvedValueOnce({});
    await appendAllowRule({
      id: 'r-cross', parser_id: 'yesno', question_hash: 'yy',
      choice_index: 1, created_at: '',
    }, 'other-project-secret');
    // The active-project cache should be untouched — Settings UI for
    // the originating project re-hydrates on next open via loadAllowRules().
    expect(getAllowRules()).toEqual([]);
  });

  it('omitted secret keeps the active-project path (back-compat)', async () => {
    apiMock.mockResolvedValueOnce({ terminal_prompt_allow_rules: [] });
    apiMock.mockResolvedValueOnce({});
    await appendAllowRule({
      id: 'r-active', parser_id: 'yesno', question_hash: 'aa',
      choice_index: 0, created_at: '',
    });
    expect(apiWithSecretMock).not.toHaveBeenCalled();
    expect(apiMock.mock.calls.length).toBe(2);
    expect(getAllowRules()).toHaveLength(1);
  });
});

describe('removeAllowRule (HS-7988)', () => {
  it('PATCHes the trimmed list back', async () => {
    apiMock.mockResolvedValueOnce({
      terminal_prompt_allow_rules: [
        { id: 'r1', parser_id: 'yesno', question_hash: 'a', choice_index: 0, created_at: '' },
        { id: 'r2', parser_id: 'yesno', question_hash: 'b', choice_index: 1, created_at: '' },
      ],
    });
    apiMock.mockResolvedValueOnce({});
    await removeAllowRule('r1');
    const patchBody = (apiMock.mock.calls[1][1] as { method: string; body: { terminal_prompt_allow_rules: unknown[] } }).body;
    expect(patchBody.terminal_prompt_allow_rules).toHaveLength(1);
    expect((patchBody.terminal_prompt_allow_rules[0] as { id: string }).id).toBe('r2');
    expect(getAllowRules()).toHaveLength(1);
  });

  it('is a no-op when the id is unknown', async () => {
    apiMock.mockResolvedValueOnce({
      terminal_prompt_allow_rules: [
        { id: 'r1', parser_id: 'yesno', question_hash: 'a', choice_index: 0, created_at: '' },
      ],
    });
    apiMock.mockResolvedValueOnce({});
    await removeAllowRule('r-does-not-exist');
    const patchBody = (apiMock.mock.calls[1][1] as { method: string; body: { terminal_prompt_allow_rules: unknown[] } }).body;
    expect(patchBody.terminal_prompt_allow_rules).toHaveLength(1);
  });
});

describe('subscribeToAllowRules (HS-7988)', () => {
  it('fires the callback on hydrate + append + remove', async () => {
    const cb = vi.fn();
    subscribeToAllowRules(cb);
    apiMock.mockResolvedValueOnce({ terminal_prompt_allow_rules: [] });
    await loadAllowRules();
    apiMock.mockResolvedValueOnce({ terminal_prompt_allow_rules: [] });
    apiMock.mockResolvedValueOnce({});
    await appendAllowRule({
      id: 'r1', parser_id: 'yesno', question_hash: 'a', choice_index: 0, created_at: '',
    });
    apiMock.mockResolvedValueOnce({
      terminal_prompt_allow_rules: [
        { id: 'r1', parser_id: 'yesno', question_hash: 'a', choice_index: 0, created_at: '' },
      ],
    });
    apiMock.mockResolvedValueOnce({});
    await removeAllowRule('r1');
    expect(cb.mock.calls.length).toBe(3);
  });
});
