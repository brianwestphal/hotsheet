import { raw } from '../jsx-runtime.js';
import { toElement } from './dom.js';
import type { GenericMatch,MatchResult, NumberedMatch, YesNoMatch } from './terminalPrompt/parsers.js';
import {
  buildGenericCancelPayload,
  buildGenericPayload,
  buildNumberedCancelPayload,
  buildNumberedPayload,
  buildYesNoCancelPayload,
  buildYesNoPayload,
} from './terminalPrompt/parsers.js';

/**
 * HS-7971 Phase 1 + Phase 2 (HS-7986) — terminal-prompt overlay UI.
 *
 * Per docs/52-terminal-prompt-overlay.md §52.5. Phase 1 ships the
 * `numbered` shape (Claude-Ink style). Phase 2 adds `yesno` (Yes / No
 * buttons) and `generic` (monospaced reproduction + free-form textarea).
 * Always-allow is Phase 3.
 *
 * HS-8012 — the overlay used to mount inside the terminal pane (drawer
 * `.terminal-body` / dashboard `.terminal-dashboard-dedicated-body`),
 * which positioned it visually inside the bottom drawer. Users wanted
 * the overlay to appear in the same location as the channel-permission
 * popup (`.permission-popup`) — anchored below the active project tab —
 * so all "Hot Sheet wants you to answer something" prompts share one
 * spatial convention. Now the overlay mounts on `document.body` with
 * `position: fixed` and is positioned below the project tab whose
 * terminal triggered it (caller passes `projectSecret`); when the tab
 * isn't visible (e.g. dashboard is up and project tabs are hidden) the
 * overlay falls back to the SCSS-default top-center position.
 *
 * Still non-modal — the rest of the app stays interactive while the
 * overlay sits on top. Three dismissal paths:
 *   - Click a choice → `onChoose(payload)` writes the keystroke string to
 *     the PTY via the caller's hook.
 *   - Click "Cancel" / press Escape → cancel-payload (`\x1b`) sent to PTY.
 *   - Click the X / "Not a prompt — let me handle it" → overlay dismissed
 *     without writing anything; detector re-arms on the next user keystroke
 *     into the terminal.
 */

const X_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

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
  /** Called when the overlay closes (any reason). Lets the detector clear
   *  per-instance state. */
  onClose: () => void;
  /** Called when the user clicks "Not a prompt — let me handle it". Tells
   *  the detector to suppress further scans for this terminal until the
   *  user keys into it again. */
  onDismissAsNonPrompt: () => void;
  /**
   * HS-7987 — fired when the user submits a choice WITH the always-allow
   * checkbox ticked. Caller persists the rule (via `appendAllowRule`).
   * The overlay calls this before `onSend` so a successful PATCH lands
   * before we close. Generic-shape overlays never invoke this — generic
   * fallbacks are explicitly NOT allow-listable (see §52.1).
   */
  onAddAllowRule?: (choiceIndex: number, choiceLabel: string) => void;
}

/** Open the overlay. Returns the overlay element so the caller can remove
 *  it programmatically (e.g. on terminal-pane teardown). Idempotent —
 *  calling twice in a row removes any prior overlay first. */
