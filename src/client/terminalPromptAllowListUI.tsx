/**
 * HS-7988 (§52 Phase 4) — Settings → Permissions sub-section that lists
 * terminal-prompt allow rules with a delete affordance.
 *
 * Rules are added from the §52 overlay's "Always allow this answer"
 * checkbox, not here — the management UI is review-and-cleanup only.
 * Mirrors the pattern in `permissionAllowListUI.tsx` (§47.4).
 */
import { raw } from '../jsx-runtime.js';
import type { TerminalPromptAllowRule } from '../shared/terminalPrompt/allowRules.js';
import { toElement } from './dom.js';
import { state } from './state.js';
import {
  loadAllowRules,
  removeAllowRule,
  subscribeToAllowRules,
} from './terminalPrompt/allowRulesStore.js';

const TRASH_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

let subscribed = false;

/** Top-level renderer — lazy-imported by `settingsDialog.tsx` when the
 *  Permissions tab is first activated. */
export async function loadAndRenderTerminalPromptAllowList(): Promise<void> {
  if (!subscribed) {
    subscribed = true;
    subscribeToAllowRules(rules => render(rules));
  }
  const rules = await loadAllowRules();
  render(rules);
}

function render(rules: readonly TerminalPromptAllowRule[]): void {
  const host = document.getElementById('terminal-prompt-allow-list');
  if (host === null) return;
  // Pure rendering — preserves the focus-disable affordance from the master
  // toggle by adding a `is-disabled` class when detection is off. List
  // remains visible (per spec — users want to see what they have configured)
  // but interactions are dimmed to reflect the inert state.
  const enabled = state.settings.terminal_prompt_detection_enabled;
  if (rules.length === 0) {
    host.replaceChildren(toElement(
      <div className="permission-allow-empty">No terminal-prompt allow rules configured. Click "Always allow this answer" on the overlay when responding to a prompt to add one.</div>
    ));
    return;
  }
  const wrapper = toElement(
    <div className={`terminal-prompt-allow-rule-wrapper${enabled ? '' : ' is-disabled'}`}>
      {rules.map(rule => buildRuleRow(rule))}
    </div>
  );
  host.replaceChildren(wrapper);
  wrapper.querySelectorAll<HTMLButtonElement>('[data-delete-rule]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.deleteRule!;
      btn.disabled = true;
      try { await removeAllowRule(id); }
      catch { btn.disabled = false; }
    });
  });
}

function buildRuleRow(rule: TerminalPromptAllowRule) {
  const created = formatCreatedAt(rule.created_at);
  const choice = rule.choice_label ?? `choice ${rule.choice_index + 1}`;
  const question = rule.question_preview ?? '(question text not stored — created before HS-7988)';
  const meta = `→ ${choice}${created !== '' ? ` · ${created}` : ''}`;
  return (
    <div className="permission-allow-row">
      <div className="permission-allow-tool">{rule.parser_id}</div>
      <div className="permission-allow-pattern" title={question}>{question}</div>
      <div className="permission-allow-meta">{meta}</div>
      <button
        className="permission-allow-delete btn btn-sm"
        type="button"
        title="Delete this rule"
        aria-label="Delete rule"
        data-delete-rule={rule.id}
      >
        {raw(TRASH_ICON)}
      </button>
    </div>
  );
}

function formatCreatedAt(iso: string): string {
  if (iso === '') return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return ''; }
}
