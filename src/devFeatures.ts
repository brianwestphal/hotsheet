// HS-9411 (docs/124) — the "In Development" feature gates.
//
// Each entry is a per-project, MACHINE-LOCAL boolean that defaults to FALSE. When
// off, the UI that connects to the feature is hidden; nothing is deleted and no
// server behavior changes. The point is that a half-built surface shouldn't be
// reachable by default (see `docs/feature-health.md` — every feature listed here
// is one of its Underbaked / Incomplete / Unknown rows).
//
// Pure + dependency-free so the server (settings schema, scope routing) and the
// client (settings UI, gate checks) share one source of truth.
//
// **Adding a gate:** add an entry below. The `dev_` prefix is what routes the key
// to the local layer in `defaultScope()` — a new toggle CANNOT accidentally become
// a shared/committed setting. **Removing a gate** (the feature graduated): delete
// the entry, drop its checks, and note it in docs/124 §124.6.

/** A gate's stable settings key. Always `dev_`-prefixed — see `defaultScope`. */
export type DevFeatureKey = `dev_${string}`;

export interface DevFeature {
  key: DevFeatureKey;
  /** Checkbox label in Settings → Experimental → In Development. */
  label: string;
  /** One line under the label: what turning it on exposes, and what's unfinished. */
  hint: string;
  /** For a gate that fronts an `ai_tool` value, the tool it corresponds to. */
  aiTool?: string;
}

export const DEV_FEATURES: readonly DevFeature[] = [
  {
    key: 'dev_parallel_workers',
    label: 'Parallel agent workers (git worktrees + worker pool)',
    hint: 'Worker-pool + in-flight panels, the auto-pool switch, dispatch-to-worker, and the "Run on…" command target picker. The pool manager is session-only in memory — its slot registry is lost on a server restart (docs/91 §91.9).',
  },
  {
    key: 'dev_tool_codex',
    label: 'Codex',
    hint: 'Drive Codex via its app-server protocol (docs/121). Shipped 2026-07-23 and still accruing fixes.',
    aiTool: 'codex',
  },
  {
    key: 'dev_tool_antigravity',
    label: 'Antigravity',
    hint: 'Drive Antigravity (`agy`) over MCP + hooks (docs/115). No automated end-to-end coverage.',
    aiTool: 'antigravity',
  },
  {
    key: 'dev_tool_opencode',
    label: 'OpenCode',
    hint: 'Drive OpenCode over ACP (docs/114). Live-validated once during development.',
    aiTool: 'opencode',
  },
  {
    key: 'dev_tool_gemini',
    label: 'Gemini CLI',
    hint: 'Instruction + skills generation only (docs/118 §118.4a) — there is no drive transport, so the play button will not work.',
    aiTool: 'gemini',
  },
  {
    key: 'dev_tool_goose',
    label: 'Goose',
    hint: 'Not implemented beyond command resolution — the ACP drive is deferred (HS-9347).',
    aiTool: 'goose',
  },
  {
    key: 'dev_remote_access',
    label: 'Remote access',
    hint: 'The Remote Access device panel (mint / QR-pair / revoke) and remote-project client surfaces (docs/94, docs/112). The client half is foundation-only. Does not affect mutual-TLS enforcement on an exposed bind — that is always on.',
  },
];

const BY_KEY = new Map<string, DevFeature>(DEV_FEATURES.map(f => [f.key, f]));
const BY_AI_TOOL = new Map<string, DevFeature>(
  DEV_FEATURES.filter(f => f.aiTool !== undefined).map(f => [f.aiTool as string, f]),
);

/** Is `key` one of the in-development gates? */
export function isDevFeatureKey(key: string): key is DevFeatureKey {
  return BY_KEY.has(key);
}

/** The gate fronting an `ai_tool` value, or null when the tool isn't gated
 *  (`auto`, `claude`, and the Tier-B editor tools are never gated). */
export function devFeatureForAiTool(aiTool: string): DevFeature | null {
  return BY_AI_TOOL.get(aiTool.trim().toLowerCase()) ?? null;
}

/**
 * Read a gate out of a resolved file-settings record. **Default false** — absent,
 * non-boolean, or unknown key all mean "off". Deliberately strict: a gate that
 * fails open would defeat the entire point.
 */
export function isDevFeatureEnabled(resolved: Record<string, unknown>, key: DevFeatureKey): boolean {
  return resolved[key] === true;
}

/**
 * Should the `ai_tool` option for `tool` be offered?
 *
 * `enabled` is the gate state; `currentTool` is the project's saved `ai_tool`.
 * An ungated tool is always offered. A gated one is offered when its gate is on
 * **or when the project is already set to it** — hiding the selected value would
 * silently switch a project that currently works (HS-9411 maintainer decision).
 */
export function isAiToolSelectable(tool: string, enabled: boolean, currentTool: string): boolean {
  if (devFeatureForAiTool(tool) === null) return true;
  if (enabled) return true;
  return tool.trim().toLowerCase() === currentTool.trim().toLowerCase();
}

/** Suffix appended to a gated tool's dropdown label when it is only listed
 *  because the project already selected it. */
export const IN_DEVELOPMENT_OPTION_SUFFIX = ' — in development';
