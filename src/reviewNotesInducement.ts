import { execFileSync } from 'child_process';

import { isExecutableOnPath } from './utils/isExecutableOnPath.js';

/**
 * HS-9221 (docs/110) — Hot Sheet's side of Glassbox's AI-Authored Review Notes
 * (Glassbox docs/20 §20.7): when a project opts in via the `aiReviewNotes`
 * setting, the worklist induces the coding agent to emit line-anchored
 * `.pr-notes/` review notes as it works each ticket.
 *
 * The coordination contract (Glassbox §20.4) is **don't fork the wording**:
 * Glassbox ships the canonical inbound instruction text via
 * `glassbox note instructions`, and Hot Sheet injects that output verbatim. This
 * module owns only **detection** (is the `glassbox` CLI on PATH? which
 * invocation form works?), the cached **fetch** of that text, and the worklist
 * **section** wrapper that adds the ticket-id threading guidance (Hot Sheet's
 * only original prose).
 *
 * HS-9371 — the Glassbox **desktop-app launcher** script (the
 * `/usr/local/bin/glassbox` symlink into `Glassbox.app`) prepends
 * `--no-open --project-dir <cwd>` before its passthrough args, so `note` never
 * reaches `cli.js`'s subcommand check and plain `glassbox note …` fails with
 * "Unknown option: note" — even though the bundled `cli.js` fully supports it.
 * The launcher's `--browser` mode execs `cli.js` with the RAW args, so
 * `glassbox --browser note …` works. We therefore probe BOTH forms (plain
 * first — correct for the npm CLI and fixed launchers — then `--browser`) and
 * remember which one worked so the injected section can tell the agent the
 * invocation form that actually functions on this machine.
 */

/** Result of probing for the canonical `glassbox note instructions` text. */
export type GlassboxInstructions =
  /** The text was fetched. `browserPrefix` = only the `glassbox --browser note …`
   *  form works on this machine (the HS-9371 desktop-launcher quirk). */
  | { kind: 'ok'; text: string; browserPrefix: boolean }
  /** No `glassbox` executable on PATH (or the common install dirs). */
  | { kind: 'not-on-path' }
  /** `glassbox` exists but neither invocation form produced the text —
   *  most likely an older Glassbox without `note` support. */
  | { kind: 'probe-failed' };

// Per-process cache of the probe result. `undefined` → not yet attempted.
// A `not-on-path` result is NOT cached permanently — the (cheap, no-exec) PATH
// check re-runs on each call so installing Glassbox mid-session is picked up
// without a Hot Sheet restart. Exec-backed results (ok / probe-failed) stay
// cached for the process: the probe shells out synchronously, so we only pay
// that cost once.
let cachedProbe: GlassboxInstructions | undefined;

/** One invocation attempt. Returns the trimmed output, or null on any failure. */
function tryFetchInstructions(args: string[]): string | null {
  try {
    const out = execFileSync('glassbox', args, { encoding: 'utf-8', timeout: 5000 });
    const trimmed = out.trim();
    return trimmed !== '' ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the canonical inbound instruction text from `glassbox note instructions`
 * (falling back to the `--browser`-prefixed form for the HS-9371 desktop-launcher
 * quirk), cached for the process. The discriminated result lets the section
 * builder render an accurate fallback for each failure mode instead of the old
 * blanket "not found on PATH" (which also masked "installed but too old").
 */
export function getGlassboxNoteInstructions(): GlassboxInstructions {
  if (cachedProbe !== undefined && cachedProbe.kind !== 'not-on-path') return cachedProbe;
  if (!isExecutableOnPath('glassbox')) {
    cachedProbe = { kind: 'not-on-path' };
    return cachedProbe;
  }
  const plain = tryFetchInstructions(['note', 'instructions']);
  if (plain !== null) {
    cachedProbe = { kind: 'ok', text: plain, browserPrefix: false };
    return cachedProbe;
  }
  const viaBrowser = tryFetchInstructions(['--browser', 'note', 'instructions']);
  if (viaBrowser !== null) {
    cachedProbe = { kind: 'ok', text: viaBrowser, browserPrefix: true };
    return cachedProbe;
  }
  cachedProbe = { kind: 'probe-failed' };
  return cachedProbe;
}

/** Test-only — drop the per-process cache so the next call re-detects/re-fetches. */
export function _resetGlassboxInstructionsCacheForTests(): void {
  cachedProbe = undefined;
}

/**
 * Build the worklist `## AI Review Notes` section.
 *
 * Pure given its inputs (the resolved `aiReviewNotes` setting + the
 * already-probed instruction result), so it's trivially testable without
 * shelling out — `syncWorklist` passes `getGlassboxNoteInstructions()` for
 * `probe` (or `null` when the setting is off, skipping the probe entirely).
 *
 * - `enabled === false` → `[]` (nothing injected; the default for every project).
 * - `ok` → Hot Sheet's ticket-id wrapper, then Glassbox's verbatim canonical
 *   text; when only the `--browser` form works (HS-9371), a machine-specific
 *   note tells the agent to prefix note subcommands with `--browser`.
 * - `not-on-path` / `probe-failed` → the wrapper followed by the matching
 *   minimal fallback nudge (no forked copy of the detailed instructions).
 */
export function buildReviewNotesSection(
  enabled: boolean,
  probe: GlassboxInstructions | null,
): string[] {
  if (!enabled || probe === null) return [];
  const sections: string[] = [];
  sections.push('## AI Review Notes (`.pr-notes/`)');
  sections.push('');
  sections.push(
    'This project emits **AI-authored review notes** — line-anchored rationale/proof ' +
      'committed under `.pr-notes/` and rendered review-comment-style in Glassbox. As you ' +
      'work each ticket, leave notes for non-obvious changes, and **attribute each note to ' +
      'the ticket you are working** by passing `--ticket <its HS-NNNN>` (with ' +
      '`--producer "Hot Sheet"`).',
  );
  sections.push('');
  if (probe.kind === 'ok') {
    if (probe.browserPrefix) {
      sections.push(
        '**On this machine, prefix every note subcommand with `--browser`** — the installed ' +
          'Glassbox desktop launcher only routes subcommands through in that mode: ' +
          '`glassbox --browser note add …`, `glassbox --browser note instructions`.',
      );
      sections.push('');
    }
    sections.push(
      'The canonical instructions (from `glassbox note instructions`) follow — run that ' +
        'command yourself for the freshest copy:',
    );
    sections.push('');
    sections.push(probe.text);
  } else if (probe.kind === 'probe-failed') {
    sections.push(
      'The `glassbox` CLI is installed but `glassbox note instructions` failed — most ' +
        'likely an older Glassbox without review-notes support. Ask the maintainer to ' +
        'update Glassbox; meanwhile record your rationale/proof in the ticket completion ' +
        'note instead. See Glassbox `docs/20-ai-review-notes.md`.',
    );
  } else {
    sections.push(
      'The `glassbox` CLI was not found on PATH. If you can run it, emit notes via ' +
        '`glassbox note add --file … --lines A-B --kind … --ticket <HS-NNNN> ' +
        '--producer "Hot Sheet" --body -`; otherwise record your rationale/proof in the ' +
        'ticket completion note instead. See Glassbox `docs/20-ai-review-notes.md`.',
    );
  }
  sections.push('');
  return sections;
}
