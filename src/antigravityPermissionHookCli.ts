// HS-9327 — real-IO wiring for the Antigravity PreToolUse permission hook. Invoked as
// `<cli> __agy-permission-hook` by agy before each tool call; resolves the channel
// server for the CWD project and runs the interactive permission flow, returning the
// process exit code (0 = allow, 2 = deny).
//
// HS-9506 — the concrete IO block (stdin reader, channel-port resolution, fetch, clock)
// was written out verbatim here AND in `codexPermissionHook.ts`; it is now
// `realPermissionHookIo()` in the host toolkit. Only the adapter differs per agent.
import { realPermissionHookIo, runPermissionHook } from './aiTools/permissionHook.js';
import { antigravityHookAdapter } from './antigravityPermissionHook.js';

/** Run the permission hook with real IO. Returns 0 (allow) / 2 (deny). */
export function runAgyPermissionHookCli(): Promise<number> {
  return runPermissionHook(realPermissionHookIo(), antigravityHookAdapter());
}
