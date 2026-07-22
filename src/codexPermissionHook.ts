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
// The shared flow (stdin parse → §47 inject → poll decision → emit; fail-open on
// no channel, fail-closed on timeout) lives in `antigravityPermissionHook.ts` —
// this module supplies only the codex-specific pieces.
import { randomUUID } from 'crypto';
import { join } from 'path';

import { type PermissionHookOpts, runPermissionHook } from './antigravityPermissionHook.js';
import { getChannelPort } from './channel-config.js';

/** The codex stdout decision JSON for an event. `PermissionRequest` uses the
 *  `decision.{behavior}` shape; everything else the `permissionDecision` shape.
 *  Exported for testing. */
export function codexDecisionJson(decision: 'allow' | 'deny', eventName: string): string {
  if (eventName === 'PermissionRequest') {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: decision } } });
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, permissionDecision: decision } });
}

/** Hot Sheet's own control-plane MCP tools — allowed without the overlay. Codex
 *  normalizes the server name into the tool id (`mcp__hotsheet_channel__hotsheet_*`,
 *  underscores — verified live). Exported for testing. */
export function isHotsheetControlTool(toolName: string): boolean {
  return toolName.startsWith('mcp__hotsheet') || toolName.startsWith('hotsheet_');
}

/** The codex-specific opts for the shared permission-hook flow. */
export function codexHookOpts(): PermissionHookOpts {
  return {
    agentLabel: 'Codex',
    emit: (decision, eventName) => ({ stdout: codexDecisionJson(decision, eventName), exitCode: 0 }),
    autoAllow: isHotsheetControlTool,
  };
}

/** Read all of stdin (codex pipes the hook payload). Resolves on `end`, on
 *  error, or after a short cap so a hook with nothing piped can't hang. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const stdin = process.stdin;
    stdin.setEncoding('utf-8');
    stdin.on('data', (c: string | Buffer) => { data += typeof c === 'string' ? c : c.toString('utf-8'); });
    stdin.on('end', () => resolve(data));
    stdin.on('error', () => resolve(data));
    setTimeout(() => resolve(data), 2000).unref();
  });
}

/** Run the codex permission hook with real IO. Always exits 0 (see module note);
 *  the stdout JSON carries the decision. */
export function runCodexPermissionHookCli(): Promise<number> {
  const dataDir = join(process.cwd(), '.hotsheet'); // codex runs hooks in the project dir
  return runPermissionHook({
    readStdin,
    channelBaseUrl: () => {
      const port = getChannelPort(dataDir);
      return port !== null && port > 0 ? `http://localhost:${String(port)}` : null;
    },
    writeStdout: (s) => { process.stdout.write(s); },
    fetchFn: fetch,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    newRequestId: () => randomUUID(),
  }, undefined, codexHookOpts());
}
