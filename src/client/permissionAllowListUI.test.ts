/**
 * HS-7953 — pure-helper tests for the allow-list management UI. The DOM-
 * mounting paths (table render, +Add form, overlay shortcut) are exercised
 * at e2e; these pin the pure regex-escape / pattern-validation / id-gen /
 * parser logic.
 *
 * HS-7976 — happy-dom tests for the overlay's "Always allow this" link +
 * customize gear flow.
 *
 * HS-8026 — happy-dom tests for the new modal rule editor (open / save /
 * cancel / validation) and the row-renders-pencil-and-trash assertion.
 */
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from './api.js';
import {
  type AllowRule,
  buildAlwaysAllowAffordance,
  loadAndRenderAllowList,
  newRuleId,
  openRuleEditor,
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

// ---------------------------------------------------------------------------
// HS-8026 — DOM tests for the new row layout + modal editor
// ---------------------------------------------------------------------------

vi.mock('./api.js', () => ({
  api: vi.fn(),
}));

vi.mock('./confirm.js', () => ({
  confirmDialog: vi.fn(() => Promise.resolve(true)),
}));

describe('loadAndRenderAllowList row layout (HS-8026)', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
    document.body.innerHTML = '<div id="permission-allow-list"></div>';
  });
  afterEach(() => {
    document.querySelectorAll('.cmd-editor-overlay').forEach(el => el.remove());
    document.body.innerHTML = '';
  });

  it('renders an empty-state hint and the Add button when no rules exist', async () => {
    vi.mocked(api).mockResolvedValueOnce({ permission_allow_rules: [] } as never);
    await loadAndRenderAllowList();
    const list = document.getElementById('permission-allow-list')!;
    expect(list.querySelector('.permission-allow-empty')).not.toBeNull();
    expect(list.querySelector('#permission-allow-add-btn')).not.toBeNull();
  });

  it('renders one row per rule with pencil + trash icon buttons (no date / no overlay column)', async () => {
    const rules: AllowRule[] = [
      { id: 'r1', tool: 'Bash', pattern: '^git status$', added_at: '2026-04-28T00:00:00Z', added_by: 'overlay' },
      { id: 'r2', tool: 'Read', pattern: '^/etc/hosts$', added_at: '2026-04-29T00:00:00Z', added_by: 'settings' },
    ];
    vi.mocked(api).mockResolvedValueOnce({ permission_allow_rules: rules } as never);
    await loadAndRenderAllowList();
    const list = document.getElementById('permission-allow-list')!;
    const rows = list.querySelectorAll('.permission-allow-rule-row');
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.querySelector('.permission-allow-edit')).not.toBeNull();
      expect(row.querySelector('.permission-allow-delete')).not.toBeNull();
      // Drop date / overlay columns.
      expect(row.querySelector('.permission-allow-meta')).toBeNull();
    }
  });

  it('puts the full pattern in a `title` tooltip so long patterns stay discoverable when the cell ellipsis-truncates', async () => {
    const longPattern = '^npx vitest run src/text-to-pattern/extremely/long/path/here$';
    vi.mocked(api).mockResolvedValueOnce({
      permission_allow_rules: [{ id: 'r1', tool: 'Bash', pattern: longPattern, added_at: 'now' }],
    } as never);
    await loadAndRenderAllowList();
    const code = document.querySelector<HTMLElement>('.permission-allow-rule-pattern')!;
    expect(code.getAttribute('title')).toBe(longPattern);
    expect(code.textContent).toBe(longPattern);
  });

  it('clicking the row opens the editor in edit mode pre-filled with the rule', async () => {
    vi.mocked(api).mockResolvedValueOnce({
      permission_allow_rules: [{ id: 'r1', tool: 'Bash', pattern: '^git status$', added_at: 'now' }],
    } as never);
    await loadAndRenderAllowList();
    const row = document.querySelector<HTMLElement>('.permission-allow-rule-row')!;
    row.click();
    const overlay = document.querySelector<HTMLElement>('.cmd-editor-overlay.permission-allow-editor')!;
    expect(overlay).not.toBeNull();
    expect(overlay.querySelector<HTMLElement>('.cmd-editor-dialog-header span')!.textContent).toBe('Edit allow rule');
    const pattern = overlay.querySelector<HTMLTextAreaElement>('.permission-allow-edit-pattern')!;
    expect(pattern.value).toBe('^git status$');
    const tool = overlay.querySelector<HTMLSelectElement>('.permission-allow-edit-tool')!;
    expect(tool.value).toBe('Bash');
  });

  it('clicking the pencil opens the editor (and stops propagation so the row click does not fire twice)', async () => {
    vi.mocked(api).mockResolvedValueOnce({
      permission_allow_rules: [{ id: 'r1', tool: 'Bash', pattern: '^x$', added_at: 'now' }],
    } as never);
    await loadAndRenderAllowList();
    const editBtn = document.querySelector<HTMLButtonElement>('.permission-allow-edit')!;
    editBtn.click();
    const overlays = document.querySelectorAll('.cmd-editor-overlay.permission-allow-editor');
    expect(overlays.length).toBe(1);
  });

  it('clicking the trash button confirms and PATCHes a rules list with the row removed', async () => {
    const rules: AllowRule[] = [
      { id: 'r1', tool: 'Bash', pattern: '^x$', added_at: 'now' },
      { id: 'r2', tool: 'Read', pattern: '^y$', added_at: 'now' },
    ];
    // First call: initial fetch. Second call: re-fetch inside deleteRule.
    // Third: PATCH (returns whatever).
    vi.mocked(api)
      .mockResolvedValueOnce({ permission_allow_rules: rules } as never)
      .mockResolvedValueOnce({ permission_allow_rules: rules } as never)
      .mockResolvedValueOnce(undefined as never);
    await loadAndRenderAllowList();
    const trashBtn = document.querySelector<HTMLButtonElement>('.permission-allow-rule-row[data-rule-id="r1"] .permission-allow-delete')!;
    trashBtn.click();
    // Wait for the confirm + delete + PATCH chain to settle.
    await new Promise<void>(r => setTimeout(r, 0));
    await new Promise<void>(r => setTimeout(r, 0));
    await new Promise<void>(r => setTimeout(r, 0));

    const patchCall = vi.mocked(api).mock.calls.find(c => c[1]?.method === 'PATCH');
    expect(patchCall).toBeDefined();
    const body = patchCall?.[1]?.body as { permission_allow_rules: AllowRule[] };
    expect(body.permission_allow_rules.map(r => r.id)).toEqual(['r2']);
  });
});

