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
import type { AgentTransport } from '../agentBackendParse.js';
import type { TokenMetricMap } from './tokenMetrics.js';

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

/**
 * HS-9517 — how far along this integration is, which decides whether users see it.
 *
 * - `stable`     — shipped and trusted. Selectable once enabled.
 * - `beta`       — shipped, works, still settling. Selectable once enabled, badged BETA.
 * - `unreleased` — NOT shipped publicly. Hidden from the AI Tools list entirely unless
 *                  the Settings → Experimental gate is on.
 *
 * This replaces the five per-tool `dev_tool_*` gates HS-9515 removed, and is a better
 * fit: maturity is a property of the INTEGRATION, the same on every machine, whereas
 * those were per-project runtime flags each user carried. Enablement — a user's choice —
 * is tracked separately, per project.
 */
export type AiToolMaturity = 'stable' | 'beta' | 'unreleased';

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
   * HS-9517 — shipped-ness. `unreleased` keeps an untested integration away from users
   * without a per-project flag; see `AiToolMaturity`.
   */
  readonly maturity: AiToolMaturity;
  /** Declarative detection (see `DetectionSpec`). */
  readonly detection: DetectionSpec;
  /**
   * HS-9491 — the tool's managed-instructions file, or absent when it has no
   * instruction convention we have verified (goose today; see docs/118 §118.6).
   */
  readonly instructions?: InstructionsCapability;
  /**
   * HS-9508 — which drive protocol this tool speaks (docs/117), or absent when we do
   * not drive it at all (`resolveAgentTransport` then answers `claude-channel`).
   *
   * Lives HERE rather than on the server-side drive because it is IDENTITY, not
   * behavior: "codex speaks MCP+hooks" is a fact about codex, true whether or not this
   * process can spawn it. Putting it on the plugin also makes it client-safe, which is
   * what let `client/agentBackend.ts` delete its hand-synced mirror of the transport
   * table — a second copy that nothing pinned against the server's.
   */
  readonly transport?: AgentTransport;
  /**
   * HS-9497 (docs/132 §132.9.2) — per-tool settings the Settings dialog renders and
   * reveals when this tool is selected. Absent when the tool has none.
   *
   * Declaring these removes the three hand-written places a toggle used to live: the
   * `<div class="settings-field" style="display:none">` in `pages.tsx`, the `byIdOrNull`
   * binding, and the `revealAgyPerms` tool-id branch.
   */
  readonly preferences?: readonly AiToolPreference[];
  /**
   * HS-9602 — the OTLP metric/event-name prefix this tool emits under
   * (`claude_code.` / `codex.`). Absent = we cannot attribute its telemetry.
   *
   * Lives here rather than in a lookup table beside the ingest code for the
   * §132 reason: a tool is defined in ONE place. This is the first, narrowest
   * slice of the fuller `telemetry` capability HS-9603 will add (counter names,
   * cumulative-vs-delta, prompt-lifecycle events) — deliberately just the
   * namespace, because that is all attribution needs and the rest depends on
   * questions not yet settled (e.g. whether codex reports cost at all).
   */
  readonly telemetryMetricPrefix?: string;
  /**
   * HS-9604 — this tool's token counters, mapped to their `otel_rollup_daily`
   * column (see `tokenMetrics.ts`).
   *
   * Absent means the tool contributes no token aggregates. The map's `'ignore'`
   * routing is load-bearing rather than decorative: codex's counters are
   * NESTED (`cached_input_tokens` is inside `input_tokens`), so the inclusive
   * parents must be positively excluded or a summed total doubles. Claude's are
   * disjoint by construction, which is why the two tools' maps look so
   * different for what reads like the same data.
   */
  readonly telemetryTokenMetrics?: TokenMetricMap;
  /**
   * HS-9601 (docs/90 §90.5) — worker-pool support. **Absent means unsupported**,
   * which is the §132.9 pattern and is what `assertWorkerLaunchSupported` now
   * asks instead of testing tool ids.
   *
   * Only the LAUNCH LINE lives here, because that turned out to be the only
   * genuinely per-tool piece. A worktree's worker skill and its permission
   * bridge are already written by `ensureSkillsForDir`, which iterates this
   * same registry — so a tool that declares `skills` + `permissions` gets both
   * for free and needs no worker-specific wiring.
   *
   * Maintainer decision (2026-08-05): a non-Claude worker is a **PTY running
   * the agent CLI**, like Claude's, rather than a headless drive session — so
   * this returns a command string and the existing pool machinery (tiles,
   * drain, `pending_integration`) applies unchanged.
   */
  readonly worker?: {
    /**
     * The terminal command that boots a worker in a prepared worktree.
     *
     * `ownerDataDir` is the OWNER's `.hotsheet` (the shared instance the worker
     * reports into), NOT the worktree's — the worktree is a follower.
     */
    launchCommand(ownerDataDir: string): string;
    /**
     * The executable the launch line starts, so the pool can verify it exists
     * BEFORE registering a slot.
     *
     * HS-9594's whole failure was that a PTY exists whether or not the command
     * in it resolves: a codex project got a `claude …` line, the shell reported
     * command-not-found into a terminal nobody was reading, and the slot
     * registered and counted as live anyway. Checking the binary does not prove
     * the agent STARTED, but it turns the one failure actually observed into a
     * refusal with a reason.
     */
    binary: string;
  };
  /**
   * HS-9605 — whether this tool reports COST in its telemetry, not just tokens.
   *
   * Absent/false means the cost surfaces must show "unavailable" rather than a
   * zero for its work. Codex is the reason this exists: it reports tokens in
   * detail and cost never (verified against codex-cli 0.146.0 — zero `*.cost*`
   * metrics), and no OTel semantic convention covers cost.
   *
   * Fails toward honesty: only an explicit `true` is treated as "reports cost",
   * so a newly-added tool cannot accidentally claim its work was free.
   */
  readonly telemetryReportsCost?: boolean;
}

