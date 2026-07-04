// HS-9320 — the wire: `ensureSkillsForDir` registers agy's MCP config only when
// the project targets Antigravity AND `agy` is on PATH. Isolated (mocks the
// antigravity writer + PATH detection) so it never touches the real ~/.gemini and
// doesn't disturb the real-PATH-based assertions in skills.test.ts.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  ensure: vi.fn(),
  onPath: vi.fn<(bin: string) => boolean>(() => false),
}));
vi.mock('./antigravity.js', () => ({ ensureAntigravityMcpConfig: h.ensure }));
vi.mock('./utils/isExecutableOnPath.js', () => ({ isExecutableOnPath: h.onPath }));

// eslint-disable-next-line import/first
import { ensureSkillsForDir } from './skills.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hs-skills-agy-'));
  mkdirSync(join(dir, '.hotsheet'), { recursive: true });
  h.ensure.mockClear();
  h.onPath.mockReset();
  h.onPath.mockReturnValue(false);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function setAiTool(tool: string): void {
  writeFileSync(join(dir, '.hotsheet', 'settings.json'), JSON.stringify({ ai_tool: tool }), 'utf-8');
}

describe('ensureSkillsForDir — Antigravity MCP registration (HS-9320)', () => {
  it('registers agy config when ai_tool=antigravity AND agy is on PATH', () => {
    setAiTool('antigravity');
    h.onPath.mockImplementation((bin) => bin === 'agy');
    ensureSkillsForDir(dir);
    expect(h.ensure).toHaveBeenCalledTimes(1);
  });

  it('does NOT register when ai_tool=antigravity but agy is not on PATH', () => {
    setAiTool('antigravity');
    h.onPath.mockReturnValue(false);
    ensureSkillsForDir(dir);
    expect(h.ensure).not.toHaveBeenCalled();
  });

  it('does NOT register when the project targets another tool (claude)', () => {
    setAiTool('claude');
    h.onPath.mockImplementation((bin) => bin === 'agy'); // agy present, but not selected
    ensureSkillsForDir(dir);
    expect(h.ensure).not.toHaveBeenCalled();
  });
});

describe('ensureSkillsForDir — Antigravity interactive-permissions hook (HS-9327)', () => {
  const hooksPath = (): string => join(dir, '.agents', 'hooks.json');
  const setSettings = (o: Record<string, unknown>): void => writeFileSync(join(dir, '.hotsheet', 'settings.json'), JSON.stringify(o), 'utf-8');
  const hookCommands = (): string[] => {
    const parsed: unknown = JSON.parse(readFileSync(hooksPath(), 'utf-8'));
    const cfg = parsed as { PreToolUse?: Array<{ hooks?: Array<{ command?: string }> }> };
    return (cfg.PreToolUse ?? []).flatMap(g => (g.hooks ?? []).map(h2 => h2.command ?? ''));
  };

  it('installs the PreToolUse permission hook when the setting is on', () => {
    setSettings({ ai_tool: 'antigravity', antigravity_interactive_permissions: true });
    h.onPath.mockImplementation((bin) => bin === 'agy');
    ensureSkillsForDir(dir);
    expect(existsSync(hooksPath())).toBe(true);
    expect(hookCommands().some(c => c.includes('__agy-permission-hook'))).toBe(true);
  });

  it('does NOT install the hook when the setting is off/absent (default)', () => {
    setSettings({ ai_tool: 'antigravity' });
    h.onPath.mockImplementation((bin) => bin === 'agy');
    ensureSkillsForDir(dir);
    if (existsSync(hooksPath())) expect(hookCommands().some(c => c.includes('__agy-permission-hook'))).toBe(false);
  });

  it('MERGES with the user\'s other hooks, and removes ours when toggled off', () => {
    mkdirSync(join(dir, '.agents'), { recursive: true });
    writeFileSync(hooksPath(), JSON.stringify({ PreToolUse: [{ matcher: 'X', hooks: [{ type: 'command', command: 'my-own-hook.sh' }] }] }), 'utf-8');
    h.onPath.mockImplementation((bin) => bin === 'agy');

    setSettings({ ai_tool: 'antigravity', antigravity_interactive_permissions: true });
    ensureSkillsForDir(dir);
    expect(hookCommands()).toContain('my-own-hook.sh');                          // user hook kept
    expect(hookCommands().some(c => c.includes('__agy-permission-hook'))).toBe(true); // ours added

    setSettings({ ai_tool: 'antigravity' }); // toggle off
    ensureSkillsForDir(dir);
    expect(hookCommands()).toContain('my-own-hook.sh');                          // user hook still kept
    expect(hookCommands().some(c => c.includes('__agy-permission-hook'))).toBe(false); // ours removed
  });
});
