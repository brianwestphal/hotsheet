import { toElement } from './dom.js';
import { getTauriEventListener, getTauriInvoke } from './tauriIntegration.js';

/**
 * Quit-confirm prompt (HS-7596 / §37). Shown when the user attempts to quit
 * Hot Sheet (⌘Q / Alt+F4 / red traffic-light close / `hotsheet --close`) and
 * any project's setting + alive-terminal list says "prompt." Displays the
 * running non-exempt terminals grouped by project so the user sees what
 * they'd be killing, plus a "Don't ask again" checkbox that flips every
 * project's setting to `'never'` for the lifetime of the user's setup.
 *
 * Decision policy lives in `evaluateQuitDecision` — pure, unit-testable,
 * cleanly separated from the dialog DOM. The exported `runQuitConfirmFlow`
 * is the entry point: it fetches `/api/projects/quit-summary`, runs the
 * decision, and (when the prompt is needed) shows the dialog and returns
 * the user's choice.
 */

export interface QuitSummaryEntry {
  terminalId: string;
  label: string;
  foregroundCommand: string;
  isShell: boolean;
  isExempt: boolean;
}

export interface QuitSummaryProject {
  secret: string;
  name: string;
  confirmMode: 'always' | 'never' | 'with-non-exempt-processes';
  entries: QuitSummaryEntry[];
}

export interface QuitSummary {
  projects: QuitSummaryProject[];
}

export interface QuitDecisionResult {
  /** True when the user should be prompted before the app exits. */
  shouldPrompt: boolean;
  /** Projects (with their entries) that should appear in the dialog list.
   *  Empty when shouldPrompt is false. */
  contributing: QuitSummaryProject[];
}

/**
 * Pure decision function — given a quit-summary, decide whether to prompt
 * and which projects + entries belong in the dialog body.
 *
 * §37.5 logic: the prompt fires if ANY project's setting is `'always'` OR
 * if ANY project's `'with-non-exempt-processes'` resolves to "yes, prompt"
 * (i.e. has at least one non-exempt entry). A project set to `'never'`
 * doesn't trigger the prompt on its own, but if the prompt is fired by
 * another project, the `'never'` project's alive entries DO appear in the
 * list (so the user sees what they'd be killing). When every project is
 * `'never'`, no prompt — silent quit.
 *
 * Pure: no DOM or fetch dependencies. Unit-testable in isolation.
 */
export function evaluateQuitDecision(summary: QuitSummary): QuitDecisionResult {
  let anyTriggers = false;
  for (const project of summary.projects) {
    if (project.confirmMode === 'always') {
      // 'Always' fires the prompt regardless of whether anything is alive.
      anyTriggers = true;
      continue;
    }
    if (project.confirmMode === 'with-non-exempt-processes') {
      const hasNonExempt = project.entries.some(e => !e.isExempt);
      if (hasNonExempt) anyTriggers = true;
    }
    // 'never' contributes its entries to the list (below) but doesn't
    // trigger on its own.
  }
  if (!anyTriggers) {
    return { shouldPrompt: false, contributing: [] };
  }
  // Build the list of projects to display: any project with at least one
  // entry to show. For 'with-non-exempt-processes' that means non-exempt
  // entries only; for 'always' and 'never' it means every alive entry
  // (since 'always' wants the user to see everything that's running).
  const contributing: QuitSummaryProject[] = [];
  for (const project of summary.projects) {
    let entries: QuitSummaryEntry[];
    if (project.confirmMode === 'with-non-exempt-processes') {
      entries = project.entries.filter(e => !e.isExempt);
    } else {
      entries = [...project.entries];
    }
    if (entries.length === 0) continue;
    contributing.push({ ...project, entries });
  }
  return { shouldPrompt: true, contributing };
}

/**
 * One-time wiring: when running inside Tauri, subscribe to the Rust-side
 * `quit-confirm-requested` event the CloseRequested handler fires. On every
 * fire, run the §37 confirm flow + invoke the `confirm_quit` Tauri command
 * if the user clicks Quit Anyway. No-op outside Tauri (the browser-side
 * confirm flow is reachable via the CLI's `hotsheet --close` only).
 */
export function initQuitConfirm(): void {
  const listen = getTauriEventListener();
  if (listen === null) return;
  void listen('quit-confirm-requested', () => {
    void (async () => {
      const outcome = await runQuitConfirmFlow();
      if (outcome === 'proceed') {
        const invoke = getTauriInvoke();
        if (invoke !== null) {
          await invoke('confirm_quit').catch((err: unknown) => {
            console.error('quitConfirm: confirm_quit invoke failed', err);
          });
        }
      }
      // 'cancel' → do nothing, the CloseRequested handler already prevented
      // the close so the app stays open.
    })();
  });
}