describe('openRuleEditor (HS-8026)', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
    document.body.innerHTML = '<div id="permission-allow-list"></div>';
  });
  afterEach(() => {
    document.querySelectorAll('.cmd-editor-overlay').forEach(el => el.remove());
    document.body.innerHTML = '';
  });

  it('add mode shows the "Add allow rule" header and an empty pattern', () => {
    const overlay = openRuleEditor({ mode: 'add' });
    expect(overlay.querySelector<HTMLElement>('.cmd-editor-dialog-header span')!.textContent).toBe('Add allow rule');
    expect(overlay.querySelector<HTMLTextAreaElement>('.permission-allow-edit-pattern')!.value).toBe('');
    expect(overlay.querySelector<HTMLButtonElement>('.permission-allow-edit-save')!.textContent).toBe('Add rule');
  });

  it('save with a blank pattern surfaces a validation error and does not PATCH', async () => {
    openRuleEditor({ mode: 'add' });
    const saveBtn = document.querySelector<HTMLButtonElement>('.permission-allow-edit-save')!;
    saveBtn.click();
    await new Promise<void>(r => setTimeout(r, 0));
    const errorEl = document.querySelector<HTMLElement>('.permission-allow-edit-error')!;
    expect(errorEl.style.display).toBe('');
    expect(errorEl.textContent).toMatch(/Pattern is required/);
    expect(api).not.toHaveBeenCalled();
  });

  it('save with a valid pattern PATCHes the existing list with the new rule appended (add mode)', async () => {
    vi.mocked(api).mockImplementation((path: string, opts?: { method?: string }) => {
      if (path === '/file-settings' && opts?.method !== 'PATCH') {
        return Promise.resolve({ permission_allow_rules: [] } as never);
      }
      return Promise.resolve(undefined as never);
    });
    openRuleEditor({ mode: 'add' });
    const pattern = document.querySelector<HTMLTextAreaElement>('.permission-allow-edit-pattern')!;
    pattern.value = '^npm run test$';
    document.querySelector<HTMLButtonElement>('.permission-allow-edit-save')!.click();
    await new Promise<void>(r => setTimeout(r, 0));
    await new Promise<void>(r => setTimeout(r, 0));
    await new Promise<void>(r => setTimeout(r, 0));
    const patchCall = vi.mocked(api).mock.calls.find(c => c[1]?.method === 'PATCH');
    expect(patchCall).toBeDefined();
    const body = patchCall?.[1]?.body as { permission_allow_rules: AllowRule[] };
    expect(body.permission_allow_rules).toHaveLength(1);
    expect(body.permission_allow_rules[0].pattern).toBe('^npm run test$');
    expect(body.permission_allow_rules[0].added_by).toBe('settings');
  });

  it('save in edit mode replaces the existing rule in place (preserves id + added_at)', async () => {
    const existing: AllowRule = { id: 'r1', tool: 'Bash', pattern: '^old$', added_at: '2026-01-01T00:00:00Z', added_by: 'overlay' };
    vi.mocked(api).mockImplementation((path: string, opts?: { method?: string }) => {
      if (path === '/file-settings' && opts?.method !== 'PATCH') {
        return Promise.resolve({ permission_allow_rules: [existing] } as never);
      }
      return Promise.resolve(undefined as never);
    });
    openRuleEditor({ mode: 'edit', rule: existing });
    const pattern = document.querySelector<HTMLTextAreaElement>('.permission-allow-edit-pattern')!;
    pattern.value = '^new$';
    document.querySelector<HTMLButtonElement>('.permission-allow-edit-save')!.click();
    await new Promise<void>(r => setTimeout(r, 0));
    await new Promise<void>(r => setTimeout(r, 0));
    await new Promise<void>(r => setTimeout(r, 0));
    const patchCall = vi.mocked(api).mock.calls.find(c => c[1]?.method === 'PATCH');
    const body = patchCall?.[1]?.body as { permission_allow_rules: AllowRule[] };
    expect(body.permission_allow_rules).toHaveLength(1);
    expect(body.permission_allow_rules[0].id).toBe('r1');
    expect(body.permission_allow_rules[0].pattern).toBe('^new$');
    expect(body.permission_allow_rules[0].added_at).toBe('2026-01-01T00:00:00Z');
    expect(body.permission_allow_rules[0].added_by).toBe('overlay');
  });

  it('Cancel closes the dialog without PATCHing', () => {
    const overlay = openRuleEditor({ mode: 'add' });
    overlay.querySelector<HTMLButtonElement>('.permission-allow-edit-cancel')!.click();
    expect(document.querySelector('.cmd-editor-overlay')).toBeNull();
    expect(api).not.toHaveBeenCalled();
  });

  it('clicking the backdrop closes the dialog', () => {
    const overlay = openRuleEditor({ mode: 'add' });
    // Direct backdrop click (e.target === overlay).
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.cmd-editor-overlay')).toBeNull();
  });

  it('opening the editor twice replaces the prior overlay (no stacking)', () => {
    openRuleEditor({ mode: 'add' });
    openRuleEditor({ mode: 'add' });
    expect(document.querySelectorAll('.cmd-editor-overlay.permission-allow-editor').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// HS-7976 — buildAlwaysAllowAffordance behavior
// ---------------------------------------------------------------------------

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
    vi.mocked(api).mockImplementation((path: string) => {
      if (path === '/file-settings' && typeof path === 'string') return Promise.resolve({ permission_allow_rules: [] } as never);
      return Promise.resolve(undefined as never);
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
    vi.mocked(api).mockImplementation((path: string) => {
      if (path === '/file-settings') return Promise.resolve({ permission_allow_rules: [] } as never);
      return Promise.resolve(undefined as never);
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
