// @vitest-environment happy-dom
/**
 * HS-8072 — happy-dom tests for the terminal-prompt allow-list UI: row
 * shape (parser / question / choice / created / trash), question wraps
 * to 2 lines via the `.tpal-rule-question` `-webkit-line-clamp: 2` CSS
 * rule + `title` tooltip, and the click-to-inspect dialog flow.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TerminalPromptAllowRule } from '../shared/terminalPrompt/allowRules.js';
import { loadAndRenderTerminalPromptAllowList } from './terminalPromptAllowListUI.js';

const loadAllowRulesMock = vi.fn<() => Promise<readonly TerminalPromptAllowRule[]>>();
const removeAllowRuleMock = vi.fn<(id: string) => Promise<void>>();
const subscribeToAllowRulesMock = vi.fn<(cb: (rules: readonly TerminalPromptAllowRule[]) => void) => void>();

vi.mock('./terminalPrompt/allowRulesStore.js', () => ({
  loadAllowRules: () => loadAllowRulesMock(),
  removeAllowRule: (id: string) => removeAllowRuleMock(id),
  subscribeToAllowRules: (cb: (rules: readonly TerminalPromptAllowRule[]) => void) => subscribeToAllowRulesMock(cb),
}));

vi.mock('./state.js', () => ({
  state: { settings: { terminal_prompt_detection_enabled: true } },
}));

const FIXTURE_RULE: TerminalPromptAllowRule = {
  id: 'tp_test_1',
  parser_id: 'claude-numbered',
  question_hash: 'deadbeef',
  question_preview: 'WARNING: Loading development channels with elevated trust — proceed only if you understand the implications',
  choice_index: 0,
  choice_label: 'I am using this for local development',
  created_at: '2026-05-01T07:56:08.254Z',
};

beforeEach(() => {
  document.body.innerHTML = '<div id="terminal-prompt-allow-list"></div>';
  loadAllowRulesMock.mockReset();
  removeAllowRuleMock.mockReset();
  subscribeToAllowRulesMock.mockReset();
});

afterEach(() => {
  document.querySelectorAll('.cmd-editor-overlay').forEach(el => el.remove());
  document.body.innerHTML = '';
});

describe('terminalPromptAllowListUI row layout (HS-8072)', () => {
  it('renders the empty-state hint when no rules exist', async () => {
    loadAllowRulesMock.mockResolvedValueOnce([]);
    await loadAndRenderTerminalPromptAllowList();
    const list = document.getElementById('terminal-prompt-allow-list')!;
    expect(list.querySelector('.permission-allow-empty')).not.toBeNull();
  });

  it('renders one row per rule with the new tpal-rule-* layout', async () => {
    loadAllowRulesMock.mockResolvedValueOnce([FIXTURE_RULE]);
    await loadAndRenderTerminalPromptAllowList();
    const row = document.querySelector<HTMLElement>('.tpal-rule-row');
    expect(row).not.toBeNull();
    expect(row!.querySelector('.tpal-rule-parser')!.textContent).toBe('claude-numbered');
    const q = row!.querySelector<HTMLElement>('.tpal-rule-question')!;
    expect(q.textContent).toBe(FIXTURE_RULE.question_preview);
    expect(row!.querySelector('.tpal-rule-choice')!.textContent).toBe('→ I am using this for local development');
    // Trash button still present + accessible.
    expect(row!.querySelector('[data-delete-rule]')).not.toBeNull();
  });

  it('puts the full question in a `title` tooltip so it stays discoverable when the cell line-clamps', async () => {
    loadAllowRulesMock.mockResolvedValueOnce([FIXTURE_RULE]);
    await loadAndRenderTerminalPromptAllowList();
    const q = document.querySelector<HTMLElement>('.tpal-rule-question')!;
    expect(q.getAttribute('title')).toBe(FIXTURE_RULE.question_preview);
  });

  // HS-8106 — choice + created sit inside `.tpal-rule-meta` on the
  // second visual row, with the trash button spanning both rows and
  // visually centered. The CSS does the centering, but the DOM must
  // expose the right structure for the layout to take effect.
  it('renders choice + created inside `.tpal-rule-meta` so they share row 2 (HS-8106)', async () => {
    loadAllowRulesMock.mockResolvedValueOnce([FIXTURE_RULE]);
    await loadAndRenderTerminalPromptAllowList();
    const row = document.querySelector<HTMLElement>('.tpal-rule-row')!;
    const meta = row.querySelector<HTMLElement>('.tpal-rule-meta');
    expect(meta).not.toBeNull();
    expect(meta!.querySelector('.tpal-rule-choice')!.textContent).toBe('→ I am using this for local development');
    // `created` lives inside the same meta strip — not a sibling of
    // `.tpal-rule-question` like the pre-fix layout.
    const createdInMeta = meta!.querySelector('.tpal-rule-created');
    expect(createdInMeta).not.toBeNull();
    const createdAsRowChild = Array.from(row.children).some(c => c.classList.contains('tpal-rule-created'));
    expect(createdAsRowChild).toBe(false);
  });

  it('is keyboard-activatable with role=button + tabIndex=0', async () => {
    loadAllowRulesMock.mockResolvedValueOnce([FIXTURE_RULE]);
    await loadAndRenderTerminalPromptAllowList();
    const row = document.querySelector<HTMLElement>('.tpal-rule-row')!;
    expect(row.getAttribute('role')).toBe('button');
    expect(row.getAttribute('tabindex')).toBe('0');
  });
});

describe('terminalPromptAllowListUI inspector dialog (HS-8072)', () => {
  it('clicking the row opens a read-only inspector with the full question text', async () => {
    loadAllowRulesMock.mockResolvedValueOnce([FIXTURE_RULE]);
    await loadAndRenderTerminalPromptAllowList();
    const row = document.querySelector<HTMLElement>('.tpal-rule-row')!;
    row.click();
    const overlay = document.querySelector<HTMLElement>('.cmd-editor-overlay.tpal-inspector-overlay');
    expect(overlay).not.toBeNull();
    const pre = overlay!.querySelector<HTMLPreElement>('.tpal-inspector-question')!;
    expect(pre.textContent).toBe(FIXTURE_RULE.question_preview);
  });

  it('Enter on a focused row also opens the inspector', async () => {
    loadAllowRulesMock.mockResolvedValueOnce([FIXTURE_RULE]);
    await loadAndRenderTerminalPromptAllowList();
    const row = document.querySelector<HTMLElement>('.tpal-rule-row')!;
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(document.querySelector('.tpal-inspector-overlay')).not.toBeNull();
  });

  it('clicking the trash button does NOT open the inspector (event delegated to the delete handler)', async () => {
    loadAllowRulesMock.mockResolvedValueOnce([FIXTURE_RULE]);
    removeAllowRuleMock.mockResolvedValueOnce(undefined);
    await loadAndRenderTerminalPromptAllowList();
    const trash = document.querySelector<HTMLButtonElement>('[data-delete-rule]')!;
    trash.click();
    expect(document.querySelector('.tpal-inspector-overlay')).toBeNull();
    expect(removeAllowRuleMock).toHaveBeenCalledWith(FIXTURE_RULE.id);
  });

  it('closes on backdrop click, the close button, and Escape', async () => {
    loadAllowRulesMock.mockResolvedValueOnce([FIXTURE_RULE]);
    await loadAndRenderTerminalPromptAllowList();
    const row = document.querySelector<HTMLElement>('.tpal-rule-row')!;

    // Close via X button.
    row.click();
    let overlay = document.querySelector<HTMLElement>('.tpal-inspector-overlay')!;
    overlay.querySelector<HTMLButtonElement>('.cmd-editor-close-btn')!.click();
    expect(document.querySelector('.tpal-inspector-overlay')).toBeNull();

    // Close via footer Close button.
    row.click();
    overlay = document.querySelector<HTMLElement>('.tpal-inspector-overlay')!;
    overlay.querySelector<HTMLButtonElement>('.tpal-inspector-close-btn')!.click();
    expect(document.querySelector('.tpal-inspector-overlay')).toBeNull();

    // Close via backdrop click (target === overlay).
    row.click();
    overlay = document.querySelector<HTMLElement>('.tpal-inspector-overlay')!;
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(document.querySelector('.tpal-inspector-overlay')).toBeNull();

    // Close via Escape.
    row.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(document.querySelector('.tpal-inspector-overlay')).toBeNull();
  });

  it('shows the choice label and creation date in the inspector', async () => {
    loadAllowRulesMock.mockResolvedValueOnce([FIXTURE_RULE]);
    await loadAndRenderTerminalPromptAllowList();
    const row = document.querySelector<HTMLElement>('.tpal-rule-row')!;
    row.click();
    const overlay = document.querySelector<HTMLElement>('.tpal-inspector-overlay')!;
    expect(overlay.textContent).toContain('I am using this for local development');
    // Date format: locale-dependent in `toLocaleDateString`. Just assert
    // the year is present so the test stays stable across platforms.
    expect(overlay.textContent).toContain('2026');
  });

  it('falls back to "(question text not stored …)" when question_preview is missing (rules created before HS-7988)', async () => {
    const legacy: TerminalPromptAllowRule = { ...FIXTURE_RULE, question_preview: undefined };
    loadAllowRulesMock.mockResolvedValueOnce([legacy]);
    await loadAndRenderTerminalPromptAllowList();
    const q = document.querySelector<HTMLElement>('.tpal-rule-question')!;
    expect(q.textContent).toContain('question text not stored');
  });
});
