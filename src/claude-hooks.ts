/**
 * Manage Claude Code hooks in ~/.claude/settings.json for busy state detection.
 * Installs four hooks (all verified against Claude Code 2.1.x):
 * - UserPromptSubmit: Claude started processing (mark busy immediately)
 * - PreToolUse: a tool call is starting (HS-9262 — extra heartbeat at tool
 *   start, so busy re-arms the instant work begins even between prompts)
 * - PostToolUse: heartbeat indicating Claude is actively using tools
 * - Stop: Claude finished processing (mark idle immediately)
 *
 * HS-9262 — the client also gates busy on the PTY spinner (`busyStaleDecision`),
 * so a long single tool call (no intervening PostToolUse) no longer prematurely
 * clears busy, and a dropped `Stop` self-heals once the spinner goes quiet.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { z } from 'zod';

const HOOK_MARKER = 'hotsheet-heartbeat';

function getClaudeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

// HS-8567 — zod-validated settings shape. `.loose()` so unknown keys pass
// through (this file mutates a small subset and rewrites the whole file;
// preserving unrelated user keys is essential).
const HookEntrySchema = z.object({
  '//': z.string().optional(),
  type: z.string(),
  command: z.string(),
  timeout: z.number().optional(),
}).loose();
const HookGroupSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(HookEntrySchema),
}).loose();
const ClaudeSettingsSchema = z.object({
  hooks: z.record(z.string(), z.array(HookGroupSchema)).optional(),
}).loose();
type ClaudeSettings = z.infer<typeof ClaudeSettingsSchema>;

function readClaudeSettings(): ClaudeSettings {
  const path = getClaudeSettingsPath();
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const result = ClaudeSettingsSchema.safeParse(raw);
    return result.success ? result.data : {};
  } catch {
    return {};
  }
}

function writeClaudeSettings(settings: ClaudeSettings): void {
  const path = getClaudeSettingsPath();
  mkdirSync(join(homedir(), '.claude'), { recursive: true });
  if (existsSync(path)) {
    copyFileSync(path, path + '.bak');
  }
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

/** Check if our hooks are already installed. */
export function isHeartbeatHookInstalled(): boolean {
  const settings = readClaudeSettings();
  if (!settings.hooks) return false;
  for (const groups of Object.values(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (group.hooks.some(h => h.command.includes(HOOK_MARKER))) return true;
    }
  }
  return false;
}

/** The four hook events + the heartbeat state each reports (HS-9262 added PreToolUse). */
const HOOK_DEFS: { event: string; state: 'busy' | 'idle' | 'heartbeat' }[] = [
  { event: 'PostToolUse', state: 'heartbeat' },
  { event: 'PreToolUse', state: 'heartbeat' }, // HS-9262 — heartbeat at tool start
  { event: 'UserPromptSubmit', state: 'busy' },
  { event: 'Stop', state: 'idle' },
];

/**
 * HS-9263 — build the hook command. A SINGLE global hook that ROUTES per project
 * across Hot Sheet instances: at execution time it reads the serving instance's
 * `port` from the project's own `<CLAUDE_PROJECT_DIR>/.hotsheet/settings.local.json`
 * and the project `secret` from `secret.json`, then POSTs the SECRET (the exact
 * identity used everywhere else, not a fuzzy `$CLAUDE_PROJECT_DIR` prefix match) to
 * that instance's heartbeat endpoint. So the §87 test instance (`HOTSHEET_HOME`)
 * or a second `hotsheet` on another port each receive only their own sessions'
 * signals, and a port change is picked up automatically (no baked-in port to go
 * stale — which also hardens the `Stop`→idle signal per HS-9262).
 *
 * Uses `node` (guaranteed present wherever Claude Code + Hot Sheet run) so the JSON
 * reads + the POST are cross-platform; any error (not a Hot Sheet project, an old
 * node without global `fetch`, or the instance being down) degrades to a silent
 * no-op. The JS uses only single quotes so the whole script nests inside the
 * double-quoted `node -e "…"` with no shell-expansion surprises; the POSIX `&` +
 * redirect keep it off Claude's critical path, matching the prior curl hooks.
 */
