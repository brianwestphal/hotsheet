// HS-9359 — the interactive-permission hook for Codex, the §47-overlay alternative
// to `--dangerously-bypass-approvals-and-sandbox`. Codex runs it (installed in the
// project's `.codex/hooks.json`, gated on the `codex_interactive_permissions`
// setting) for two events, both verified live on codex-cli 0.145.0:
//
//  - **PreToolUse** — before each mutating tool call (matcher-scoped to
//    `Bash|apply_patch|Edit|Write`); decision = the same
//    `hookSpecificOutput.permissionDecision` shape agy/Claude use.
//  - **PermissionRequest** — when codex would ask for approval (e.g. an MCP tool
//    call under `--sandbox workspace-write`, which exec mode otherwise
//    auto-cancels: "user cancelled MCP tool call"); decision =
//    `hookSpecificOutput.decision.{behavior,message}`. Hot Sheet's own
//    `hotsheet_*` MCP calls are auto-ALLOWED without the overlay — gating our own
//    control-plane machinery would spam the user.
//
// ⚠ Codex treats a NON-ZERO hook exit as "hook failed, proceed" (verified: a deny
// with exit 2 did NOT block; the same deny with exit 0 did) — so unlike agy, every
// decision exits 0 and the stdout JSON alone carries it.
//
// HS-9506 — the shared flow and the real-IO block live in the host toolkit
// (`aiTools/permissionHook.ts`). They used to live in `antigravityPermissionHook.ts`,
// so this module imported its core logic from a module named after another tool.
import { claudeStyleDecisionJson, type PermissionHookAdapter, realPermissionHookIo, runPermissionHook } from './aiTools/permissionHook.js';

/** The codex stdout decision JSON for an event. `PermissionRequest` uses the
 *  `decision.{behavior}` shape; everything else the shared `permissionDecision`
 *  shape, echoing the incoming event name. Exported for testing. */
export function codexDecisionJson(decision: 'allow' | 'deny', eventName: string): string {
  if (eventName === 'PermissionRequest') {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: decision } } });
  }
  return claudeStyleDecisionJson(decision, eventName);
}

/** Hot Sheet's own control-plane MCP tools — allowed without the overlay. Codex
 *  normalizes the server name into the tool id (`mcp__hotsheet_channel__hotsheet_*`,
 *  underscores — verified live). Exported for testing. */
export function isHotsheetControlTool(toolName: string): boolean {
  return toolName.startsWith('mcp__hotsheet') || toolName.startsWith('hotsheet_');
}

/** Codex's adapter. Note `exitCode: 0` even on DENY — see the module note. */
export function codexHookAdapter(): PermissionHookAdapter {
  return {
    agentLabel: 'Codex',
    emit: (decision, eventName) => ({ stdout: codexDecisionJson(decision, eventName), exitCode: 0 }),
    autoAllow: isHotsheetControlTool,
  };
}

/** Run the codex permission hook with real IO. Always exits 0 (see module note);
 *  the stdout JSON carries the decision. */
export function runCodexPermissionHookCli(): Promise<number> {
  return runPermissionHook(realPermissionHookIo(), codexHookAdapter());
}
