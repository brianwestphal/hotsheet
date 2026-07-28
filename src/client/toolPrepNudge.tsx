import { ensureSkills, getFileSettings, getToolPrepStatus, prepareToolConfig, type ToolPrepStatusResp, updateFileSettings } from '../api/index.js';
import { agentDisplayName } from './agentName.js';
import { toElement } from './dom.js';
import { projectScoped } from './projectScoped.js';

/**
 * HS-9367 (docs/119) — ask-first preparation of the SELECTED tool's config.
 *
 * Two entry points share this module:
 *  - **`switch`** — the Settings `ai_tool` dropdown changed. Instead of silently
 *    writing `AGENTS.md`/skills to the repo, ask first ("Prepare Codex config
 *    for this project?"); one click applies the full prep (instruction file
 *    [adapter-mode, HS-9366] + skills + MCP + permissions). When nothing is
 *    missing, silently `ensureSkills()` — the pre-HS-9367 refresh behavior
 *    (agy hooks install/remove etc.) is preserved.
 *  - **`open`** — the project-open drift check (the L1 fallback folded into
 *    HS-9367): a project whose selected tool's config is absent/stale gets the
 *    same nudge once, gated by a per-project dismissal flag so it can't nag.
 *
 * The dialog reuses the §86 `.ai-instructions-nudge-*` surface (same CSS).
 */

/** File-settings key recording WHICH tool's open-nudge was dismissed — switching
 *  to a different tool later re-arms the nudge. */
const DISMISSED_KEY = 'tool_prep_nudge_dismissed';

/** Per-session guard for the `open` path — a project is drift-checked once per
 *  session. HS-9418 (docs/126): was a hand-rolled `Set<secret>`; as a
 *  `projectScoped` flag it gains automatic eviction when a project is
 *  unregistered (so a re-added project is re-checked, which is what you want)
 *  and coverage by the generic isolation harness. */
const alreadyChecked = projectScoped(() => false, 'toolPrepNudge.alreadyChecked');

/** **TEST ONLY** — clear the per-session checked-projects guard. */
export function _resetToolPrepCheckedForTesting(): void {
  alreadyChecked.clearAllScopes();
}

/** E2E force-disable seam — the SAME `__HOTSHEET_DISABLE_AI_NUDGE__` flag the
 *  §86 nudge honors (`aiInstructionsNudge.tsx`; set by `coverage-fixture.ts` so
 *  nudge overlays never intercept clicks in unrelated specs). Read locally
 *  rather than imported to avoid an aiInstructionsNudge ↔ toolPrepNudge cycle. */
function toolPrepDisabledForTesting(): boolean {
  return (window as unknown as { __HOTSHEET_DISABLE_AI_NUDGE__?: boolean }).__HOTSHEET_DISABLE_AI_NUDGE__ === true;
}

export type ToolPrepAction = 'dialog' | 'silent-ensure' | 'none';

/** Pure decision — exported for unit testing.
 *  - `auto` never needs tool-specific prep: a switch keeps the silent refresh,
 *    an open check does nothing.
 *  - Something missing/stale — or an HS-9375 adapter-retirement offer — →
 *    dialog; on `open` the per-tool dismissal wins.
 *  - Nothing needed → a switch still silently ensures (hooks refresh); an open
 *    check does nothing. */
export function decideToolPrepAction(
  status: Pick<ToolPrepStatusResp, 'aiTool' | 'needed' | 'conversionOffered'>,
  source: 'switch' | 'open',
  dismissedTool: string | null,
): ToolPrepAction {
  const wantsDialog = status.needed || status.conversionOffered === true;
  if (status.aiTool === 'auto' || !wantsDialog) {
    return source === 'switch' ? 'silent-ensure' : 'none';
  }
  if (source === 'open' && dismissedTool === status.aiTool) return 'none';
  return 'dialog';
}

