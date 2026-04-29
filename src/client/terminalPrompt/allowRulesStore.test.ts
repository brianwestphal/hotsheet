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

const apiMock = vi.fn();

vi.mock('../api.js', () => ({
  api: (...args: unknown[]) => apiMock(...args),
}));

beforeEach(() => {
  apiMock.mockReset();
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
