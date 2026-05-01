import type { GenericMatch,MatchResult, NumberedMatch, YesNoMatch } from '../shared/terminalPrompt/parsers.js';
import {
  buildGenericCancelPayload,
  buildGenericPayload,
  buildNumberedCancelPayload,
  buildNumberedPayload,
  buildYesNoCancelPayload,
  buildYesNoPayload,
  isDecorativeLine,
} from '../shared/terminalPrompt/parsers.js';
import { toElement } from './dom.js';
import { openPermissionDialogShell, type PermissionDialogShellHandle } from './permissionDialogShell.js';

/**
 * HS-7971 Phase 1 + Phase 2 (HS-7986) — terminal-prompt overlay UI.
 *
 * Per docs/52-terminal-prompt-overlay.md §52.5. Phase 1 ships the
 * `numbered` shape (Claude-Ink style). Phase 2 adds `yesno` (Yes / No
 * buttons) and `generic` (monospaced reproduction + free-form textarea).
 * Always-allow is Phase 3.
 *
 * HS-8012 — overlay anchored below the active project tab so all
 * "Hot Sheet wants you to answer something" prompts share one spatial
 * convention with §47's `.permission-popup`.
 *
 * HS-8066 / HS-8069 — chrome (header / anchor positioning / footer
 * link row / close X) is now owned by `permissionDialogShell.tsx`. The
 * three shape mounters here just build their per-shape body / actions /
 * always-affordance DOM trees and pass them as slots to
 * `openPermissionDialogShell`. Per-shape Esc-to-cancel-payload (sends a
 * real `\x1b` to the PTY) stays here because the shell can't subsume
 * that semantic.
 *
 * Still non-modal — the rest of the app stays interactive while the
 * overlay sits on top. Three dismissal paths:
 *   - Click a choice → `onChoose(payload)` writes the keystroke string to
 *     the PTY via the caller's hook.
 *   - Click "Cancel" / press Escape → cancel-payload (`\x1b`) sent to PTY.
 *   - Click the X / `Minimize` / `No response needed` → overlay dismissed
 *     without writing anything; routed through `onClose` /
 *     `onMinimize` / `onNoResponseNeeded` callbacks.
 */

export interface OpenTerminalPromptOverlayOptions {
  /** The match the parser registry returned. Phase 1 only renders the
   *  `numbered` shape; other shapes are no-ops. */
  match: MatchResult;
  /** HS-8012 — secret of the project whose terminal raised the prompt.
   *  Used to find that project's tab via `.project-tab[data-secret=...]`
   *  and anchor the overlay below it (mirroring `permission-popup`).
   *  Optional — when absent or the tab isn't in the DOM the overlay
   *  falls back to its SCSS-default top-center position. */
  projectSecret?: string;
  /**
   * Caller hook — writes the keystroke string to the PTY's WebSocket.
   * Phase 1 calls this with either the `buildNumberedPayload` result for a
   * chosen option or `buildNumberedCancelPayload()` for cancel. Returning
   * false signals "WebSocket dropped — keep the overlay open and surface
   * the error inline".
   */
  onSend: (payload: string) => boolean;
  /** Called when the overlay closes via send / cancel / X-close (active
   *  user dismissal). Lets the dispatcher clear per-instance state and
   *  post `/terminal/prompt-dismiss` to clear the server-side pending
   *  entry. Minimize and "No response needed" do NOT trigger this hook —
   *  they have their own callbacks (`onMinimize` / `onNoResponseNeeded`)
   *  with different server-side semantics. */
  onClose: () => void;
  /**
   * HS-7987 — fired when the user submits a choice WITH the always-allow
   * checkbox ticked. Caller persists the rule (via `appendAllowRule`).
   * The overlay calls this before `onSend` so a successful PATCH lands
   * before we close. Generic-shape overlays never invoke this — generic
   * fallbacks are explicitly NOT allow-listable (see §52.1).
   */
  onAddAllowRule?: (choiceIndex: number, choiceLabel: string) => void;
  /**
   * HS-8067 — when provided, renders a `Minimize` link in the footer.
   * Click hides the overlay client-side, leaves the server-side pending
   * entry alive (so the project tab keeps its bell dot), and lets the
   * caller (`bellPoll.tsx`) wire a tab-click → re-open path.
   */
  onMinimize?: () => void;
  /**
   * HS-8067 — when provided, renders a `No response needed` link in the
   * footer. Click hides the overlay client-side; the user is saying
   * "I'll handle this in the terminal directly".
   */
  onNoResponseNeeded?: () => void;
}