function readDismissedTool(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Entry point. `switch` = the ai_tool dropdown changed (always re-evaluates);
 *  `open` = boot / project switch (once per project per session). Fire-and-forget. */
export function maybeOfferToolPrep(source: 'switch' | 'open'): void {
  if (toolPrepDisabledForTesting()) {
    // Keep the pre-HS-9367 switch behavior under e2e (skills refresh, no dialog)
    // so specs that drive the ai_tool dropdown aren't blocked by an overlay.
    if (source === 'switch') void ensureSkills().catch(() => { /* best-effort */ });
    return;
  }
  if (source === 'open') {
    if (alreadyChecked.get()) return;
    alreadyChecked.set(true);
  }
  void (async () => {
    try {
      const [status, fs] = await Promise.all([getToolPrepStatus(), getFileSettings()]);
      const action = decideToolPrepAction(status, source, readDismissedTool(fs[DISMISSED_KEY]));
      if (action === 'dialog') {
        showToolPrepDialog(status);
      } else if (action === 'silent-ensure') {
        await ensureSkills();
      }
    } catch {
      // Network hiccup / older server — skip silently.
    }
  })();
}

function persistDismissed(aiTool: string): void {
  void updateFileSettings({ [DISMISSED_KEY]: aiTool });
}

const CLOSE_ICON_SVG = <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>;

/** Build + mount the prepare dialog. Exported so tests can drive it directly. */
export function showToolPrepDialog(status: ToolPrepStatusResp): void {
  document.querySelectorAll('.tool-prep-nudge-overlay').forEach(el => el.remove());
  const label = agentDisplayName(status.aiTool);

  const items: string[] = [];
  if (status.instructionsNeeded && status.instructionsPath !== null) items.push(status.instructionsPath);
  if (status.skillsNeeded && status.skillsPath !== null) items.push(status.skillsPath);

  const overlay = toElement(
    <div className="ai-instructions-nudge-overlay tool-prep-nudge-overlay" role="dialog" aria-modal="true" aria-label={`Prepare ${label} config`}>
      <div className="ai-instructions-nudge-dialog">
        <div className="ai-instructions-nudge-header">
          <span className="ai-instructions-nudge-title">Prepare {label} Config?</span>
          <button className="ai-instructions-nudge-close" type="button" title="Close" aria-label="Close">
            {CLOSE_ICON_SVG}
          </button>
        </div>
        <div className="ai-instructions-nudge-body">
          <p>
            This project's AI tool is set to <strong>{label}</strong>, but its config isn't fully prepared. Hot Sheet can write:
          </p>
          <ul>
            {items.map(p => <li><code>{p}</code></li>)}
            {status.conversionOffered === true && status.instructionsPath !== null
              ? <li><code>{status.instructionsPath}</code> — convert its duplicated sections to the thin <code>CLAUDE.md</code> adapter (your filled-in specifics move into <code>CLAUDE.md</code> first, so nothing is lost)</li>
              : null}
          </ul>
          <p className="ai-instructions-nudge-note">
            Existing files are preserved — sections are added with markers, and when this project has a canonical <code>CLAUDE.md</code> the new files are thin adapters that reference it. MCP registration and permissions are set up as needed.
          </p>
          <button className="ai-instructions-nudge-cta" type="button">Prepare {label} config</button>
          <a className="ai-instructions-nudge-dismiss" href="#">Not now</a>
        </div>
      </div>
    </div>
  );

  const close = (dismiss: boolean): void => {
    overlay.remove();
    if (dismiss) persistDismissed(status.aiTool);
  };

  const ctaBtn = overlay.querySelector<HTMLButtonElement>('.ai-instructions-nudge-cta')!;
  overlay.querySelector('.ai-instructions-nudge-close')!.addEventListener('click', () => close(true));
  overlay.querySelector('.ai-instructions-nudge-dismiss')!.addEventListener('click', (e) => {
    e.preventDefault();
    close(true);
  });
  ctaBtn.addEventListener('click', () => {
    ctaBtn.disabled = true;
    ctaBtn.textContent = 'Preparing…';
    void prepareToolConfig()
      .then(() => { ctaBtn.textContent = 'Prepared ✓'; })
      .catch(() => { ctaBtn.textContent = 'Failed — try again from Settings'; })
      .finally(() => { setTimeout(() => close(false), 700); });
  });
  // HS-9452 — no backdrop dismissal here either. This one called `close(true)`,
  // which persists the per-tool dismissal, so a stray click beside the dialog
  // silently suppressed the prep prompt for that tool. Same reasoning as
  // `aiInstructionsNudge`: dismissal that PERSISTS needs an explicit button.
  // (`upgradeNudge`'s backdrop is deliberately left alone — it closes with
  // `close(false)`, i.e. "maybe later", and re-prompts in 30 days.)

  document.body.appendChild(overlay);
}
