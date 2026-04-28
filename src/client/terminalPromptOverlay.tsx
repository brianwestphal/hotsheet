import { raw } from '../jsx-runtime.js';
import { toElement } from './dom.js';
import type { MatchResult } from './terminalPrompt/parsers.js';
import { buildNumberedCancelPayload, buildNumberedPayload } from './terminalPrompt/parsers.js';

/**
 * HS-7971 Phase 1 — terminal-prompt overlay UI.
 *
 * Per docs/52-terminal-prompt-overlay.md §52.5. Phase 1 only renders the
 * `numbered` shape (Claude-Ink style); `yesno` and `generic` are
 * Phase 2 follow-ups. Always-allow is Phase 3.
 *
 * The overlay is anchored to the active terminal pane (caller passes the
 * pane element). It is non-modal — the rest of the app stays interactive
 * while the overlay sits on top of the terminal canvas. Two dismissal
 * paths from Phase 1:
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
  /** Element to anchor the overlay to (the terminal pane). Overlay mounts
   *  inside this element so it scrolls / hides with the pane. */
  anchor: HTMLElement;
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
}

/** Open the overlay. Returns the overlay element so the caller can remove
 *  it programmatically (e.g. on terminal-pane teardown). Idempotent —
 *  calling twice in a row removes any prior overlay first. */
export function openTerminalPromptOverlay(opts: OpenTerminalPromptOverlayOptions): HTMLElement | null {
  // Phase 1 — only `numbered` is implemented.
  if (opts.match.shape !== 'numbered') return null;

  // Drop any prior overlay anchored to this pane so a re-trigger doesn't
  // stack two on top of each other.
  opts.anchor.querySelectorAll('.terminal-prompt-overlay').forEach(el => el.remove());

  const { question, choices } = opts.match;
  // HS-7980 — preserve multi-line question / diff context in a monospaced
  // pre block. Claude's Edit-tool prompts render an inline diff above the
  // numbered choices; collapsing the diff into a single line throws away
  // the structure the user needs to make a decision.
  const questionLines = opts.match.shape === 'numbered' ? opts.match.questionLines : [];
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
          >
            <span className="terminal-prompt-overlay-choice-num">{`${c.index + 1}.`}</span>
            <span className="terminal-prompt-overlay-choice-label">{c.label}</span>
          </button>
        ))}
      </div>
      <div className="terminal-prompt-overlay-footer">
        <button className="terminal-prompt-overlay-cancel" type="button">Cancel (Esc)</button>
        <a href="#" className="terminal-prompt-overlay-not-a-prompt">Not a prompt — let me handle it</a>
      </div>
      <p className="terminal-prompt-overlay-error" style="display:none"></p>
    </div>
  );

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

  // Choice click → numbered payload via parser helper.
  overlay.querySelectorAll<HTMLButtonElement>('.terminal-prompt-overlay-choice').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.choiceIndex ?? '0', 10);
      send(buildNumberedPayload(choices, idx));
    });
  });

  overlay.querySelector<HTMLButtonElement>('.terminal-prompt-overlay-cancel')?.addEventListener('click', () => {
    send(buildNumberedCancelPayload());
  });

  overlay.querySelector<HTMLButtonElement>('.terminal-prompt-overlay-close')?.addEventListener('click', () => {
    close();
  });

  overlay.querySelector<HTMLAnchorElement>('.terminal-prompt-overlay-not-a-prompt')?.addEventListener('click', (e) => {
    e.preventDefault();
    opts.onDismissAsNonPrompt();
    close();
  });

  // Capture-phase Escape closes-with-cancel — beats the global blur-input
  // handler in shortcuts.tsx so Esc here means "send Esc to the PTY", not
  // "blur whatever has focus".
  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    send(buildNumberedCancelPayload());
  }
  document.addEventListener('keydown', onKeydown, true);

  opts.anchor.appendChild(overlay);
  return overlay;
}