/** Open the overlay. Returns the overlay element so the caller can remove
 *  it programmatically (e.g. on terminal-pane teardown). Idempotent —
 *  calling twice in a row removes any prior overlay first. */
export function openTerminalPromptOverlay(opts: OpenTerminalPromptOverlayOptions): HTMLElement | null {
  // HS-8012 — drop any prior overlay across the whole document so a
  // re-trigger doesn't stack two on top of each other.
  document.querySelectorAll('.terminal-prompt-overlay').forEach(el => el.remove());

  switch (opts.match.shape) {
    case 'numbered':
      return openNumberedOverlay(opts, opts.match);
    case 'yesno':
      return openYesNoOverlay(opts, opts.match);
    case 'generic':
      return openGenericOverlay(opts, opts.match);
  }
}

/**
 * HS-8068 — derive a human-readable source label from the match's
 * `parser_id`, mirroring `permissionOverlay.tsx`'s tool-name chip
 * (`Bash`, `Edit`, `Write`, etc.) so both overlays read the same way at
 * a glance. Returns `null` for `generic` matches — those are
 * heuristic-fired fallbacks and don't have a meaningful source name to
 * show; chip is hidden in that case.
 *
 * Exported for the unit test.
 */
export function sourceLabelForMatch(match: MatchResult): string | null {
  if (match.shape === 'generic') return null;
  if (match.parserId === 'claude-numbered') return 'Claude';
  if (match.parserId === 'yesno') return 'Shell';
  // Defensive — unknown parser ids surface as the raw id rather than
  // hiding the chip, so a misconfiguration is visible in QA.
  return match.parserId;
}

/**
 * HS-8037 — strip the title-line (already shown in the overlay header) and
 * any pure-decoration rows (box-drawing borders / horizontal rules from
 * Claude's TUI frame) out of `questionLines` before they're joined into
 * the framed `<pre>` context block. Pre-fix the same content rendered
 * twice — once joined into the title and once verbatim in the context —
 * which the user explicitly flagged as "redundantly shows … with a bunch
 * of horizontal lines before it" on HS-8037. Also strips leading +
 * trailing blank lines that fall out once the title / decoration is
 * gone, so the framed block doesn't render with empty whitespace at the
 * top or bottom.
 */
function stripContextLines(lines: readonly string[], title: string): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t === title) continue;
    if (isDecorativeLine(line)) continue;
    out.push(line);
  }
  while (out.length > 0 && out[0].trim() === '') out.shift();
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return out;
}

/**
 * HS-7987 — render the "Always choose this" checkbox row. Only
 * shown for shapes that allow allow-rules (numbered + yesno) AND when the
 * caller provided an `onAddAllowRule` handler.
 */
function buildAllowRuleCheckbox(opts: OpenTerminalPromptOverlayOptions): HTMLElement | null {
  if (opts.onAddAllowRule === undefined) return null;
  if (opts.match.shape === 'generic') return null;
  return toElement(
    <label className="terminal-prompt-overlay-allow-rule-row" title="Skip this prompt automatically next time and pick the same option">
      <input type="checkbox" className="terminal-prompt-overlay-allow-rule" />
      <span>Always choose this</span>
    </label>
  );
}

/**
 * HS-8069 — shared mounter that wires each shape's body / actions /
 * affordance DOM into the dialog shell, plus the per-shape Esc-to-
 * cancel-payload handler that the shell can't subsume (the consumer
 * needs to send a real `\x1b` byte to the PTY before the overlay
 * closes). Returns the shell handle so the per-shape mounter can wire
 * choice-button click handlers onto the live overlay.
 */
