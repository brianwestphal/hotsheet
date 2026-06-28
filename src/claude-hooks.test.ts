/**
 * HS-9133 — Claude Code heartbeat-hook management (`claude-hooks.ts`). Points
 * `$HOME` at a temp dir (os.homedir() honors $HOME on POSIX) so the real fs
 * read/write/backup logic runs against a throwaway `~/.claude/settings.json`.
 */
import { existsSync, mkdirSync,mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installHeartbeatHook, isHeartbeatHookInstalled, removeHeartbeatHook } from './claude-hooks.js';

let home: string;
const realHome = process.env.HOME;
const settingsPath = (): string => join(home, '.claude', 'settings.json');
const readSettings = (): { hooks?: Record<string, unknown[]> } => {
  const v: unknown = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
  return v as { hooks?: Record<string, unknown[]> };
};
function writeSettings(obj: unknown): void {
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(obj, null, 2), 'utf-8');
}

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'hs-hooks-')); process.env.HOME = home; });
afterEach(() => { process.env.HOME = realHome; rmSync(home, { recursive: true, force: true }); });

describe('isHeartbeatHookInstalled', () => {
  it('false when no settings file exists', () => {
    expect(isHeartbeatHookInstalled()).toBe(false);
  });
  it('false when hooks exist but none carry the marker', () => {
    writeSettings({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } });
    expect(isHeartbeatHookInstalled()).toBe(false);
  });
});

describe('installHeartbeatHook', () => {
  it('installs the three heartbeat hooks at the given port', () => {
    installHeartbeatHook(4174);
    expect(isHeartbeatHookInstalled()).toBe(true);
    const s = readSettings();
    expect(Object.keys(s.hooks!).sort()).toEqual(['PostToolUse', 'Stop', 'UserPromptSubmit']);
    const raw = readFileSync(settingsPath(), 'utf-8');
    expect(raw).toContain('hotsheet-heartbeat');
    expect(raw).toContain('localhost:4174');
  });

  it('is idempotent: a second install updates the port in place, no duplicates', () => {
    installHeartbeatHook(4174);
    installHeartbeatHook(5000);
    const s = readSettings();
    // Still exactly one group per event.
    expect((s.hooks!.PostToolUse).length).toBe(1);
    const raw = readFileSync(settingsPath(), 'utf-8');
    expect(raw).toContain('localhost:5000');
    expect(raw).not.toContain('localhost:4174');
  });

  it('preserves unrelated settings + backs up the prior file', () => {
    writeSettings({ model: 'opus', hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'echo keep' }] }] } });
    installHeartbeatHook(4174);
    const s = readSettings() as { model?: string; hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(s.model).toBe('opus');
    // The pre-existing non-marker hook survives alongside the new one.
    const cmds = s.hooks.PostToolUse.flatMap(g => g.hooks.map(h => h.command));
    expect(cmds.some(c => c.includes('echo keep'))).toBe(true);
    expect(cmds.some(c => c.includes('hotsheet-heartbeat'))).toBe(true);
    expect(existsSync(settingsPath() + '.bak')).toBe(true);
  });
});

describe('removeHeartbeatHook', () => {
  it('removes only the marker hooks, keeping unrelated ones', () => {
    writeSettings({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'echo keep' }] }] } });
    installHeartbeatHook(4174);
    removeHeartbeatHook();
    expect(isHeartbeatHookInstalled()).toBe(false);
    const s = readSettings() as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    const cmds = s.hooks.PostToolUse.flatMap(g => g.hooks.map(h => h.command));
    expect(cmds).toEqual(['echo keep']);
  });

  it('drops the whole hooks key when nothing remains', () => {
    installHeartbeatHook(4174);
    removeHeartbeatHook();
    expect(readSettings().hooks).toBeUndefined();
  });

  it('is a no-op when no marker hooks are present', () => {
    writeSettings({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo x' }] }] } });
    expect(() => removeHeartbeatHook()).not.toThrow();
    expect(readSettings().hooks).toBeDefined();
  });
});