function makeCommand(state: 'busy' | 'idle' | 'heartbeat'): string {
  const js =
    "const fs=require('fs'),d=process.env.CLAUDE_PROJECT_DIR;" +
    "try{" +
    "const p=JSON.parse(fs.readFileSync(d+'/.hotsheet/settings.local.json','utf8')).port;" +
    "const s=JSON.parse(fs.readFileSync(d+'/.hotsheet/secret.json','utf8')).secret;" +
    "fetch('http://localhost:'+p+'/api/channel/heartbeat',{method:'POST',headers:{'content-type':'application/json'}," +
    "body:JSON.stringify({secret:s,projectDir:d,state:'" + state + "'})}).then(()=>process.exit(0),()=>process.exit(0));" +
    "}catch(e){process.exit(0)}";
  return `node -e "${js}" >/dev/null 2>&1 & # ${HOOK_MARKER}`;
}

/** The marker commands the current version wants installed, keyed by event. */
function desiredMarkerCommands(): Map<string, string> {
  return new Map(HOOK_DEFS.map(d => [d.event, makeCommand(d.state)]));
}

/** The marker commands currently present (only OUR hooks), keyed by event. */
function currentMarkerCommands(settings: ClaudeSettings): Map<string, string> {
  const out = new Map<string, string>();
  if (!settings.hooks) return out;
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const h of group.hooks) {
        if (h.command.includes(HOOK_MARKER)) out.set(event, h.command);
      }
    }
  }
  return out;
}

/**
 * Install / refresh the heartbeat hooks. Idempotent AND self-migrating: a no-op
 * when the installed marker hooks already match the current command set (same
 * events, identical commands); otherwise it strips every marker hook (dropping
 * legacy baked-port `curl` commands from earlier versions) and re-adds the current
 * four, preserving all non-marker user hooks. No `port` argument — the command
 * resolves the serving instance's port from the project's `.hotsheet` at runtime.
 */
export function installHeartbeatHook(): void {
  const settings = readClaudeSettings();
  const desired = desiredMarkerCommands();
  const current = currentMarkerCommands(settings);
  if (current.size === desired.size && [...desired].every(([e, cmd]) => current.get(e) === cmd)) {
    return; // already up to date
  }

  const hooks = settings.hooks ?? {};
  // Strip existing marker hooks from every event (migrates legacy commands).
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const filtered = groups.filter(g => !g.hooks.some(h => h.command.includes(HOOK_MARKER)));
    if (filtered.length === 0) Reflect.deleteProperty(hooks, event);
    else hooks[event] = filtered;
  }
  // Add the current marker hooks (each event gets a group wrapping one hook).
  for (const [event, command] of desired) {
    if (!Array.isArray(hooks[event])) hooks[event] = [];
    (hooks[event]).push({ hooks: [{ '//': 'Hot Sheet', type: 'command', command, timeout: 5 }] });
  }
  settings.hooks = hooks;
  writeClaudeSettings(settings);
  console.log('[hooks] Installed Claude Code hooks (UserPromptSubmit, PreToolUse, PostToolUse, Stop) — per-project routing via .hotsheet');
}

/** Remove all heartbeat hooks. */
export function removeHeartbeatHook(): void {
  const settings = readClaudeSettings();
  if (!settings.hooks) return;

  let changed = false;
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    const filtered = groups.filter(group =>
      !group.hooks.some(h => h.command.includes(HOOK_MARKER)),
    );
    if (filtered.length !== groups.length) {
      changed = true;
      if (filtered.length === 0) {
        // Use Reflect.deleteProperty instead of delete for dynamic keys
        Reflect.deleteProperty(settings.hooks, event);
      } else {
        settings.hooks[event] = filtered;
      }
    }
  }

  if (!changed) return;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeClaudeSettings(settings);
  console.log('[hooks] Removed Claude Code heartbeat hooks');
}