function mountShellWithEsc(
  opts: OpenTerminalPromptOverlayOptions,
  bodyElement: HTMLElement | undefined,
  actions: HTMLElement,
  alwaysAffordance: HTMLElement | null,
  cancelPayload: string,
): { handle: PermissionDialogShellHandle; send: (payload: string) => void } {
  let escHandler: ((e: KeyboardEvent) => void) | null = null;
  function disposeEsc(): void {
    if (escHandler !== null) document.removeEventListener('keydown', escHandler, true);
    escHandler = null;
  }

  const handle = openPermissionDialogShell({
    rootClassName: 'terminal-prompt-overlay',
    ariaLabel: `Terminal prompt: ${opts.match.question}`,
    toolChip: sourceLabelForMatch(opts.match) ?? undefined,
    title: opts.match.question,
    bodyElement,
    actions,
    alwaysAffordance,
    onClose: () => { disposeEsc(); opts.onClose(); },
    onMinimize: opts.onMinimize !== undefined ? (() => { disposeEsc(); opts.onMinimize!(); }) : undefined,
    onNoResponseNeeded: opts.onNoResponseNeeded !== undefined ? (() => { disposeEsc(); opts.onNoResponseNeeded!(); }) : undefined,
    projectSecret: opts.projectSecret,
  });

  function send(payload: string): void {
    const ok = opts.onSend(payload);
    if (!ok) {
      const err = handle.overlay.querySelector<HTMLElement>('.terminal-prompt-overlay-error');
      if (err !== null) {
        err.textContent = 'Terminal disconnected — couldn’t send response. Reconnect and try again.';
        err.style.display = '';
      }
      return;
    }
    handle.close();
  }

  // Cancel button (lives inside the consumer-supplied `actions` DOM).
  handle.overlay.querySelector<HTMLButtonElement>('.terminal-prompt-overlay-cancel')?.addEventListener('click', () => {
    send(cancelPayload);
  });

  // Capture-phase Escape sends the shape's cancel payload — beats the
  // global blur-input handler in shortcuts.tsx so Esc here means "send
  // Esc to the PTY", not "blur whatever has focus".
  escHandler = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    send(cancelPayload);
  };
  document.addEventListener('keydown', escHandler, true);

  return { handle, send };
}

function openNumberedOverlay(opts: OpenTerminalPromptOverlayOptions, match: NumberedMatch): HTMLElement {
  const { question, choices, questionLines } = match;
  // HS-7980 — preserve multi-line question / diff context in a monospaced
  // pre block. Claude's Edit-tool prompts render an inline diff above the
  // numbered choices; collapsing the diff into a single line throws away
  // the structure the user needs to make a decision.
  // HS-8037 — but DON'T include the line that the parser already promoted
  // into the title bar (`question`), and skip pure-decoration rows.
  const contextLines = stripContextLines(questionLines, question);
  const hasMultilineContext = contextLines.length > 0;
  const contextText = contextLines.join('\n');

  const bodyElement = hasMultilineContext
    ? toElement(<pre className="terminal-prompt-overlay-context">{contextText}</pre>)
    : undefined;

  const actions = toElement(
    <div className="terminal-prompt-overlay-actions">
      <div className="terminal-prompt-overlay-choices">
        {choices.map(c => (
          <button
            className={`terminal-prompt-overlay-choice${c.highlighted ? ' is-highlighted' : ''}`}
            type="button"
            data-choice-index={String(c.index)}
            data-choice-label={c.label}
          >
            <span className="terminal-prompt-overlay-choice-num">{`${c.index + 1}.`}</span>
            <span className="terminal-prompt-overlay-choice-label">{c.label}</span>
          </button>
        ))}
      </div>
      <div className="terminal-prompt-overlay-footer">
        <button className="terminal-prompt-overlay-cancel" type="button">Cancel (Esc)</button>
      </div>
      <p className="terminal-prompt-overlay-error" style="display:none"></p>
    </div>
  );

  const alwaysAffordance = buildAllowRuleCheckbox(opts);

  const { handle, send } = mountShellWithEsc(opts, bodyElement, actions, alwaysAffordance, buildNumberedCancelPayload());

  const checkbox = handle.overlay.querySelector<HTMLInputElement>('.terminal-prompt-overlay-allow-rule');
  handle.overlay.querySelectorAll<HTMLButtonElement>('.terminal-prompt-overlay-choice').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.choiceIndex ?? '0', 10);
      const label = btn.dataset.choiceLabel ?? '';
      if (checkbox?.checked === true && opts.onAddAllowRule !== undefined) {
        opts.onAddAllowRule(idx, label);
      }
      send(buildNumberedPayload(choices, idx));
    });
  });

  return handle.overlay;
}

