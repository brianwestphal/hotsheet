import { toElement } from './dom.js';
import { getTauriEventListener, getTauriInvoke } from './tauriIntegration.js';
import { checkout,type CheckoutHandle } from './terminalCheckout.js';

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

// HS-8045 — `ScrollbackPreviewResponse` interface, `fetchScrollbackPreview`,
// `paletteFromTheme`, `applyAppearanceToPreview`, `paintPreviewContent`
// helpers all deleted. The §37 ANSI-spans preview path that depended on
// them is fully obsolete now that every consumer of the quit-confirm /
// dashboard / drawer-grid / drawer surfaces routes through
// `terminalCheckout` for real xterm canvas previews. The matching server
// route (`GET /api/terminal/scrollback-preview`), registry helper
// (`getTerminalScrollbackPreviewWithAnsi` + the stripped variant), and
// `buildScrollbackPreviewWithAnsi` / `buildScrollbackPreview` snapshot
// helpers are deleted in the same change.

interface QuitDialogChoice {
  outcome: 'proceed' | 'cancel';
  dontAskAgain: boolean;
}

/** HS-8041 — preview pane mounts a real `terminalCheckout` xterm instead
 *  of the ANSI-spans approximation. The cols / rows are an initial seed
 *  used by `checkout()` for the very first attach; immediately after,
 *  HS-7969 follow-up calls `fit.fit()` against the preview pane so the
 *  xterm canvas fills the dialog's right pane regardless of the user's
 *  font size / theme / dialog width. The seed kicks in only when no
 *  earlier consumer has set the entry's dims yet — once the entry is
 *  alive, `applyResizeIfChanged` skips on same-size and the fit's
 *  follow-up `handle.resize()` is what actually moves the PTY. */
const QUIT_PREVIEW_COLS = 80;
const QUIT_PREVIEW_ROWS = 30;

/** Exported for the HS-8041 dismiss-while-loading race regression in
 *  `quitConfirm.test.ts`. Production callers continue to enter via
 *  `runQuitConfirmFlow()`. */