export function openTerminalPromptOverlay(opts: OpenTerminalPromptOverlayOptions): HTMLElement | null {
  // HS-8012 — drop any prior overlay across the whole document so a
  // re-trigger doesn't stack two on top of each other (was scoped to the
  // anchor element pre-fix).
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
 * HS-8012 — mount `overlay` on `document.body` and position it directly
 * below the active project tab matching `projectSecret`. Mirrors
 * `permissionOverlay.tsx`'s positioning math so both popup classes share
 * a spatial convention. When no tab is found (dashboard mode hides
 * project tabs, or the secret doesn't match anything in the DOM) the
 * overlay keeps the SCSS-default `top: 56px; left: 50%;
 * transform: translateX(-50%)` fallback.
 */
function attachOverlayToBody(overlay: HTMLElement, projectSecret: string | undefined): void {
  document.body.appendChild(overlay);
  if (projectSecret === undefined) return;
  const tab = document.querySelector<HTMLElement>(`.project-tab[data-secret="${CSS.escape(projectSecret)}"]`);
  if (tab === null) return;
  const tabRect = tab.getBoundingClientRect();
  if (tabRect.width === 0 && tabRect.height === 0) return; // hidden in dashboard mode
  const popupRect = overlay.getBoundingClientRect();
  const maxLeft = Math.max(8, window.innerWidth - popupRect.width - 8);
  overlay.style.top = `${tabRect.bottom + 4}px`;
  overlay.style.left = `${Math.min(Math.max(8, tabRect.left), maxLeft)}px`;
  // Disable the SCSS-default centering transform when an explicit left
  // position is set so the popup actually lands at `tabRect.left`.
  overlay.style.transform = 'none';
}

/**
 * HS-7987 — render the "Always allow this answer" checkbox row. Only
 * shown for shapes that allow allow-rules (numbered + yesno) AND when the
 * caller provided an `onAddAllowRule` handler. Generic-fallback overlays
 * never get the checkbox — see docs/52 §52.1 for the rationale.
 */
function renderAllowRuleCheckbox(opts: OpenTerminalPromptOverlayOptions) {
  if (opts.onAddAllowRule === undefined) return null;
  if (opts.match.shape === 'generic') return null;
  return (
    <label className="terminal-prompt-overlay-allow-rule-row" title="Skip this prompt automatically next time and answer the same way">
      <input type="checkbox" className="terminal-prompt-overlay-allow-rule" />
      <span>Always allow this answer</span>
    </label>
  );
}

/** Wire the shared header / X-button / Esc-to-cancel / "Not a prompt"
 *  affordances and return helpers the per-shape mounters use to actually
 *  send a payload + close the overlay. */
function wireSharedOverlay(
  overlay: HTMLElement,
  opts: OpenTerminalPromptOverlayOptions,
  cancelPayload: string,
): { close: () => void; send: (payload: string) => void } {
  function close(): void {
    overlay.remove();
    document.removeEventListener('keydown', onKeydown, true);
    opts.onClose();
  }

  function send(payload: string): void {
    const ok = opts.onSend(payload);
    if (!ok) {
      const err = overlay.querySelector<HTMLElement>('.terminal-prompt-overlay-error');
      if (err !== null) {
        err.textContent = 'Terminal disconnected — couldn’t send response. Reconnect and try again.';
        err.style.display = '';
      }
      return;
    }
    close();
  }

  overlay.querySelector<HTMLButtonElement>('.terminal-prompt-overlay-cancel')?.addEventListener('click', () => {
    send(cancelPayload);
  });
  overlay.querySelector<HTMLButtonElement>('.terminal-prompt-overlay-close')?.addEventListener('click', () => {
    close();
  });
  overlay.querySelector<HTMLAnchorElement>('.terminal-prompt-overlay-not-a-prompt')?.addEventListener('click', (e) => {
    e.preventDefault();
    opts.onDismissAsNonPrompt();
    close();
  });

  // Capture-phase Escape sends the shape's cancel payload — beats the
  // global blur-input handler in shortcuts.tsx so Esc here means "send Esc
  // to the PTY", not "blur whatever has focus".
  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    send(cancelPayload);
  }
  document.addEventListener('keydown', onKeydown, true);

  return { close, send };
}

function openNumberedOverlay(opts: OpenTerminalPromptOverlayOptions, match: NumberedMatch): HTMLElement {
  const { question, choices, questionLines } = match;
  // HS-7980 — preserve multi-line question / diff context in a monospaced
  // pre block. Claude's Edit-tool prompts render an inline diff above the
  // numbered choices; collapsing the diff into a single line throws away
  // the structure the user needs to make a decision.
  const hasMultilineContext = questionLines.length > 1
    || (questionLines.length === 1 && questionLines[0].includes('\n'));
  const contextText = questionLines.join('\n');
  const overlay = toElement(
    <div className="terminal-prompt-overlay" role="dialog" aria-modal="false" aria-label={`Terminal prompt: ${question}`}>
      <div className="terminal-prompt-overlay-header">
        <span className="terminal-prompt-overlay-title">{question}</span>
        <button className="terminal-prompt-overlay-close" type="button" title="Close (does not respond)" aria-label="Close">
          {raw(X_ICON)}
        </button>
      </div>
      {hasMultilineContext
        ? <pre className="terminal-prompt-overlay-context">{contextText}</pre>
        : null}
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
      {renderAllowRuleCheckbox(opts)}
      <div className="terminal-prompt-overlay-footer">
        <button className="terminal-prompt-overlay-cancel" type="button">Cancel (Esc)</button>
        <a href="#" className="terminal-prompt-overlay-not-a-prompt">Not a prompt — let me handle it</a>
      </div>
      <p className="terminal-prompt-overlay-error" style="display:none"></p>
    </div>
  );

  const { send } = wireSharedOverlay(overlay, opts, buildNumberedCancelPayload());
  const checkbox = overlay.querySelector<HTMLInputElement>('.terminal-prompt-overlay-allow-rule');

  overlay.querySelectorAll<HTMLButtonElement>('.terminal-prompt-overlay-choice').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.choiceIndex ?? '0', 10);
      const label = btn.dataset.choiceLabel ?? '';
      if (checkbox?.checked === true && opts.onAddAllowRule !== undefined) {
        opts.onAddAllowRule(idx, label);
      }
      send(buildNumberedPayload(choices, idx));
    });
  });

  attachOverlayToBody(overlay, opts.projectSecret);
  return overlay;
}

