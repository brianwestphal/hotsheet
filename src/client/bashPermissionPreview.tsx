import { api } from './api.js';
import { toElement } from './dom.js';
import { type AllowRule, newRuleId, parseRules, regexEscape } from './permissionAllowListUI.js';

/**
 * HS-8299 — Bash-tool permission popup body + actions.
 *
 * Replaces the §47 generic flat-JSON / live-terminal-checkout body for any
 * `Bash` tool permission with a tool-specific layout:
 *
 *   1. Title (in the dialog shell): "Allow Claude to run"
 *   2. Body: a scrollable monospaced `<pre>` of the exact command Claude
 *      wants to run.
 *   3. Actions: three vertically-stacked buttons —
 *      - "Yes" (primary): allow this single request only
 *      - "Yes, and allow this command and similar in the future":
 *        creates a `Bash(<command>)` always-allow rule (mirrors the
 *        existing §47.4 always-allow path, just exposed as a button
 *        instead of a checkbox link), then allows the current request
 *      - "No": deny
 *
 * Locked decisions per the user's HS-8299 feedback:
 * - `<pre>` with `overflow-y: auto` (NOT a syntax-highlighted block, NOT
 *   an embedded xterm preview).
 * - Buttons stacked vertically.
 * - No additional header beyond "Allow Claude to run" — `toolChip` is
 *   suppressed for Bash so the dialog header reads as just the title.
 * - Live-terminal checkout is SKIPPED entirely for Bash (the pre-fix
 *   `useLiveCheckout` heuristic for long pipelines no longer fires for
 *   this tool — confirmed answer "a" to Q1 of the FEEDBACK NEEDED note).
 */

export interface BashPermissionPreviewParts {
  bodyElement: HTMLElement;
  actionsElement: HTMLElement;
}

export interface BashPermissionPreviewOptions {
  /** The exact Bash command Claude wants to run (extracted from
   *  `perm.input_preview` via `extractPrimaryValue`). Rendered verbatim
   *  inside the body `<pre>`. */
  command: string;
  /** Fires when the user clicks "Yes". Caller invokes its existing
   *  allow-the-current-request logic. */
  onAllow: () => void;
  /** Fires when the user clicks the middle "Yes, and allow ..." button.
   *  Caller invokes its existing allow-the-current-request logic AFTER
   *  the rule has been persisted. The persistence happens inside this
   *  module; the caller's `onAllow` runs unconditionally on success.
   *  When the persistence fails, an inline error is shown and the
   *  caller's `onAllow` is NOT invoked (so the user can retry / pick a
   *  different choice). */
  onAllowAlways: () => void;
  /** Fires when the user clicks "No". Caller invokes its existing
   *  deny-the-current-request logic. */
  onDeny: () => void;
}

export function buildBashPermissionPreview(opts: BashPermissionPreviewOptions): BashPermissionPreviewParts {
  const bodyElement = toElement(
    <pre className="permission-bash-command">{opts.command}</pre>
  );

  const actionsElement = toElement(
    <div className="permission-popup-actions permission-popup-actions-stacked">
      <button className="btn btn-primary permission-popup-allow" type="button">Yes</button>
      <button className="btn permission-popup-allow-always" type="button">Yes, and allow this command and similar in the future</button>
      <button className="btn permission-popup-deny" type="button">No</button>
      <p className="permission-popup-allow-always-error" style="display:none;color:#991b1b;font-size:11px;margin:6px 0 0">Failed to save rule</p>
    </div>
  );

  const allowBtn = actionsElement.querySelector<HTMLButtonElement>('.permission-popup-allow')!;
  const allowAlwaysBtn = actionsElement.querySelector<HTMLButtonElement>('.permission-popup-allow-always')!;
  const denyBtn = actionsElement.querySelector<HTMLButtonElement>('.permission-popup-deny')!;
  const errorEl = actionsElement.querySelector<HTMLElement>('.permission-popup-allow-always-error')!;

  allowBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    opts.onAllow();
  });

  denyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    opts.onDeny();
  });

  allowAlwaysBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (allowAlwaysBtn.disabled) return;
    allowAlwaysBtn.disabled = true;
    void persistBashAlwaysAllowRule(opts.command).then(
      () => {
        opts.onAllowAlways();
      },
      () => {
        allowAlwaysBtn.disabled = false;
        errorEl.style.display = '';
      },
    );
  });

  return { bodyElement, actionsElement };
}

/**
 * Persist a `Bash(<command>)` always-allow rule using the same `^…$`
 * auto-anchor pattern the §47.4 affordance uses. Mirrors
 * `permissionAllowListUI.tsx::saveRuleAndCommit` minus the form-error UI
 * (the caller owns its own error handling).
 */
async function persistBashAlwaysAllowRule(command: string): Promise<void> {
  const pattern = `^${regexEscape(command)}$`;
  const fs = await api<{ permission_allow_rules?: unknown }>('/file-settings');
  const existing = parseRules(fs.permission_allow_rules);
  const rule: AllowRule = {
    id: newRuleId(),
    tool: 'Bash',
    pattern,
    added_at: new Date().toISOString(),
    added_by: 'overlay',
  };
  await api('/file-settings', {
    method: 'PATCH',
    body: { permission_allow_rules: [...existing, rule] },
  });
}
