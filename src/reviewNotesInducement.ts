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
 * module owns only **detection** (is the `glassbox` CLI on PATH?), the cached
 * **fetch** of that text, and the worklist **section** wrapper that adds the
 * ticket-id threading guidance (Hot Sheet's only original prose).
 */

// Per-process cache of the `glassbox note instructions` output.
//  - `undefined` → not yet attempted.
//  - `null`      → the `glassbox` CLI is absent or the call failed.
//  - `string`    → the canonical instruction text.
let cachedInstructions: string | null | undefined;

/**
 * Fetch the canonical inbound instruction text from `glassbox note instructions`,
 * cached for the process. Returns `null` when the `glassbox` CLI isn't on PATH or
 * the call fails/empties — the caller then injects the minimal fallback nudge
 * instead of a `glassbox note` command the agent can't run.
 */
export function getGlassboxNoteInstructions(): string | null {
  if (cachedInstructions !== undefined) return cachedInstructions;
  if (!isExecutableOnPath('glassbox')) {
    cachedInstructions = null;
    return null;
  }
  try {
    const out = execFileSync('glassbox', ['note', 'instructions'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const trimmed = out.trim();
    cachedInstructions = trimmed !== '' ? trimmed : null;
  } catch {
    cachedInstructions = null;
  }
  return cachedInstructions;
}

/** Test-only — drop the per-process cache so the next call re-detects/re-fetches. */
export function _resetGlassboxInstructionsCacheForTests(): void {
  cachedInstructions = undefined;
}

/**
 * Build the worklist `## AI Review Notes` section.
 *
 * Pure given its inputs (the resolved `aiReviewNotes` setting + the
 * already-fetched instruction text), so it's trivially testable without shelling
 * out — `syncWorklist` passes `getGlassboxNoteInstructions()` for `instructions`.
 *
 * - `enabled === false` → `[]` (nothing injected; the default for every project).
 * - `enabled` + `instructions` present → Hot Sheet's ticket-id wrapper followed
 *   by Glassbox's verbatim canonical text.
 * - `enabled` + `instructions === null` → the wrapper followed by the minimal
 *   fallback nudge (no forked copy of the detailed Glassbox instructions).
 */
export function buildReviewNotesSection(enabled: boolean, instructions: string | null): string[] {
  if (!enabled) return [];
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
  if (instructions !== null) {
    sections.push(
      'The canonical instructions (from `glassbox note instructions`) follow — run that ' +
        'command yourself for the freshest copy:',
    );
    sections.push('');
    sections.push(instructions);
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
