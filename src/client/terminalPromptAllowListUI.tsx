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
    <div className={`terminal-prompt-allow-rule-wrapper${enabled ? '' : ' is-disabled'}`}></div>
  );
  for (const rule of rules) wrapper.appendChild(buildRuleRow(rule));
  host.replaceChildren(wrapper);
  wrapper.querySelectorAll<HTMLButtonElement>('[data-delete-rule]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.deleteRule!;
      btn.disabled = true;
      try { await removeAllowRule(id); }
      catch { btn.disabled = false; }
    });
  });
}

function buildRuleRow(rule: TerminalPromptAllowRule) {
  // HS-8072 — pre-fix the row was a single-line grid that clipped the
  // question preview to the first character or two ("W..." in the user's
  // screenshot). The question is the most important field on the row —
  // it's what the user uses to recognise the rule — so we let it wrap to
  // up to two lines and make the row clickable to open a read-only
  // inspector dialog with the full question + tool + choice + creation
  // date. Editing isn't applicable: rules match by `question_hash`, so
  // mutating the question would un-match every prompt the rule was
  // recorded against (cf. permission-allow-rules in §47.4 which DO
  // support edit).
  const created = formatCreatedAt(rule.created_at);
  const choice = rule.choice_label ?? `choice ${rule.choice_index + 1}`;
  const question = rule.question_preview ?? '(question text not stored — created before HS-7988)';
  const row = toElement(
    <div className="permission-allow-row tpal-rule-row" data-rule-id={rule.id} role="button" tabIndex={0}>
      <div className="permission-allow-tool tpal-rule-parser">{rule.parser_id}</div>
      <div className="tpal-rule-question" title={question}>{question}</div>
      <div className="tpal-rule-choice">{`→ ${choice}`}</div>
      <div className="tpal-rule-created">{created}</div>
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
  const openInspector = (): void => { showRuleInspector(rule); };
  row.addEventListener('click', (e) => {
    // Don't open the inspector when the click landed on the trash button
    // — that has its own handler attached in `render`.
    const targetEl = e.target as HTMLElement | null;
    if (targetEl !== null && targetEl.closest('[data-delete-rule]') !== null) return;
    openInspector();
  });
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openInspector();
    }
  });
  return row;
}

/**
 * HS-8072 — read-only inspector dialog. Shows the rule's tool, full
 * question text (no wrapping limit), chosen option, and creation
 * timestamp. No edit affordance — rules are immutable once recorded
 * because their `question_hash` key is derived from the prompt text.
 */
function showRuleInspector(rule: TerminalPromptAllowRule): void {
  document.querySelectorAll('.cmd-editor-overlay.tpal-inspector-overlay').forEach(el => el.remove());
  const created = formatCreatedAt(rule.created_at);
  const choice = rule.choice_label ?? `choice ${rule.choice_index + 1}`;
  const question = rule.question_preview ?? '(question text not stored — created before HS-7988)';
  const overlay = toElement(
    <div className="cmd-editor-overlay tpal-inspector-overlay">
      <div className="cmd-editor-dialog">
        <div className="cmd-editor-dialog-header">
          <span>Terminal-prompt allow rule</span>
          <button className="cmd-editor-close-btn" title="Close" type="button">{'×'}</button>
        </div>
        <div className="cmd-editor-dialog-body">
          <div className="settings-field">
            <label>Parser</label>
            <code className="tpal-inspector-value">{rule.parser_id}</code>
          </div>
          <div className="settings-field">
            <label>Question</label>
            <pre className="tpal-inspector-question">{question}</pre>
          </div>
          <div className="settings-field">
            <label>Auto-response</label>
            <div className="tpal-inspector-value">{choice}</div>
          </div>
          {created !== ''
            ? <div className="settings-field">
                <label>Created</label>
                <div className="tpal-inspector-value">{created}</div>
              </div>
            : null}
        </div>
        <div className="cmd-editor-dialog-footer">
          <button className="btn btn-sm tpal-inspector-close-btn" type="button">Close</button>
        </div>
      </div>
    </div>
  );
  const close = (): void => { overlay.remove(); };
  overlay.querySelector<HTMLButtonElement>('.cmd-editor-close-btn')!.addEventListener('click', close);
  overlay.querySelector<HTMLButtonElement>('.tpal-inspector-close-btn')!.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  };
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
}

function formatCreatedAt(iso: string): string {
  if (iso === '') return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return ''; }
}
