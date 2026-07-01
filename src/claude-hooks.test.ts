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
  it('installs the four port-less, per-project-routing hooks (HS-9262 PreToolUse + HS-9263 routing)', () => {
    installHeartbeatHook();
    expect(isHeartbeatHookInstalled()).toBe(true);
    const s = readSettings();
    expect(Object.keys(s.hooks!).sort()).toEqual(['PostToolUse', 'PreToolUse', 'Stop', 'UserPromptSubmit']);
    const raw = readFileSync(settingsPath(), 'utf-8');
    expect(raw).toContain('hotsheet-heartbeat');
    // HS-9263 — reads the serving instance's port + secret from the project's own
    // .hotsheet at runtime; no baked-in port number.
    expect(raw).toContain('settings.local.json');
    expect(raw).toContain('secret.json');
    expect(raw).not.toMatch(/localhost:\d+/); // no hard-coded port
  });

  it('is idempotent: a second install is a no-op, no duplicates', () => {
    installHeartbeatHook();
    const first = readFileSync(settingsPath(), 'utf-8');
    installHeartbeatHook();
    const second = readFileSync(settingsPath(), 'utf-8');
    expect(second).toBe(first); // unchanged
    expect((readSettings().hooks!.PostToolUse).length).toBe(1); // still one group per event
  });

  it('HS-9263 — migrates a legacy baked-port curl hook to the port-less node command', () => {
    // Simulate an old install: a marker hook with a hard-coded port + curl.
    writeSettings({ hooks: { PostToolUse: [{ hooks: [{ '//': 'Hot Sheet', type: 'command', command: 'curl -s http://localhost:4174/api/channel/heartbeat # hotsheet-heartbeat' }] }] } });
    installHeartbeatHook();
    const raw = readFileSync(settingsPath(), 'utf-8');
    expect(raw).not.toContain('curl'); // legacy command replaced
    expect(raw).not.toMatch(/localhost:\d+/);
    expect(raw).toContain('settings.local.json');
    // Exactly one marker hook per event (no stale + new duplication).
    const s = readSettings() as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    const markers = s.hooks.PostToolUse.flatMap(g => g.hooks.map(h => h.command)).filter(c => c.includes('hotsheet-heartbeat'));
    expect(markers).toHaveLength(1);
  });

  it('preserves unrelated settings + backs up the prior file', () => {
    writeSettings({ model: 'opus', hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'echo keep' }] }] } });
    installHeartbeatHook();
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
    installHeartbeatHook();
    removeHeartbeatHook();
    expect(isHeartbeatHookInstalled()).toBe(false);
    const s = readSettings() as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    const cmds = s.hooks.PostToolUse.flatMap(g => g.hooks.map(h => h.command));
    expect(cmds).toEqual(['echo keep']);
  });

  it('drops the whole hooks key when nothing remains', () => {
    installHeartbeatHook();
    removeHeartbeatHook();
    expect(readSettings().hooks).toBeUndefined();
  });

  it('is a no-op when no marker hooks are present', () => {
    writeSettings({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo x' }] }] } });
    expect(() => removeHeartbeatHook()).not.toThrow();
    expect(readSettings().hooks).toBeDefined();
  });
});
