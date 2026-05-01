import { raw } from '../jsx-runtime.js';
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
   * caller (`bellPoll.tsx`) wire a tab-click → re-open path. Mirrors
   * §47's `permissionOverlay::cleanupAndMinimize`. Caller is responsible
   * for the 2-min auto-dismiss timer and the bell-state bookkeeping —
   * the overlay just fires this callback and tears down its DOM.
   */
  onMinimize?: () => void;
  /**
   * HS-8067 — when provided, renders a `No response needed` link in the
   * footer. Click hides the overlay client-side; semantically the user
   * is saying "I'll handle this in the terminal directly, don't keep
   * showing me the overlay". Mirrors §47's
   * `permissionOverlay::cleanupAndDismiss`. Caller decides whether to
   * post `/terminal/prompt-dismiss` server-side or just track the
   * dismissal in client-side state.
   */
  onNoResponseNeeded?: () => void;
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
 * caller provided an `onAddAllowRule` handler. Generic-fallback overlays
 * never get the checkbox — see docs/52 §52.1 for the rationale.
 *
 * HS-8024 — label was "Always allow this answer" originally; the wording
 * read as confusing in user testing (allow what — the prompt? the
 * answer? the underlying tool?). Renamed to "Always choose this" so
 * the action and the saved scope are obvious: "the next time I see this
 * prompt, choose the same option I'm picking now."
 */
function renderAllowRuleCheckbox(opts: OpenTerminalPromptOverlayOptions) {
  if (opts.onAddAllowRule === undefined) return null;
  if (opts.match.shape === 'generic') return null;
  return (
    <label className="terminal-prompt-overlay-allow-rule-row" title="Skip this prompt automatically next time and pick the same option">
      <input type="checkbox" className="terminal-prompt-overlay-allow-rule" />
      <span>Always choose this</span>
    </label>
  );
}

/** Wire the shared header / X-button / Esc-to-cancel affordances and
 *  return helpers the per-shape mounters use to actually send a payload
 *  + close the overlay. HS-8025 removed the "Not a prompt — let me
 *  handle it" link; the cancel button (sends a real cancel payload to
 *  the PTY) covers the same use case more cleanly.
 *
 *  HS-8067 — added Minimize and "No response needed" link wiring.
 *  Both bypass `onClose` (which posts `/terminal/prompt-dismiss`) and
 *  fire dedicated callbacks instead, since their server-side semantics
 *  differ from active dismissal. */
function wireSharedOverlay(
  overlay: HTMLElement,
  opts: OpenTerminalPromptOverlayOptions,
  cancelPayload: string,
): { close: () => void; send: (payload: string) => void } {
  function tearDownDom(): void {
    overlay.remove();
    document.removeEventListener('keydown', onKeydown, true);
  }

  function close(): void {
    tearDownDom();
    opts.onClose();
  }

  function minimize(): void {
    tearDownDom();
    opts.onMinimize?.();
  }

  function dismissNoResponse(): void {
    tearDownDom();
    opts.onNoResponseNeeded?.();
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
  // HS-8067 — Minimize / No response needed links. Only present when the
  // caller provided the corresponding callback; bare overlays (no
  // dispatcher integration) hide them.
  overlay.querySelector<HTMLAnchorElement>('.terminal-prompt-overlay-minimize-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    minimize();
  });
  overlay.querySelector<HTMLAnchorElement>('.terminal-prompt-overlay-dismiss-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    dismissNoResponse();
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

/**
 * HS-8067 — render the Minimize / No-response-needed link row when at
 * least one of the corresponding callbacks is provided. Mirrors §47's
 * `.permission-popup-links` block. Returns `null` when neither callback
 * is set, so bare overlays (without dispatcher integration) don't grow
 * empty footer chrome.
 */
function renderFooterLinks(opts: OpenTerminalPromptOverlayOptions) {
  const showMinimize = opts.onMinimize !== undefined;
  const showDismiss = opts.onNoResponseNeeded !== undefined;
  if (!showMinimize && !showDismiss) return null;
  return (
    <div className="terminal-prompt-overlay-links">
      {showMinimize
        ? <a className="terminal-prompt-overlay-minimize-link" href="#">Minimize</a>
        : null}
      {showMinimize && showDismiss
        ? <span className="terminal-prompt-overlay-links-sep">·</span>
        : null}
      {showDismiss
        ? <a className="terminal-prompt-overlay-dismiss-link" href="#">No response needed</a>
        : null}
    </div>
  );
}

function openNumberedOverlay(opts: OpenTerminalPromptOverlayOptions, match: NumberedMatch): HTMLElement {
  const { question, choices, questionLines } = match;
  // HS-7980 — preserve multi-line question / diff context in a monospaced
  // pre block. Claude's Edit-tool prompts render an inline diff above the
  // numbered choices; collapsing the diff into a single line throws away
  // the structure the user needs to make a decision.
  // HS-8037 — but DON'T include the line that the parser already promoted
  // into the title bar (`question`), and skip pure-decoration rows (box-
  // drawing borders / horizontal rules captured from Claude's TUI frame).
  // Pre-fix the title and the framed context redundantly carried the same
  // content — the user saw the same warning paragraph twice.
  const contextLines = stripContextLines(questionLines, question);
  // HS-8037 — render the framed `<pre>` block whenever there's ANY body
  // content left after stripping the title + pure-decoration rows.
  // Pre-HS-8037 the gate was `length > 1` (matching the old "is the
  // question multi-line?" test), but that conflated raw line count with
  // meaningful content — a heading + one body line collapsed to a single
  // post-strip line and was silently dropped from the overlay.
  const hasMultilineContext = contextLines.length > 0;
  const contextText = contextLines.join('\n');
  const sourceLabel = sourceLabelForMatch(match);
  const overlay = toElement(
    <div className="terminal-prompt-overlay" role="dialog" aria-modal="false" aria-label={`Terminal prompt: ${question}`}>
      <div className="terminal-prompt-overlay-header">
        {sourceLabel !== null
          ? <span className="terminal-prompt-overlay-tool">{sourceLabel}</span>
          : null}
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
      </div>
      {renderFooterLinks(opts)}
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
  const sourceLabel = sourceLabelForMatch(match);
  const overlay = toElement(
    <div className="terminal-prompt-overlay terminal-prompt-overlay-yesno" role="dialog" aria-modal="false" aria-label={`Terminal prompt: ${question}`}>
      <div className="terminal-prompt-overlay-header">
        {sourceLabel !== null
          ? <span className="terminal-prompt-overlay-tool">{sourceLabel}</span>
          : null}
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
      </div>
      {renderFooterLinks(opts)}
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
      </div>
      {renderFooterLinks(opts)}
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
