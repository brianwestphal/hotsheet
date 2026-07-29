// HS-9490 (docs/132 §132.4) — the AI-tool plugin interface: ONE contract every
// supported tool implements, replacing the dozen per-tool tables and `if (tool === …)`
// branches inventoried in docs/132 §132.1.
//
// PHASE 1 lands identity only. The capability fields are declared here so the shape is
// settled and reviewable, but no plugin populates them yet — docs/132 §132.8 moves one
// concern per phase, and the value of that phasing is that each step leaves the tree
// green. Adding a capability to this file without a phase behind it just moves the
// scattering somewhere new.
//
// **This module and everything it pulls in must stay client-safe** — no `fs`, no `path`,
// no node builtins. `agentDisplayName.ts` consumes the registry and is re-exported into
// the client bundle (`src/client/agentName.ts`), so a filesystem import here would break
// the build. That constraint is why `detect` is DATA (a `DetectionSpec`) evaluated by a
// server-side helper rather than a `(projectRoot) => boolean` closure; see `detect.ts`.

import type { DevFeatureKey } from '../devFeatures.js';

/**
 * How to tell whether a project uses this tool, expressed as data so the pure registry
 * stays free of `fs`. Evaluated by `detect.ts::detectsTool` (server-side) as:
 *
 *   any binary on PATH  OR  any path present under the project root
 *
 * Every one of the nine existing predicates is exactly that shape — they were written
 * independently in `aiInstructionsTools.ts` and `skills.ts` and all landed on the same
 * form, which is the evidence it generalizes rather than a guess about future tools.
 */
export interface DetectionSpec {
  /** Executables to probe on PATH (e.g. `agy` for Antigravity). */
  binaries: readonly string[];
  /** Project-root-relative paths whose existence implies the tool (file or directory). */
  paths: readonly string[];
}

/** docs/113 §113.2 — A: a CLI agent Hot Sheet can drive. B: an editor tool we only
 *  supply rules/instructions to. Drives which surfaces are even applicable. */
export type AiToolTier = 'cli-agent' | 'editor';

export interface AiToolPlugin {
  /** The `ai_tool` setting value. Lowercase; the registry key. */
  readonly id: string;
  /**
   * SHORT label for running-text UI — the busy indicator ("Codex working") and the
   * Commands Log done entry ("Codex finished").
   *
   * Distinct from `productName` because the two genuinely differ for three tools, and
   * collapsing them would change user-visible strings: "Claude"/"Claude Code",
   * "Gemini"/"Gemini CLI", "Copilot"/"GitHub Copilot". The short form reads correctly in
   * a sentence; the full form is what you pick in a settings dropdown.
   */
  readonly displayName: string;
  /** FULL product name for pickers and settings copy. */
  readonly productName: string;
  readonly tier: AiToolTier;
  /**
   * docs/124 — the In-Development gate fronting this tool, or null when it is generally
   * available (claude + the Tier-B editor tools). The key is duplicated from
   * `DEV_FEATURES` rather than derived, and `registry.test.ts` fails if the two drift —
   * the same derive-and-pin approach that caught the HS-9322/9344 wire-enum drift.
   */
  readonly devGateKey: DevFeatureKey | null;
  /** Declarative detection (see `DetectionSpec`). */
  readonly detection: DetectionSpec;
}
