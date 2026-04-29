/**
 * HS-7953 — pure-helper tests for the allow-list management UI. The DOM-
 * mounting paths (table render, +Add form, overlay shortcut) are exercised
 * at e2e; these pin the pure regex-escape / pattern-validation / id-gen /
 * meta-formatting / parser logic.
 *
 * HS-7976 — happy-dom tests for the overlay's "Always allow this" link +
 * customize gear flow. See bottom of file.
 */
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from './api.js';
import {
  type AllowRule,
  buildAlwaysAllowAffordance,
  formatRuleMeta,
  newRuleId,
  parseRules,
  regexEscape,
  validatePattern,
} from './permissionAllowListUI.js';

describe('regexEscape (HS-7953)', () => {
  it('escapes regex metacharacters so a literal command becomes a safe pattern', () => {
    expect(regexEscape('git status')).toBe('git status');
    expect(regexEscape('a.b')).toBe('a\\.b');
    expect(regexEscape('git log -p')).toBe('git log -p');
    expect(regexEscape('foo (bar) | baz')).toBe('foo \\(bar\\) \\| baz');
    expect(regexEscape('[a-z]+')).toBe('\\[a-z\\]\\+');
  });

  it('preserves spaces and word characters', () => {
    expect(regexEscape('npm run dev')).toBe('npm run dev');
  });
});

describe('validatePattern (HS-7953)', () => {
  it('returns null for a well-formed pattern', () => {
    expect(validatePattern('^git status$')).toBeNull();
    expect(validatePattern('foo')).toBeNull();
    expect(validatePattern('^git (status|diff)$')).toBeNull();
  });

  it('returns an error message for an empty / whitespace-only pattern', () => {
    expect(validatePattern('')).toBe('Pattern is required');
    expect(validatePattern('   ')).toBe('Pattern is required');
  });

  it('returns an error message for an invalid regex', () => {
    expect(validatePattern('[unclosed')).not.toBeNull();
    expect(validatePattern('(?<foo>bad')).not.toBeNull();
  });
});

describe('newRuleId (HS-7953)', () => {
  it('generates unique-looking ids prefixed with `ar_`', () => {
    const id = newRuleId(1700000000000, 0.5);
    expect(id).toMatch(/^ar_/);
    // Determinism with explicit args.
    expect(newRuleId(1700000000000, 0.5)).toBe(id);
  });

  it('produces different ids for different inputs', () => {
    expect(newRuleId(1, 0.1)).not.toBe(newRuleId(2, 0.1));
    expect(newRuleId(1, 0.1)).not.toBe(newRuleId(1, 0.2));
  });
});

describe('parseRules (HS-7953)', () => {
  it('returns [] for empty / unparseable input', () => {
    expect(parseRules(undefined)).toEqual([]);
    expect(parseRules(null)).toEqual([]);
    expect(parseRules('')).toEqual([]);
    expect(parseRules('not-json')).toEqual([]);
    expect(parseRules(42)).toEqual([]);
  });

  it('parses a well-formed array', () => {
    const raw = [{ id: 'r1', tool: 'Bash', pattern: '^git status$', added_at: '2026-04-28T00:00:00Z' }];
    expect(parseRules(raw)).toEqual(raw);
  });

  it('tolerates the legacy stringified-JSON shape', () => {
    const raw = JSON.stringify([{ id: 'r1', tool: 'Bash', pattern: '^x$', added_at: 'now' }]);
    expect(parseRules(raw)).toHaveLength(1);
  });

  it('drops entries with missing required fields', () => {
    const raw = [
      { id: 'r1', tool: 'Bash' }, // no pattern
      { id: '', tool: 'Bash', pattern: '^x$' }, // empty id
      { id: 'r2', tool: 'Bash', pattern: '^x$' }, // valid
    ];
    expect(parseRules(raw)).toHaveLength(1);
  });
});

