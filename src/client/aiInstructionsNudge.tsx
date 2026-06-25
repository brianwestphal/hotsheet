import { type AiInstructionsStateResp, applyAiInstructions, getAiInstructionsStatus, getFileSettings, updateFileSettings } from '../api/index.js';
import { toElement } from './dom.js';
import { getActiveProject } from './state.js';

/**
 * HS-8913 — once-per-project nudge to install Hot Sheet's recommended
 * AI-assistant instruction sections into the project's CLAUDE.md.
 *
 * Behavior (per the ticket): check the active project once at boot AND once
 * each time a different project is first selected — not only the initially-
 * loaded project. For whichever project is active:
 *   - If the project ALREADY has some managed sections but they're behind the
 *     current version (or a newly-added section is missing), silently auto-update
 *     them — no prompt. The user already opted in; we just keep the text current.
 *   - If NONE of our sections are present, prompt once per project (gated on
 *     Claude being detected, and on a per-project "dismissed" flag in
 *     settings.json). Any dismissal — Set up, Not now, X, or backdrop — sets the
 *     flag, so the prompt is genuinely once per project. The Settings → General
 *     button is the re-entry point afterward.
 *
 * The per-session `checkedSecrets` guard keeps a project from being re-checked
 * every time the user toggles back to it (the API status + apply calls would
 * otherwise re-fire on every switch). Persisted dismissal still lives in the
 * project's `settings.json`, so the prompt stays suppressed across sessions too.
 */

const DISMISSED_KEY = 'ai_instructions_nudge_dismissed';

/** Project secrets already checked this session (boot or switch). Guards
 *  against re-firing the status/apply calls on every project toggle. */
const checkedSecrets = new Set<string>();

/** **TEST ONLY** — clear the per-session checked-projects guard. */
export function _resetCheckedSecretsForTesting(): void {
  checkedSecrets.clear();
}

export type NudgeAction = 'silent-update' | 'prompt' | 'none';

/** Pure decision — exported for unit testing. */
export function decideNudgeAction(state: AiInstructionsStateResp, dismissed: boolean): NudgeAction {
  const anyPresent = state.sections.some(s => s.present);
  if (anyPresent) {
    return state.setupNeeded ? 'silent-update' : 'none';
  }
  if (state.detected && !dismissed) return 'prompt';
  return 'none';
}

function readDismissed(value: unknown): boolean {
  return value === true || value === 'true';
}

/** E2E force-disable seam — mirrors `terminalWebgl.ts`'s
 *  `__HOTSHEET_DISABLE_WEBGL__`. `coverage-fixture.ts` sets
 *  `window.__HOTSHEET_DISABLE_AI_NUDGE__ = true` via `addInitScript` (before the
 *  app bundle runs) so the nudge modal never mounts and intercepts clicks during
 *  unrelated specs. A nudge-specific spec can clear the flag to exercise the UI. */
export function aiNudgeDisabledForTesting(): boolean {
  return (window as unknown as { __HOTSHEET_DISABLE_AI_NUDGE__?: boolean }).__HOTSHEET_DISABLE_AI_NUDGE__ === true;
}

/** Public entry point — called on app boot and after each project switch.
 *  Fire-and-forget, best-effort. Skips a project already checked this session
 *  so toggling between projects doesn't re-fire the status/apply calls. */
export function maybeShowAiInstructionsNudge(): void {
  if (aiNudgeDisabledForTesting()) return;
  const secret = getActiveProject()?.secret;
  // A known secret is recorded up-front so a rapid second switch back can't
  // start a concurrent in-flight check. An unknown secret (boot before the
  // first project resolves) is let through but not recorded, so the real
  // check still runs once the active project is known.
  if (secret !== undefined) {
    if (checkedSecrets.has(secret)) return;
    checkedSecrets.add(secret);
  }
  void (async () => {
    try {
      const [state, fs] = await Promise.all([getAiInstructionsStatus(), getFileSettings()]);
      const action = decideNudgeAction(state, readDismissed(fs[DISMISSED_KEY]));
      if (action === 'silent-update') {
        await applyAiInstructions();
      } else if (action === 'prompt') {
        showAiInstructionsNudgeDialog();
      }
    } catch {
      // Network hiccup / older server without the endpoint — skip silently.
    }
  })();
}

function persistDismissed(): void {
  void updateFileSettings({ [DISMISSED_KEY]: true });
}

const CLOSE_ICON_SVG = <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>;

/** Build + mount the dialog. Exported so tests can drive it without the boot
 *  gates. */
export function showAiInstructionsNudgeDialog(): void {
  document.querySelectorAll('.ai-instructions-nudge-overlay').forEach(el => el.remove());

  const overlay = toElement(
    <div className="ai-instructions-nudge-overlay" role="dialog" aria-modal="true" aria-label="Set up AI assistant instructions">
      <div className="ai-instructions-nudge-dialog">
        <div className="ai-instructions-nudge-header">
          <span className="ai-instructions-nudge-title">Set Up Your AI Assistant</span>
          <button className="ai-instructions-nudge-close" type="button" title="Close" aria-label="Close">
            {CLOSE_ICON_SVG}
          </button>
        </div>
        <div className="ai-instructions-nudge-body">
          <p>
            Hot Sheet works best when your AI assistant knows a few conventions. Add Hot Sheet's recommended sections to this project's <code>CLAUDE.md</code> so your assistant will:
          </p>
          <ul>
            <li>Drive work through Hot Sheet tickets (and file follow-ups for loose ends).</li>
            <li>Keep <strong>double test coverage</strong> — unit <em>and</em> end-to-end.</li>
            <li>Keep human + AI-oriented requirements docs in sync.</li>
          </ul>
          <p className="ai-instructions-nudge-note">
            Your existing <code>CLAUDE.md</code> is preserved — the sections are added with markers so Hot Sheet can keep them current without touching the rest. The test/docs specifics are filled in by your assistant for this project.
          </p>
          <button className="ai-instructions-nudge-cta" type="button">Add to CLAUDE.md</button>
          <a className="ai-instructions-nudge-dismiss" href="#">Not now</a>
        </div>
      </div>
    </div>
  );

  const close = (): void => {
    overlay.remove();
    persistDismissed();
  };

  const ctaBtn = overlay.querySelector<HTMLButtonElement>('.ai-instructions-nudge-cta')!;
  overlay.querySelector('.ai-instructions-nudge-close')!.addEventListener('click', close);
  overlay.querySelector('.ai-instructions-nudge-dismiss')!.addEventListener('click', (e) => {
    e.preventDefault();
    close();
  });
  ctaBtn.addEventListener('click', () => {
    ctaBtn.disabled = true;
    ctaBtn.textContent = 'Adding…';
    void applyAiInstructions()
      .then(() => { ctaBtn.textContent = 'Added ✓'; })
      .catch(() => { ctaBtn.textContent = 'Failed — try Settings'; })
      .finally(() => { setTimeout(close, 700); });
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  document.body.appendChild(overlay);
}
