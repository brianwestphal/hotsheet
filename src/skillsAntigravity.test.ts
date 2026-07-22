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

// HS-9366 (docs/118) — adapter mode for the AGENTS-family skill tree
// (`.agents/skills`, shared by Antigravity + Codex): thin adapters referencing
// the canonical `.claude/skills` when it exists, full bodies otherwise.
describe('ensureSkillsForDir — AGENTS-family adapter mode + Codex (HS-9366)', () => {
  const agentsSkill = (name: string): string => join(dir, '.agents', 'skills', name, 'SKILL.md');
  const claudeSkill = (name: string): string => join(dir, '.claude', 'skills', name, 'SKILL.md');
  const makeCanonical = (): void => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project\n');
    mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
  };

  it('codex: seeds .agents/skills as thin adapters when the canonical Claude source exists', () => {
    setAiTool('codex');
    h.onPath.mockImplementation((bin) => bin === 'codex');
    makeCanonical();
    const platforms = ensureSkillsForDir(dir);
    expect(platforms).toContain('Codex');

    const adapter = readFileSync(agentsSkill('hotsheet'), 'utf-8');
    expect(adapter).toContain('name: hotsheet');                                // frontmatter kept for discovery
    expect(adapter).toContain('../../../.claude/skills/hotsheet/SKILL.md');     // delegates to canonical
    expect(adapter).not.toContain('.hotsheet/worklist.md');                     // body NOT duplicated
    // The canonical tree was refreshed first (even though ai_tool excludes
    // claude) so the adapters can't reference stale content.
    expect(readFileSync(claudeSkill('hotsheet'), 'utf-8')).toContain('.hotsheet/worklist.md');
  });

  it('codex: full bodies when there is no canonical Claude source (started-on-Codex fallback)', () => {
    setAiTool('codex');
    h.onPath.mockImplementation((bin) => bin === 'codex');
    ensureSkillsForDir(dir);

    const content = readFileSync(agentsSkill('hotsheet'), 'utf-8');
    expect(content).toContain('.hotsheet/worklist.md');                         // full body
    expect(content).not.toContain('../../../.claude/skills');
    expect(existsSync(join(dir, '.claude'))).toBe(false);                       // canonical NOT invented
  });

  it('codex: detected via AGENTS.md presence when the binary is absent', () => {
    setAiTool('codex');
    writeFileSync(join(dir, 'AGENTS.md'), '# existing\n');
    ensureSkillsForDir(dir);
    expect(existsSync(agentsSkill('hotsheet'))).toBe(true);
  });

  it('antigravity: the shared writer emits adapters for the ticket skills too', () => {
    setAiTool('antigravity');
    h.onPath.mockImplementation((bin) => bin === 'agy');
    makeCanonical();
    ensureSkillsForDir(dir);
    const adapter = readFileSync(agentsSkill('hs-bug'), 'utf-8');
    expect(adapter).toContain('../../../.claude/skills/hs-bug/SKILL.md');
    expect(adapter).toContain('description: Create a new bug ticket in Hot Sheet'); // discovery metadata kept
  });
});

// HS-9359 — the Codex interactive-permission hooks (`.codex/hooks.json`):
// merge-in when `codex_interactive_permissions` is on, merge-out when off,
// preserving the user's other hooks. Verified-live schema (top-level `hooks`
// object, matcher + nested hooks entries).
describe('ensureSkillsForDir — Codex interactive-permission hooks (HS-9359)', () => {
  const hooksPath = (): string => join(dir, '.codex', 'hooks.json');
  const setSettings = (o: Record<string, unknown>): void => writeFileSync(join(dir, '.hotsheet', 'settings.json'), JSON.stringify(o), 'utf-8');
  interface HookGroup { matcher?: string; hooks?: { command?: string; timeout?: number }[] }
  const readHooks = (): Partial<Record<string, HookGroup[]>> => {
    const parsed: unknown = JSON.parse(readFileSync(hooksPath(), 'utf-8'));
    return (parsed as { hooks?: Record<string, HookGroup[]> }).hooks ?? {};
  };

  it('installs PreToolUse (mutating-tools matcher) + PermissionRequest (*) when the setting is on', () => {
    setSettings({ ai_tool: 'codex', codex_interactive_permissions: true });
    h.onPath.mockImplementation((bin) => bin === 'codex');
    ensureSkillsForDir(dir);

    const events = readHooks();
    expect(events.PreToolUse?.[0]?.matcher).toBe('^(Bash|apply_patch|Edit|Write)$');
    expect(events.PreToolUse?.[0]?.hooks?.[0]?.command).toContain('__codex-permission-hook');
    expect(events.PermissionRequest?.[0]?.matcher).toBe('*');
    expect(events.PermissionRequest?.[0]?.hooks?.[0]?.command).toContain('__codex-permission-hook');
  });

  it('does NOT install when the setting is off/absent (default)', () => {
    setSettings({ ai_tool: 'codex' });
    h.onPath.mockImplementation((bin) => bin === 'codex');
    ensureSkillsForDir(dir);
    expect(existsSync(hooksPath())).toBe(false);
  });

  it('MERGES with the user\'s other hooks, and removes ours when toggled off', () => {
    mkdirSync(join(dir, '.codex'), { recursive: true });
    writeFileSync(hooksPath(), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'my-own-hook.sh' }] }] },
    }), 'utf-8');

    setSettings({ ai_tool: 'codex', codex_interactive_permissions: true });
    h.onPath.mockImplementation((bin) => bin === 'codex');
    ensureSkillsForDir(dir);
    let events = readHooks();
    const commands = (events.PreToolUse ?? []).flatMap(g => (g.hooks ?? []).map(x => x.command ?? ''));
    expect(commands).toContain('my-own-hook.sh');                                    // user hook kept
    expect(commands.some(c => c.includes('__codex-permission-hook'))).toBe(true);    // ours added

    setSettings({ ai_tool: 'codex' }); // toggle off
    ensureSkillsForDir(dir);
    events = readHooks();
    const after = (events.PreToolUse ?? []).flatMap(g => (g.hooks ?? []).map(x => x.command ?? ''));
    expect(after).toContain('my-own-hook.sh');                                       // user hook still kept
    expect(after.some(c => c.includes('__codex-permission-hook'))).toBe(false);      // ours removed
    expect(events.PermissionRequest).toBeUndefined();                                // our event fully gone
  });
});