describe('formatRuleMeta (HS-7953)', () => {
  function rule(o: Partial<AllowRule>): AllowRule {
    return { id: 'r1', tool: 'Bash', pattern: '^x$', added_at: '', ...o };
  }
  it('returns empty string when neither added_by nor added_at is meaningful', () => {
    expect(formatRuleMeta(rule({}))).toBe('');
  });
  it('joins added_by + formatted-date with a bullet separator', () => {
    const out = formatRuleMeta(rule({ added_by: 'overlay', added_at: '2026-04-28T00:00:00Z' }));
    expect(out).toContain('overlay');
    expect(out).toContain('·');
  });
  it('returns just added_by when added_at is invalid', () => {
    expect(formatRuleMeta(rule({ added_by: 'settings', added_at: 'not-a-date' }))).toBe('settings');
  });
  it('returns just the date when only added_at is set', () => {
    const out = formatRuleMeta(rule({ added_at: '2026-04-28T00:00:00Z' }));
    expect(out).not.toContain('·');
    expect(out.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// HS-7976 — buildAlwaysAllowAffordance behavior
// ---------------------------------------------------------------------------

vi.mock('./api.js', () => ({
  api: vi.fn(),
}));

describe('buildAlwaysAllowAffordance (HS-7976)', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
    document.body.innerHTML = '';
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function mount(onCommit: () => void): { root: HTMLElement; link: HTMLAnchorElement; gear: HTMLButtonElement; form: HTMLElement; row: HTMLElement } {
    const el = buildAlwaysAllowAffordance({
      toolName: 'Bash',
      primaryValue: 'ls ~/Desktop',
      onCommit,
    });
    if (el === null) throw new Error('expected affordance');
    document.body.appendChild(el);
    return {
      root: el,
      link: el.querySelector<HTMLAnchorElement>('.permission-popup-always-allow-link')!,
      gear: el.querySelector<HTMLButtonElement>('.permission-popup-always-allow-customize')!,
      form: el.querySelector<HTMLElement>('.permission-popup-always-allow-form')!,
      row: el.querySelector<HTMLElement>('.permission-popup-always-allow-row')!,
    };
  }

  it('returns null when the primary value is empty', () => {
    const el = buildAlwaysAllowAffordance({ toolName: 'Bash', primaryValue: '', onCommit: () => {} });
    expect(el).toBeNull();
  });

  it('returns null when the tool is not allow-listable', () => {
    const el = buildAlwaysAllowAffordance({ toolName: 'NotARealTool', primaryValue: 'x', onCommit: () => {} });
    expect(el).toBeNull();
  });

  it('shows link + gear button on the action row, and form is hidden by default', () => {
    const { link, gear, form } = mount(() => {});
    expect(link.textContent).toContain('Always allow this');
    expect(gear).not.toBeNull();
    expect(form.style.display).toBe('none');
  });

  it('clicking the link saves the auto-generated pattern AND calls onCommit immediately (no second step)', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/file-settings' && typeof path === 'string') return { permission_allow_rules: [] } as never;
      return undefined as never;
    });
    const onCommit = vi.fn();
    const { link, form } = mount(onCommit);

    link.click();
    // Wait one microtask for the api Promise chain to settle.
    await new Promise<void>(r => setTimeout(r, 0));
    await new Promise<void>(r => setTimeout(r, 0));

    expect(onCommit).toHaveBeenCalledOnce();
    expect(form.style.display).toBe('none');

    // The PATCH carries the auto-generated `^…$` pattern.
    const patchCall = vi.mocked(api).mock.calls.find(c => c[1]?.method === 'PATCH');
    expect(patchCall).toBeDefined();
    const body = patchCall?.[1]?.body as { permission_allow_rules: AllowRule[] };
    expect(body.permission_allow_rules).toHaveLength(1);
    expect(body.permission_allow_rules[0].pattern).toBe('^ls ~/Desktop$');
    expect(body.permission_allow_rules[0].tool).toBe('Bash');
  });

  it('clicking the gear button reveals the inline editor (and hides the link row)', () => {
    const { gear, form, row } = mount(() => {});
    gear.click();
    expect(form.style.display).toBe('');
    expect(row.style.display).toBe('none');
  });

  it('the inline editor still saves with the user-edited pattern when Save & Allow is clicked', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/file-settings') return { permission_allow_rules: [] } as never;
      return undefined as never;
    });
    const onCommit = vi.fn();
    const { gear, form, root } = mount(onCommit);

    gear.click();
    const input = form.querySelector<HTMLInputElement>('.permission-popup-always-allow-input')!;
    input.value = '^ls .+$';
    const confirm = root.querySelector<HTMLButtonElement>('.permission-popup-always-allow-confirm')!;
    confirm.click();
    await new Promise<void>(r => setTimeout(r, 0));
    await new Promise<void>(r => setTimeout(r, 0));

    expect(onCommit).toHaveBeenCalledOnce();
    const patchCall = vi.mocked(api).mock.calls.find(c => c[1]?.method === 'PATCH');
    const body = patchCall?.[1]?.body as { permission_allow_rules: AllowRule[] };
    expect(body.permission_allow_rules[0].pattern).toBe('^ls .+$');
  });

  it('Cancel inside the inline editor restores the link row without saving', () => {
    const { gear, form, row, root } = mount(() => {});
    gear.click();
    expect(form.style.display).toBe('');
    const cancel = root.querySelector<HTMLButtonElement>('.permission-popup-always-allow-cancel')!;
    cancel.click();
    expect(form.style.display).toBe('none');
    expect(row.style.display).toBe('');
    expect(api).not.toHaveBeenCalled();
  });
});
