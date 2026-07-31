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
    // HS-9518 — `killSignal: 'SIGKILL'` is what makes the `timeout` real: a
    // timeout is enforced by SENDING `killSignal`, which defaults to SIGTERM, and
    // a child that ignores SIGTERM leaves this call blocked forever anyway
    // (HS-9391). The signal must be one the child cannot decline.
    const out = execFileSync('glassbox', args, { encoding: 'utf-8', timeout: 5000, killSignal: 'SIGKILL' });
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
  } else {
    // HS-9376 — glassbox is only needed for VIEWING notes, never for generating
    // them. Without a working CLI, instruct the agent to write the SARIF files
    // directly (the Glassbox docs/20 §20.2 on-disk contract) instead of
    // degrading to "put it in the completion note".
    sections.push(
      probe.kind === 'probe-failed'
        ? 'The installed `glassbox` CLI does not support `note` subcommands (older version), ' +
            'but the CLI is only needed for *viewing* notes — write the SARIF files directly:'
        : 'The `glassbox` CLI was not found on PATH, but it is only needed for *viewing* ' +
            'notes — write the SARIF files directly:',
    );
    sections.push('');
    sections.push(...DIRECT_AUTHORING_INSTRUCTIONS);
  }
  sections.push('');
  return sections;
}

/**
 * HS-9376 — self-contained direct-authoring instructions for `.pr-notes/` SARIF,
 * injected when no working `glassbox` CLI is available. Mirrors the on-disk
 * contract of Glassbox docs/20 §20.2 (`buildResult` in its
 * `src/review-notes/sarif.ts` is the reference writer); Hot Sheet's own §111
 * proof reader (`src/reviewNotes/prNotesReader.ts`) reads the same shape.
 * Exported for testing.
 */
export const DIRECT_AUTHORING_INSTRUCTIONS: readonly string[] = [
  'Emit a note when a future reader would otherwise have to ask "why?" — a non-obvious ' +
    'decision, proof a change is correct, an assumption, a rejected alternative, a risk, or ' +
    'test evidence. Do not narrate the obvious; one note per genuine decision or claim.',
  '',
  '**File layout:** notes for a source file live at ' +
    '`.pr-notes/notes/<repo-relative source path>.000000.sarif` (e.g. ' +
    '`.pr-notes/notes/src/api/client.ts.000000.sarif`). Append to the existing shard when ' +
    'one exists — add your result to a run with your producer name and current commit, or ' +
    'add a new run. One note = one SARIF `result`.',
  '',
  '**Template** (a valid SARIF 2.1.0 log; replace the `<…>` placeholders):',
  '',
  '```json',
  '{',
  '  "$schema": "https://json.schemastore.org/sarif-2.1.0.json",',
  '  "version": "2.1.0",',
  '  "runs": [{',
  '    "tool": { "driver": {',
  '      "name": "<your tool/agent name, e.g. Claude Code>",',
  '      "rules": [{ "id": "review-note", "name": "ReviewNote",',
  '        "shortDescription": { "text": "AI-authored, line-anchored review note." } }]',
  '    } },',
  '    "versionControlProvenance": [{ "revisionId": "<git rev-parse HEAD>", "branch": "<current branch>" }],',
  '    "results": [{',
  '      "ruleId": "review-note",',
  '      "ruleIndex": 0,',
  '      "kind": "informational",',
  '      "level": "none",',
  '      "guid": "<a fresh UUID v4>",',
  '      "message": { "text": "<note body (markdown)>", "markdown": "<same body>" },',
  '      "locations": [{ "physicalLocation": {',
  '        "artifactLocation": { "uri": "<repo-relative source path>" },',
  '        "region": { "startLine": <A>, "endLine": <B>, "snippet": { "text": "<the anchored lines, verbatim>" } }',
  '      } }],',
  '      "properties": { "tags": ["<rationale|proof|assumption|alternative-considered|risk|test-evidence>"] },',
  '      "workItemUris": ["<HS-NNNN>"],',
  '      "partialFingerprints": { "prNoteAnchor/v1": "<optional, see below>" },',
  '      "attachments": [{ "artifactLocation": { "uri": "<optional proof artifact, e.g. .pr-notes/artifacts/<name>.mmd — see below>" } }]',
  '    }]',
  '  }]',
  '}',
  '```',
  '',
  'Details:',
  '',
  '- `level` is `"warning"` for the `risk` kind, `"none"` otherwise. `result.rank` (0–100 ' +
    'importance) and `result.properties["ext-ai-tool-confidence"]` (0–1) are optional.',
  '- Group results into runs by (producer, commit): reuse a run whose driver name + ' +
    '`revisionId` match yours, else append a new run to the shard.',
  '- The `prNoteAnchor/v1` fingerprint (optional but recommended — it lets Glassbox ' +
    're-anchor the note after edits): take the anchored lines, trim each and collapse ' +
    'inner whitespace to single spaces, join with `\\n` (NO trailing newline), then the ' +
    'first 32 hex chars of the SHA-256. Shell: ' +
    '`printf \'%s\' "$(sed -n \'<A>,<B>p\' <file> | sed -E \'s/^[[:space:]]+|[[:space:]]+$//g; s/[[:space:]]+/ /g\')" | shasum -a 256 | cut -c1-32`.',
  '- **Proof artifacts** (the optional `attachments`): when a claim is clearer shown than ' +
    'told, save the evidence under `.pr-notes/artifacts/` and reference it via ' +
    '`attachments[].artifactLocation.uri`. **When a diagram is the clearest proof or ' +
    'rationale — a state machine, data/control flow, sequence of interactions, or ' +
    'architecture relationship — write it as Mermaid SOURCE** (a `.mmd` file) and attach ' +
    'that; never a rendered diagram image, never ASCII art in the body. Test output/logs ' +
    'attach as plain text files. One artifact per claim, not per step.',
  '- Keep notes reflecting the FINAL state of your change: update or delete your own ' +
    'earlier results (match by `guid`) when the work evolves, and drop notes the finished ' +
    'diff made obvious.',
];
