/**
 * Manage Claude Code hooks in ~/.claude/settings.json for busy state detection.
 * Installs three hooks:
 * - PostToolUse: heartbeat indicating Claude is actively using tools
 * - UserPromptSubmit: Claude started processing (mark busy immediately)
 * - Stop: Claude finished processing (mark idle immediately)
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const HOOK_MARKER = 'hotsheet-heartbeat';

function getClaudeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

interface HookEntry {
  '//'?: string;
  type: string;
  command: string;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

interface ClaudeSettings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

function readClaudeSettings(): ClaudeSettings {
  const path = getClaudeSettingsPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ClaudeSettings;
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

function makeCommand(port: number, state: 'busy' | 'idle' | 'heartbeat'): string {
  // $CLAUDE_PROJECT_DIR is expanded by the shell at hook execution time.
  // Redirect output to /dev/null and background (&) so hooks don't slow Claude down.
  return `curl -s -X POST http://localhost:${port}/api/channel/heartbeat -H "Content-Type: application/json" -d '{"projectDir":"'$CLAUDE_PROJECT_DIR'","state":"${state}"}' >/dev/null 2>&1 & # ${HOOK_MARKER}`;
}

/** Install all three hooks (PostToolUse, UserPromptSubmit, Stop). */
export function installHeartbeatHook(port: number): void {
  if (isHeartbeatHookInstalled()) {
    updateHeartbeatHookPort(port);
    return;
  }

  const settings = readClaudeSettings();
  if (!settings.hooks) settings.hooks = {};

  const hookDefs: { event: string; state: 'busy' | 'idle' | 'heartbeat' }[] = [
    { event: 'PostToolUse', state: 'heartbeat' },
    { event: 'UserPromptSubmit', state: 'busy' },
    { event: 'Stop', state: 'idle' },
  ];

  for (const def of hookDefs) {
    if (!Array.isArray(settings.hooks[def.event])) settings.hooks[def.event] = [];
    (settings.hooks[def.event]).push({
      hooks: [{ '//': 'Hot Sheet', type: 'command', command: makeCommand(port, def.state), timeout: 5 }],
    });
  }

  writeClaudeSettings(settings);
  console.log('[hooks] Installed Claude Code hooks (PostToolUse, UserPromptSubmit, Stop)');
}

/** Update the port in all existing heartbeat hooks. */
function updateHeartbeatHookPort(port: number): void {
  const settings = readClaudeSettings();
  if (!settings.hooks) return;

  let changed = false;
  for (const groups of Object.values(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const hook of group.hooks) {
        if (hook.command.includes(HOOK_MARKER)) {
          const updated = hook.command.replace(/localhost:\d+/, `localhost:${port}`);
          if (updated !== hook.command) {
            hook.command = updated;
            changed = true;
          }
          if (hook['//'] === undefined) {
            hook['//'] = 'Hot Sheet';
            changed = true;
          }
        }
      }
    }
  }

  if (changed) {
    writeClaudeSettings(settings);
    console.log(`[hooks] Updated heartbeat hook port to ${port}`);
  }
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