export function showQuitConfirmDialog(contributing: QuitSummaryProject[]): Promise<QuitDialogChoice> {
  return new Promise<QuitDialogChoice>((resolve) => {
    const totalTerminals = contributing.reduce((acc, p) => acc + p.entries.length, 0);
    const intro = totalTerminals === 1
      ? 'A terminal is running an active process. Quitting will stop it.'
      : `${totalTerminals} terminals are running active processes. Quitting will stop all of them.`;

    // HS-7969 follow-up — flatten the (project, entry) tree into a flat
    // ordered list. Headings are still rendered between project blocks in
    // the master pane; the flat array is the source of truth for the
    // initial-selection + index-based row lookup paths.
    interface FlatEntry { project: QuitSummaryProject; entry: QuitSummaryEntry }
    const flat: FlatEntry[] = [];
    for (const project of contributing) {
      for (const entry of project.entries) flat.push({ project, entry });
    }

    const overlay = toElement(
      <div className="quit-confirm-overlay" role="dialog" aria-modal="true" aria-label="Quit Hot Sheet?">
        <div className="quit-confirm-dialog quit-confirm-dialog-master-detail">
          <div className="quit-confirm-header">
            <span className="quit-confirm-title">
              <span className="quit-confirm-icon" aria-hidden="true">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/></svg>
              </span>
              Quit Hot Sheet?
            </span>
            <button className="quit-confirm-close" type="button" data-action="cancel" title="Cancel">{'×'}</button>
          </div>
          <div className="quit-confirm-intro">{intro}</div>
          {/* HS-7969 follow-up — master-detail: the row list lives on the
              left, the read-only scrollback preview on the right. Selecting
              a row swaps the preview's content + repaints it with that
              terminal's theme + font. Replaces the click-to-expand
              accordion the user found visually noisy. */}
          <div className="quit-confirm-master-detail">
            <div className="quit-confirm-master" data-role="master">
              {contributing.map(project => (
                <div className="quit-confirm-project">
                  <div className="quit-confirm-project-heading">{project.name}</div>
                  {project.entries.map(entry => (
                    <button
                      className="quit-confirm-row"
                      type="button"
                      data-secret={project.secret}
                      data-terminal-id={entry.terminalId}
                      title="Click to preview the terminal's recent output"
                    >
                      <span className="quit-confirm-row-icon" aria-hidden="true">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/></svg>
                      </span>
                      <span className="quit-confirm-row-label">{entry.label}</span>
                      <span className="quit-confirm-row-cmd">{entry.foregroundCommand}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
            <div className="quit-confirm-detail" data-role="detail">
              {/* HS-8041 — was a `<pre>` painted by `paintPreviewContent`.
                  Migrated to a div hosting a real `terminalCheckout` xterm
                  (Phase 2.1 of HS-8032). The first checkout reparents
                  the live xterm element into this container, replacing
                  the placeholder text below. */}
              <div className="quit-confirm-detail-preview" data-state="empty">
                Select a terminal to preview its recent output.
              </div>
            </div>
          </div>
          <label className="quit-confirm-dont-ask">
            <input type="checkbox" className="quit-confirm-dont-ask-cb" />
            <span>{'Don’t ask again for any project'}</span>
          </label>
          <div className="quit-confirm-footer">
            <button type="button" className="quit-confirm-btn quit-confirm-btn-cancel" data-action="cancel">Cancel</button>
            <button type="button" className="quit-confirm-btn quit-confirm-btn-danger" data-action="proceed">Quit Anyway</button>
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
      // HS-8041 — release the live xterm checkout BEFORE removing the
      // overlay DOM. Order matters: `release()` reparents the live xterm
      // back to the previous mount (or disposes the entry on empty
      // stack); if we removed the overlay first, the xterm element would
      // briefly become orphaned and any cleanup that walks
      // `term.element.parentElement` would see null.
      if (currentCheckout !== null) {
        try { currentCheckout.release(); } catch { /* swallow — overlay tear-down is the user's stronger signal */ }
        currentCheckout = null;
      }
      // HS-7969 follow-up #2 — drop the pane ResizeObserver before
      // removing the overlay so we don't leak observers across multiple
      // open-and-close cycles of the dialog.
      previewResizeObserver?.disconnect();
      previewResizeObserver = null;
      overlay.remove();
      resolve({ outcome, dontAskAgain });
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); finish('cancel'); }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish('proceed'); }
    };
    document.addEventListener('keydown', onKey, true);

    overlay.querySelectorAll<HTMLElement>('[data-action="cancel"]').forEach(el => {
      el.addEventListener('click', (ev) => { ev.stopPropagation(); finish('cancel'); });
    });
    overlay.querySelector('[data-action="proceed"]')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      finish('proceed');
    });

    const previewEl = overlay.querySelector<HTMLElement>('.quit-confirm-detail-preview');
    const rows = Array.from(overlay.querySelectorAll<HTMLButtonElement>('.quit-confirm-row'));

    // HS-8041 — preview pane is a `terminalCheckout` consumer (Phase 2.1
    // of HS-8032). Each row-select releases the prior checkout and pushes
    // a new one for the clicked row's `(secret, terminalId)`. Cancel-
    // then-checkout ordering is critical: `release()` MUST happen before
    // `checkout()` so the stack never briefly holds two handles for the
    // same `mountInto`. The race regression in `quitConfirm.test.ts`
    // pins this contract via `_inspectStackForTesting()`.
    let currentCheckout: CheckoutHandle | null = null;
    // HS-7969 follow-up #2 — re-fit when the preview pane resizes. The
    // single-shot rAF fit from the previous fix worked for the initial
    // dialog layout but the user reported tiles still ending up the wrong
    // size in real use (latest screenshot — xterm extends past the pane).
    // Most-likely cause: the dialog goes through one layout pass at mount
    // (when `previewEl.offsetWidth` is final) but a SECOND pass when the
    // master-list flexbox children settle their intrinsic widths. The
    // pane's final pixel size only stabilises after that second pass —
    // the rAF-after-checkout fit catches the FIRST pass but misses the
    // second, leaving the term sized for the wrong pane dims. The
    // ResizeObserver pattern from `enterDedicatedView` (§54.7) re-fits
    // on every pane size change, which closes the gap regardless of
    // when layout stabilises. We track the most-recent checkout in
    // `currentCheckout` (set in `selectRow`) so the observer's callback
    // always operates on the live consumer.
    let previewResizeObserver: ResizeObserver | null = null;
    if (previewEl !== null) {
      previewResizeObserver = new ResizeObserver(() => {
        if (currentCheckout === null) return;
        const handle = currentCheckout;
        try {
          handle.fit.fit();
          handle.resize(handle.term.cols, handle.term.rows);
        } catch { /* fit can throw if the pane is detached mid-frame */ }
      });
      previewResizeObserver.observe(previewEl);
    }

    function selectRow(row: HTMLButtonElement): void {
      if (previewEl === null) return;
      rows.forEach(r => r.classList.remove('is-selected'));
      row.classList.add('is-selected');
      const secret = row.dataset.secret ?? '';
      const terminalId = row.dataset.terminalId ?? '';
      if (secret === '' || terminalId === '') return;

      // Release the prior checkout BEFORE starting the new one (HS-8041
      // §54.5.2 — dismiss-while-loading race). If we did it the other
      // way the stack would briefly hold [prior, new] both pointing at
      // `previewEl`, terminalCheckout would write a placeholder INTO
      // previewEl on the swap, then immediately reparent the new
      // xterm OVER it — visible flash, and the prior handle's release
      // path would have to walk an unexpected stack shape on cleanup.
      if (currentCheckout !== null) {
        currentCheckout.release();
        currentCheckout = null;
      }

      // Reset any stale paint state that previous code paths may have
      // left behind (legacy `paintPreviewContent` set background, font,
      // etc. as inline styles). The xterm renderer will own the
      // surface from here on, but defensive resets keep the pre-mount
      // window from flashing inherited styles.
      previewEl.dataset.state = 'live';
      previewEl.style.background = '';
      previewEl.style.color = '';
      previewEl.style.fontFamily = '';
      previewEl.style.fontSize = '';
      previewEl.style.fontStyle = '';

      currentCheckout = checkout({
        projectSecret: secret,
        terminalId,
        cols: QUIT_PREVIEW_COLS,
        rows: QUIT_PREVIEW_ROWS,
        mountInto: previewEl,
      });

      // HS-7969 follow-up — size the xterm to fill the preview pane.
      // Pre-fix the static 80×30 cols×rows produced a canvas whose pixel
      // dimensions didn't match the pane's, leaving a band of empty
      // background on the right + bottom of the pane. `fit.fit()` reads
      // the mount element's pixel size and resizes the term to whatever
      // cols × rows actually fit; we forward the resulting dims to the
      // PTY via `handle.resize` so output wraps correctly at the new
      // width.
      //
      // Defer to rAF: at this point the dialog is in the DOM but the
      // browser hasn't necessarily run the layout pass yet, so
      // `previewEl.offsetWidth` could still be 0. One rAF is enough for
      // layout to settle on every browser we ship to (Chromium /
      // WKWebView / GTK WebKit).
      const handle = currentCheckout;
      requestAnimationFrame(() => {
        if (handle !== currentCheckout) return; // stale — user picked another row
        try {
          handle.fit.fit();
          handle.resize(handle.term.cols, handle.term.rows);
        } catch { /* fit can throw if the pane is detached mid-frame */ }
      });
    }

    rows.forEach(row => {
      row.addEventListener('click', (ev) => {
        ev.stopPropagation();
        selectRow(row);
      });
    });
    // Click backdrop = cancel.
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish('cancel'); });

    document.body.appendChild(overlay);
    // HS-7969 follow-up — auto-select the first row so the preview pane
    // shows useful content immediately. Otherwise a user looking at a
    // single-row dialog would need an extra click to see anything.
    if (rows.length > 0) selectRow(rows[0]);
    // Default-focus Cancel rather than Quit Anyway so a stray Enter doesn't
    // immediately destroy work — the user has to deliberately click /
    // Tab-then-Enter the Quit Anyway button.
    overlay.querySelector<HTMLButtonElement>('.quit-confirm-btn-cancel')?.focus();
    // Reference the flat list so future patches can reach for it without
    // re-walking the tree (e.g. keyboard arrow navigation between rows).
    void flat;
  });
}