function openYesNoOverlay(opts: OpenTerminalPromptOverlayOptions, match: YesNoMatch): HTMLElement {
  const actions = toElement(
    <div className="terminal-prompt-overlay-actions terminal-prompt-overlay-yesno">
      <div className="terminal-prompt-overlay-choices">
        <button className="terminal-prompt-overlay-choice terminal-prompt-overlay-yes" type="button" data-yesno="yes">
          <span className="terminal-prompt-overlay-choice-label">Yes</span>
        </button>
        <button className="terminal-prompt-overlay-choice terminal-prompt-overlay-no" type="button" data-yesno="no">
          <span className="terminal-prompt-overlay-choice-label">No</span>
        </button>
      </div>
      <div className="terminal-prompt-overlay-footer">
        <button className="terminal-prompt-overlay-cancel" type="button">Cancel (Esc)</button>
      </div>
      <p className="terminal-prompt-overlay-error" style="display:none"></p>
    </div>
  );

  const alwaysAffordance = buildAllowRuleCheckbox(opts);

  const { handle, send } = mountShellWithEsc(opts, undefined, actions, alwaysAffordance, buildYesNoCancelPayload());

  const checkbox = handle.overlay.querySelector<HTMLInputElement>('.terminal-prompt-overlay-allow-rule');
  handle.overlay.querySelectorAll<HTMLButtonElement>('[data-yesno]').forEach(btn => {
    btn.addEventListener('click', () => {
      const choice = btn.dataset.yesno === 'yes' ? 'yes' : 'no';
      const label = choice === 'yes' ? 'Yes' : 'No';
      const choiceIndex = choice === 'yes' ? 0 : 1;
      if (checkbox?.checked === true && opts.onAddAllowRule !== undefined) {
        opts.onAddAllowRule(choiceIndex, label);
      }
      send(buildYesNoPayload(match, choice));
    });
  });

  return handle.overlay;
}

function openGenericOverlay(opts: OpenTerminalPromptOverlayOptions, match: GenericMatch): HTMLElement {
  const { rawText } = match;

  // HS-8069 — generic shape's body holds both the rawText reproduction
  // AND the free-form textarea (the textarea isn't an "action" in the
  // shell's sense — it's part of the prompt content). Submit + Cancel
  // go in the actions slot.
  const bodyElement = toElement(
    <div>
      <pre className="terminal-prompt-overlay-context terminal-prompt-overlay-generic-context">{rawText}</pre>
      <textarea
        className="terminal-prompt-overlay-generic-input"
        placeholder="Type your response here…"
        rows={2}
        spellcheck={false}
      ></textarea>
    </div>
  );

  const actions = toElement(
    <div className="terminal-prompt-overlay-actions terminal-prompt-overlay-generic">
      <div className="terminal-prompt-overlay-footer terminal-prompt-overlay-generic-footer">
        <button className="terminal-prompt-overlay-cancel" type="button">Cancel (Esc)</button>
        <button className="terminal-prompt-overlay-generic-submit" type="button">Send (Enter)</button>
      </div>
      <p className="terminal-prompt-overlay-error" style="display:none"></p>
    </div>
  );

  const { handle, send } = mountShellWithEsc(opts, bodyElement, actions, null, buildGenericCancelPayload());

  const textarea = handle.overlay.querySelector<HTMLTextAreaElement>('.terminal-prompt-overlay-generic-input');
  const submit = handle.overlay.querySelector<HTMLButtonElement>('.terminal-prompt-overlay-generic-submit');

  function doSubmit(): void {
    const text = textarea?.value ?? '';
    send(buildGenericPayload(text));
  }

  submit?.addEventListener('click', doSubmit);

  // Enter inside the textarea submits; Shift+Enter inserts a newline.
  textarea?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSubmit();
    }
  });

  // Focus the textarea so the user can start typing immediately.
  queueMicrotask(() => { textarea?.focus(); });
  return handle.overlay;
}
