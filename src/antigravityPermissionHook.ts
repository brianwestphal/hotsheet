// HS-9327 — the PreToolUse permission hook for Antigravity (`agy`), the interactive
// alternative to `--dangerously-skip-permissions`. agy runs this as a shell command
// before each tool call (installed via `.agents/hooks.json`, gated on the
// `antigravity_interactive_permissions` setting).
//
// HS-9506 (docs/132 §132.9.1) — the FLOW (parse stdin → inject into the §47 overlay →
// poll for the decision → emit; fail-open on an unreachable channel, fail-closed on a
// timeout) now lives in the host toolkit, `aiTools/permissionHook.ts`. It used to live
// HERE, which meant `codexPermissionHook.ts` imported its core logic from a module
// named after a different tool, and agy's label and wire shape were the generic
// defaults. This file is now just agy's ADAPTER — the same size and shape as codex's.

import { claudeStyleDecisionJson, type PermissionHookAdapter } from './aiTools/permissionHook.js';

/**
 * agy's PreToolUse decision JSON.
 *
 * The event name is hard-coded rather than echoed from the payload (which is what
 * codex's adapter does) because agy sends only PreToolUse — the two are identical in
 * practice today. Kept as-is deliberately: HS-9506 was a move, and changing agy's
 * emitted wire shape on the way past would have been an unrelated, unverifiable
 * behavior change buried in a refactor.
 */
export function decisionJson(decision: 'allow' | 'deny'): string {
  return claudeStyleDecisionJson(decision, 'PreToolUse');
}

/**
 * agy's adapter. Exit 2 on deny is what agy reads as "blocked" — note this is the
 * OPPOSITE of codex, which treats any non-zero exit as "the hook failed, proceed".
 */
export function antigravityHookAdapter(): PermissionHookAdapter {
  return {
    agentLabel: 'Antigravity',
    emit: (decision) => ({ stdout: decisionJson(decision), exitCode: decision === 'deny' ? 2 : 0 }),
  };
}