/**
 * HS-9497 — one per-tool setting, as DATA (this module is client-safe; see the header).
 *
 * Deliberately narrow: `boolean` is the only type, because both real cases are booleans
 * and inventing select/text/combo variants ahead of a tool that needs one is the
 * single-implementer trap docs/132 §132.11.2 describes. Widen when a tool actually asks.
 */
export interface AiToolPreference {
  /** The `FileSettings` key. Stays a static zod field — see `aiToolPreferences.test.ts`,
   *  which fails if a declared key is missing from the schema, so the two cannot drift. */
  readonly key: string;
  readonly label: string;
  /**
   * Hint text. Supports a tiny inline subset — `` `code` `` and `**bold**` — so the
   * declaration keeps the formatting the hand-written HTML had. Rendered escape-first
   * (`formatPrefDescription`), so the markup is ours and never the string's.
   */
  readonly description?: string;
  readonly type: 'boolean';
  /**
   * The value when the key is ABSENT — and it is genuinely per-tool, not a constant:
   * antigravity's permissions default OFF (`=== true`) while codex's default ON
   * (`!== false`). Getting this wrong silently flips the toggle for every existing
   * project, which is why it is required rather than defaulted to `false`.
   */
  readonly default: boolean;
}

/**
 * HS-9491 (docs/132 §132.3) — WHERE a tool's managed sections live and in what
 * shape. Pure DATA: the machinery that reads and writes those sections (markers,
 * versioning, `applyManagedSections`, `planAdapterConversion`) is generic and stays
 * in `aiInstructions.ts` / `aiInstructionsTools.ts`. If a plugin ever needs to own
 * section logic, the split is wrong.
 *
 * Data-only is also what keeps this on the plugin at all — `plugins/**` must not
 * import node builtins (see the header), and every field here is a string.
 */
export interface InstructionsCapability {
  /** Project-root-relative path, e.g. `CLAUDE.md`, `.cursor/rules/hotsheet-instructions.mdc`. */
  readonly relPath: string;
  /** YAML frontmatter written only when CREATING the file; '' for plain markdown.
   *  An existing file's frontmatter is preserved on update. */
  readonly frontmatter: string;
  /**
   * docs/118 — the skills root the THIN ADAPTER section points at, or null when the
   * tool always gets the full managed sections. Non-null marks the adapter family:
   * when a canonical Claude source exists, this tool's file gets a reference to it
   * instead of a duplicate.
   *
   * Per FILE, not per tool — the AGENTS.md-sharing tools all say `.agents/skills`
   * (one text per file, so no rewrite ping-pong), while gemini's `GEMINI.md` says
   * `.gemini/skills`, its real discovery root.
   */
  readonly adapterSkillsRoot: string | null;
}