/**
 * Run the full quit-confirm flow: fetch quit-summary, evaluate decision,
 * show the dialog if prompting is needed, return the user's choice.
 *
 * Returns `'proceed'` when the user clicked Quit Anyway OR when the
 * decision said no prompt was needed (silent quit). Returns `'cancel'`
 * when the user clicked Cancel.
 *
 * On any fetch / network error, returns `'cancel'` defensively — better
 * to leave the app open than silently kill running terminals because the
 * server briefly hiccuped.
 */
export async function runQuitConfirmFlow(): Promise<'proceed' | 'cancel'> {
  let summary: QuitSummary;
  try {
    const res = await fetch('/api/projects/quit-summary');
    if (!res.ok) return 'cancel';
    summary = await res.json() as QuitSummary;
  } catch {
    return 'cancel';
  }

  const decision = evaluateQuitDecision(summary);
  if (!decision.shouldPrompt) return 'proceed';

  const choice = await showQuitConfirmDialog(decision.contributing);
  if (choice.outcome === 'proceed' && choice.dontAskAgain) {
    // Persist 'never' for every project that was in the summary.
    await Promise.all(summary.projects.map(async (project) => {
      try {
        await fetch('/api/file-settings', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'X-Hotsheet-Secret': project.secret,
          },
          body: JSON.stringify({ confirm_quit_with_running_terminals: 'never' }),
        });
      } catch { /* best-effort — quit is the user's stronger signal */ }
    }));
  }
  return choice.outcome;
}

interface QuitDialogChoice {
  outcome: 'proceed' | 'cancel';
  dontAskAgain: boolean;
}

function showQuitConfirmDialog(contributing: QuitSummaryProject[]): Promise<QuitDialogChoice> {
  return new Promise<QuitDialogChoice>((resolve) => {
    const overlay = toElement(
      <div className="confirm-dialog-overlay quit-confirm-overlay" role="dialog" aria-modal="true" aria-label="Quit Hot Sheet?">
        <div className="confirm-dialog quit-confirm-dialog">
          <div className="confirm-dialog-header">Quit Hot Sheet?</div>
          <div className="confirm-dialog-body">
            <div className="quit-confirm-intro">
              The following terminals are running active processes. Quitting will stop all of them.
            </div>
            <ul className="quit-confirm-list">
              {contributing.map(project => (
                <li className="quit-confirm-project">
                  <div className="quit-confirm-project-name">{project.name}</div>
                  <ul>
                    {project.entries.map(entry => (
                      <li>
                        <span className="quit-confirm-entry-label">{entry.label}</span>
                        <span className="quit-confirm-entry-cmd">{`(${entry.foregroundCommand})`}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            <label className="quit-confirm-dont-ask">
              <input type="checkbox" className="quit-confirm-dont-ask-cb" />
              {' Don’t ask again for any project'}
            </label>
          </div>
          <div className="confirm-dialog-footer">
            <button type="button" className="btn btn-sm quit-confirm-cancel">Cancel</button>
            <button type="button" className="btn btn-sm btn-danger quit-confirm-proceed">Quit Anyway</button>
          </div>
        </div>
      </div>
    );

    let settled = false;
    const finish = (outcome: 'proceed' | 'cancel'): void => {
      if (settled) return;
      settled = true;
      const cb = overlay.querySelector<HTMLInputElement>('.quit-confirm-dont-ask-cb');
      const dontAskAgain = cb?.checked === true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve({ outcome, dontAskAgain });
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); finish('cancel'); }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish('proceed'); }
    };
    document.addEventListener('keydown', onKey, true);

    overlay.querySelector('.quit-confirm-cancel')?.addEventListener('click', () => { finish('cancel'); });
    overlay.querySelector('.quit-confirm-proceed')?.addEventListener('click', () => { finish('proceed'); });
    // Click backdrop = cancel (matches confirm-dialog convention).
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish('cancel'); });

    document.body.appendChild(overlay);
    // Default-focus Cancel rather than Quit Anyway so a stray Enter doesn't
    // immediately destroy work — the user has to deliberately click /
    // Tab-then-Enter the Quit Anyway button.
    overlay.querySelector<HTMLButtonElement>('.quit-confirm-cancel')?.focus();
  });
}