function openYesNoOverlay(opts: OpenTerminalPromptOverlayOptions, match: YesNoMatch): HTMLElement {
  const { question } = match;
  const overlay = toElement(
    <div className="terminal-prompt-overlay terminal-prompt-overlay-yesno" role="dialog" aria-modal="false" aria-label={`Terminal prompt: ${question}`}>
      <div className="terminal-prompt-overlay-header">
        <span className="terminal-prompt-overlay-title">{question}</span>
        <button className="terminal-prompt-overlay-close" type="button" title="Close (does not respond)" aria-label="Close">
          {raw(X_ICON)}
        </button>
      </div>
      <div className="terminal-prompt-overlay-choices">
        <button className="terminal-prompt-overlay-choice terminal-prompt-overlay-yes" type="button" data-yesno="yes">
          <span className="terminal-prompt-overlay-choice-label">Yes</span>
        </button>
        <button className="terminal-prompt-overlay-choice terminal-prompt-overlay-no" type="button" data-yesno="no">
          <span className="terminal-prompt-overlay-choice-label">No</span>
        </button>
      </div>
      {renderAllowRuleCheckbox(opts)}
      <div className="terminal-prompt-overlay-footer">
        <button className="terminal-prompt-overlay-cancel" type="button">Cancel (Esc)</button>
        <a href="#" className="terminal-prompt-overlay-not-a-prompt">Not a prompt — let me handle it</a>
      </div>
      <p className="terminal-prompt-overlay-error" style="display:none"></p>
    </div>
  );

  const { send } = wireSharedOverlay(overlay, opts, buildYesNoCancelPayload());
  const checkbox = overlay.querySelector<HTMLInputElement>('.terminal-prompt-overlay-allow-rule');

  overlay.querySelectorAll<HTMLButtonElement>('[data-yesno]').forEach(btn => {
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

  attachOverlayToBody(overlay, opts.projectSecret);
  return overlay;
}

function openGenericOverlay(opts: OpenTerminalPromptOverlayOptions, match: GenericMatch): HTMLElement {
  const { question, rawText } = match;
  const overlay = toElement(
    <div className="terminal-prompt-overlay terminal-prompt-overlay-generic" role="dialog" aria-modal="false" aria-label={`Terminal prompt: ${question}`}>
      <div className="terminal-prompt-overlay-header">
        <span className="terminal-prompt-overlay-title">{question}</span>
        <button className="terminal-prompt-overlay-close" type="button" title="Close (does not respond)" aria-label="Close">
          {raw(X_ICON)}
        </button>
      </div>
      <pre className="terminal-prompt-overlay-context terminal-prompt-overlay-generic-context">{rawText}</pre>
      <textarea
        className="terminal-prompt-overlay-generic-input"
        placeholder="Type your response here…"
        rows={2}
        spellcheck={false}
      ></textarea>
      <div className="terminal-prompt-overlay-footer terminal-prompt-overlay-generic-footer">
        <button className="terminal-prompt-overlay-cancel" type="button">Cancel (Esc)</button>
        <button className="terminal-prompt-overlay-generic-submit" type="button">Send (Enter)</button>
        <a href="#" className="terminal-prompt-overlay-not-a-prompt">Not a prompt — let me handle it</a>
      </div>
      <p className="terminal-prompt-overlay-error" style="display:none"></p>
    </div>
  );

  const { send } = wireSharedOverlay(overlay, opts, buildGenericCancelPayload());

  const textarea = overlay.querySelector<HTMLTextAreaElement>('.terminal-prompt-overlay-generic-input');
  const submit = overlay.querySelector<HTMLButtonElement>('.terminal-prompt-overlay-generic-submit');

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

  attachOverlayToBody(overlay, opts.projectSecret);
  // Focus the textarea so the user can start typing immediately.
  queueMicrotask(() => { textarea?.focus(); });
  return overlay;
}
