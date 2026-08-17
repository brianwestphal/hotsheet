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
//
// HS-9515 — the PER-TOOL gates (`dev_tool_codex`, `_antigravity`, `_opencode`,
// `_gemini`, `_goose`) are gone. Maintainer decision 2026-07-31: now that each AI
// tool is an `AiToolPlugin` (docs/132), readiness is managed by not shipping a
// plugin publicly and by labeling early releases alpha/beta — not by a runtime gate
// every user carries. That also removes the asymmetry that prompted this: the
// dropdown kept a gated tool selectable when the project already used it, while
// `applyDevFeatureGates` hid its settings unconditionally, so a project could show
// a tool selected with no way to configure it.
//
// What remains here gates FEATURES, not tools — which is what this mechanism is for.

/** A gate's stable settings key. Always `dev_`-prefixed — see `defaultScope`. */
export type DevFeatureKey = `dev_${string}`;

export interface DevFeature {
  key: DevFeatureKey;
  /** Checkbox label in Settings → Experimental → In Development. */
  label: string;
  /** One line under the label: what turning it on exposes, and what's unfinished. */
  hint: string;
}

export const DEV_FEATURES: readonly DevFeature[] = [
  {
    // HS-9517 — the ONE gate that replaced the five per-tool ones. It gates a FEATURE
    // (seeing integrations we have not shipped), not a tool, which is why it belongs
    // here where the per-tool flags did not: maturity is a property of the integration,
    // the same on every machine, while those were per-project flags standing in for
    // "we haven't finished this yet".
    key: 'dev_unreleased_ai_tools',
    label: 'Unreleased AI tools',
    hint: 'Adds the AI-tool integrations that are not shipped publicly (Antigravity, OpenCode, Gemini CLI, Goose) to Settings → AI Tools so they can be enabled. They are untested: Gemini has no drive at all, and Goose is unimplemented beyond command resolution — the play button will not work for either.',
  },
  {
    key: 'dev_remote_access',
    label: 'Remote access',
    hint: 'The Remote Access device panel (mint / QR-pair / revoke) and remote-project client surfaces (docs/94, docs/112). The client half is foundation-only. Does not affect mutual-TLS enforcement on an exposed bind — that is always on.',
  },
];

const BY_KEY = new Map<string, DevFeature>(DEV_FEATURES.map(f => [f.key, f]));

/** Is `key` one of the in-development gates? */
export function isDevFeatureKey(key: string): key is DevFeatureKey {
  return BY_KEY.has(key);
}

/**
 * Read a gate out of a resolved file-settings record. **Default false** — absent,
 * non-boolean, or unknown key all mean "off". Deliberately strict: a gate that
 * fails open would defeat the entire point.
 */
export function isDevFeatureEnabled(resolved: Record<string, unknown>, key: DevFeatureKey): boolean {
  return resolved[key] === true;
}

