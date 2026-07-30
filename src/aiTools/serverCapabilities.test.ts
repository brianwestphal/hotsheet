/**
 * HS-9503 (docs/132 §132.7) — the skills slice of the AI-tool plugin conformance suite.
 *
 * The load-bearing assertion here is that **the artifact `ensure()` writes IS the one
 * `mainArtifactRelPath()` names**. Those were a switch in `toolPrep.ts` and an if-chain
 * in `skills.ts` — two hand-maintained lists that had to agree, with nothing checking
 * that they did. A mismatch is the docs/119 failure where tool-prep reports "needed"
 * forever because it checks a path nothing produces. Now they come from one capability,
 * and this proves it on a real filesystem rather than by inspection.
 *
 * Runs over the capability table, so a new tool inherits every case by existing.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claudeWithChannelCommand } from '../channel-config.js';
import { initSkills, parseVersionHeader, setSkillCategories, SKILL_VERSION } from '../skills.js';
import { DEFAULT_CATEGORIES } from '../types.js';
import { getPlugin, listPlugins } from './registry.js';
import { acpCommandFor, commandCapabilityFor, commandCapabilityIds, commandCapabilityOrDefault, driveFor, driveIds, driveServiceFor, driveServiceIds, mcpConfigFor, mcpConfigIds, prestartProjectDriveService, projectDriveService, shutdownAllDriveServices, skillsCapabilityFor, skillsCapabilityIds } from './serverCapabilities.js';

const IDS = skillsCapabilityIds();

let root: string;
let savedPath: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
  root = join(tmpdir(), `hs-caps-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, '.hotsheet'), { recursive: true });
  writeFileSync(join(root, '.hotsheet', 'settings.json'), JSON.stringify({}));
  initSkills(4174);
  setSkillCategories(DEFAULT_CATEGORIES);
  // Neutralize host detection so nothing depends on what is installed on this machine.
  // `isExecutableOnPath` also searches `~/.local/bin` / `~/.claude/local`, so HOME is
  // pointed at the empty fixture too (the HS-8785 leak).
  savedPath = process.env.PATH;
  savedHome = process.env.HOME;
  process.env.PATH = join(root, 'empty-bin');
  process.env.HOME = root;
});

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

describe.each(IDS)('skills capability — %s (HS-9503)', (id) => {
  const capability = skillsCapabilityFor(id)!;

  it('is declared by a registered plugin', () => {
    expect(getPlugin(id), `${id} has a capability but no plugin`).not.toBeNull();
  });

  it('names a repo-relative POSIX artifact path', () => {
    const rel = capability.mainArtifactRelPath(root);
    expect(rel).not.toBe('');
    expect(rel.startsWith('/')).toBe(false);
    expect(rel.includes('..')).toBe(false);
    expect(rel.includes('\\')).toBe(false);
  });

  it('has a non-empty platform label', () => {
    expect(capability.platformLabel.trim()).not.toBe('');
  });

  it('WRITES the artifact it names, carrying the current version header', () => {
    // The docs/119 guard. `ensure` is called directly rather than through
    // `ensureSkillsForDir` so this is about the capability's own contract, not about
    // detection or the `ai_tool` narrowing.
    expect(capability.ensure(root, join(root, '.hotsheet'))).toBe(true);

    const rel = capability.mainArtifactRelPath(root);
    const abs = join(root, rel);
    expect(existsSync(abs), `${id}: ensure() did not write ${rel}`).toBe(true);
    expect(parseVersionHeader(readFileSync(abs, 'utf-8'))).toBe(SKILL_VERSION);
  });

  it('is idempotent — a second ensure() writes nothing', () => {
    expect(capability.ensure(root, join(root, '.hotsheet'))).toBe(true);
    expect(capability.ensure(root, join(root, '.hotsheet')), `${id}: second ensure() rewrote`).toBe(false);
  });
});

describe('skills capability table (HS-9503)', () => {
  it('covers every plugin except goose', () => {
    // Exact list, not `toContain`: a tool arriving without a skill format should be a
    // deliberate, visible choice. Goose's conventions are unverified — HS-9347.
    const without = listPlugins().filter(p => skillsCapabilityFor(p.id) === null).map(p => p.id);
    expect(without).toEqual(['goose']);
  });

  it('omitting projectRoot never probes the CWD (HS-9503)', () => {
    // The regression the test above caught, pinned directly: every capability must
    // answer the same with no root as it does for a project with no canonical source.
    const bare = join(tmpdir(), `hs-caps-noroot-${Date.now()}`);
    mkdirSync(bare, { recursive: true });
    try {
      for (const id of IDS) {
        const cap = skillsCapabilityFor(id)!;
        expect(cap.mainArtifactRelPath(), `${id} differs with no projectRoot`)
          .toBe(cap.mainArtifactRelPath(bare));
      }
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('declares no capability for an unknown tool', () => {
    expect(skillsCapabilityFor('not-a-real-tool')).toBeNull();
  });

  it('resolves case-insensitively, like the registry', () => {
    expect(skillsCapabilityFor('CLAUDE')).toBe(skillsCapabilityFor('claude'));
  });

  it('OpenCode is the only tool whose artifact path depends on the project (docs/118 §118.4a)', () => {
    // With a canonical Claude source it targets `.claude/skills` (OpenCode reads that
    // directly); without one, the shared `.agents/skills`. Everything else must answer
    // the same regardless of what is on disk — otherwise `skillArtifactRelPath`'s
    // optional `projectRoot` would silently give a different answer per caller.
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
    writeFileSync(join(root, 'CLAUDE.md'), '# canonical\n');

    // Compare against a SEPARATE empty project, not `''`/undefined — an empty string
    // resolves against the CWD, which for this suite is Hot Sheet's own repo and DOES
    // have a canonical source. That is precisely the trap this test caught during
    // HS-9503: the first refactor passed `''` through and silently made the answer
    // depend on where the server was started.
    const bare = join(tmpdir(), `hs-caps-bare-${Date.now()}`);
    mkdirSync(bare, { recursive: true });
    try {
      const varying = IDS.filter(id => {
        const cap = skillsCapabilityFor(id)!;
        return cap.mainArtifactRelPath(root) !== cap.mainArtifactRelPath(bare);
      });
      expect(varying).toEqual(['opencode']);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

/**
 * HS-9492 (docs/132 phase 3) — the command slice.
 *
 * These replace `CLI_AGENTS` + `AGENT_BINARIES` + the `tool === 'codex'` branch that used
 * to live in `terminals/resolveCommand.ts`. Everything is driven through injected seams,
 * so none of it depends on which tools are installed on this machine — which is the point
 * of the exercise: a capability testable only with the real binary would be no better
 * than the branch it replaced.
 */
describe.each(commandCapabilityIds())('command capability — %s (HS-9492)', (id) => {
  const capability = commandCapabilityFor(id)!;
  const ON = { isOnPath: () => true };
  const OFF = { isOnPath: () => false, defaultShell: () => '/bin/test-shell' };

  it('is declared by a registered plugin, and that plugin is a CLI agent', () => {
    const plugin = getPlugin(id);
    expect(plugin, `${id} has a command capability but no plugin`).not.toBeNull();
    // A Tier-B editor tool is not launched in a terminal (docs/113 §113.2) — if one ever
    // declares a command, that is a category error rather than a new feature.
    expect(plugin!.tier).toBe('cli-agent');
  });

  it('resolves to a non-empty line mentioning its binary when present', () => {
    const line = capability.resolve('/tmp/proj/.hotsheet', ON);
    expect(line).not.toBe('');
    expect(line).toContain(capability.binary);
  });

  it('falls back to the shell when the binary is absent', () => {
    // A terminal that opens a shell beats one that fails to launch.
    expect(capability.resolve('/tmp/proj/.hotsheet', OFF)).toBe('/bin/test-shell');
  });
});

describe('command capability table (HS-9492)', () => {
  it('covers exactly the CLI agents — no editor tools', () => {
    const withCommand = listPlugins().filter(p => commandCapabilityFor(p.id) !== null).map(p => p.id);
    expect(withCommand).toEqual(['claude', 'codex', 'antigravity', 'gemini', 'opencode', 'goose']);
  });

  it('Antigravity is the one tool whose binary differs from its id (HS-9319)', () => {
    const differing = commandCapabilityIds().filter(id => commandCapabilityFor(id)!.binary !== id);
    expect(differing).toEqual(['antigravity']);
  });

  it('auto / unset / unknown / editor tools all default to the Claude capability', () => {
    // The old `!CLI_AGENTS.has(tool)` branch, restated: Claude is the DEFAULT, not a
    // special case. Losing this would silently change what a `{{aiCommand}}` terminal
    // launches for every project that never picked a tool.
    const claude = commandCapabilityFor('claude');
    for (const t of ['auto', '', 'not-a-real-tool', 'cursor', 'copilot', 'windsurf']) {
      expect(commandCapabilityOrDefault(t), `${t || '(empty)'} should default to Claude`).toBe(claude);
    }
  });

  it('Claude carries the per-project channel flag only when the channel is on', () => {
    const dataDir = '/tmp/proj/.hotsheet';
    const on = commandCapabilityFor('claude')!.resolve(dataDir, { isOnPath: () => true, channelEnabled: true });
    expect(on).toBe(claudeWithChannelCommand(dataDir));
    expect(on).toContain('--dangerously-load-development-channels');

    const off = commandCapabilityFor('claude')!.resolve(dataDir, { isOnPath: () => true, channelEnabled: false });
    expect(off).toBe('claude');
  });

  it('Codex prefers the model-B daemon-hosted line, and falls back when it is unavailable', () => {
    // docs/129 — the terminal owns a live daemon thread and the drive discovers it. The
    // fallbacks matter as much as the happy path: model-B off, or the daemon not up.
    const dataDir = '/tmp/proj/.hotsheet';
    const codex = commandCapabilityFor('codex')!;
    const remote = () => 'codex --remote unix:///tmp/sock -C /tmp/proj';

    expect(codex.resolve(dataDir, { isOnPath: () => true, codexModelB: true, codexRemote: remote }))
      .toBe(remote());
    // model-B on but no daemon discovered → plain codex.
    expect(codex.resolve(dataDir, { isOnPath: () => true, codexModelB: true, codexRemote: () => null }))
      .toBe('codex');
    // model-B off → plain codex, and the remote resolver is never consulted.
    expect(codex.resolve(dataDir, { isOnPath: () => true, codexModelB: false, codexRemote: remote }))
      .toBe('codex');
  });
});

/**
 * HS-9493 (docs/132 phase 4a) — the drive backing service.
 *
 * This is the concept that let five generic modules stop importing `codexAppServer` by
 * name. Codex is the only implementer today, so the risk is that the "interface" is
 * really codex's API renamed — these assert the properties that make it a category
 * rather than a rename: absence is meaningful, every method is answerable, and a caller
 * with no service gets a safe no-op.
 */
describe('drive backing service (HS-9493)', () => {
  it('is declared only by tools whose drive actually needs one', () => {
    // Exact list. Antigravity spawns per play and OpenCode starts one per ACP session —
    // neither has a long-lived service, and claiming otherwise would give every caller a
    // lifecycle to manage that does not exist.
    expect(driveServiceIds()).toEqual(['codex']);
  });

  it('every declaring tool is a registered CLI-agent plugin', () => {
    for (const id of driveServiceIds()) {
      expect(getPlugin(id), `${id} has a drive service but no plugin`).not.toBeNull();
      expect(getPlugin(id)!.tier).toBe('cli-agent');
    }
  });

  it('answers the whole contract — no half-implemented service', () => {
    // Optionality belongs at the `service` field, not inside it: a caller that gets a
    // service must be able to ask it anything without probing for method existence.
    for (const id of driveServiceIds()) {
      const svc = driveServiceFor(id)!;
      for (const method of ['isEnabled', 'hasFailed', 'prestart', 'clearFailures',
        'shutdown', 'blocksTerminalSpawn', 'ensureUpForSpawn', 'noteTerminalLaunch'] as const) {
        expect(typeof svc[method], `${id}.${method}`).toBe('function');
      }
    }
  });

  it('returns null for tools without one, and for unknown ids', () => {
    for (const id of ['claude', 'antigravity', 'opencode', 'gemini', 'goose', 'cursor', 'nope']) {
      expect(driveServiceFor(id), `${id} should have no backing service`).toBeNull();
    }
  });

  it('resolves case-insensitively', () => {
    expect(driveServiceFor('CODEX')).toBe(driveServiceFor('codex'));
  });
});

describe('project-level drive-service helpers (HS-9493)', () => {
  it('prestart is a safe no-op for a project whose tool has no service', () => {
    // The property every one of the five migrated call sites depends on: they call this
    // unconditionally, on lifecycle events that must not fail.
    writeFileSync(join(root, '.hotsheet', 'settings.json'), JSON.stringify({ ai_tool: 'claude' }));
    expect(() => prestartProjectDriveService(root + '/.hotsheet')).not.toThrow();
    expect(projectDriveService(root + '/.hotsheet')).toBeNull();
  });

  it('prestart swallows a throwing service rather than breaking the caller', () => {
    // eagerSpawn / settings / channel all call this incidentally; a drive that cannot
    // pre-start must not take down a project registration or a settings save.
    writeFileSync(join(root, '.hotsheet', 'settings.json'), JSON.stringify({ ai_tool: 'codex' }));
    // The real codex prestart is itself best-effort; this asserts the wrapper's guard by
    // pointing at a dataDir with no codex anything, which is the realistic failure shape.
    expect(() => prestartProjectDriveService(root + '/.hotsheet')).not.toThrow();
  });

  it('resolves the service from the project ai_tool setting', () => {
    writeFileSync(join(root, '.hotsheet', 'settings.json'), JSON.stringify({ ai_tool: 'codex' }));
    expect(projectDriveService(root + '/.hotsheet')).toBe(driveServiceFor('codex'));
  });

  it('shutdownAllDriveServices never throws, even with no project context', () => {
    // The process-exit path calls this; a throw there strands the orphan children it
    // exists to kill.
    expect(() => shutdownAllDriveServices()).not.toThrow();
  });
});

/**
 * HS-9505 (docs/132 phase 4b) — drive, MCP config and ACP entrypoint.
 *
 * These absorb `mcpHooksAgents.test.ts`, whose module is gone. Its assertions are kept
 * rather than dropped: it pinned that the two spawn agents resolve case-insensitively
 * with the right binaries, and that Claude / ACP / editor tools resolve to nothing. Those
 * are still the properties that matter — they just live with the rest of the conformance
 * suite now, where a new tool inherits them.
 */
describe('drive capability (HS-9505)', () => {
  it('is declared by exactly the tools we drive', () => {
    expect(driveIds()).toEqual(['antigravity', 'codex', 'opencode']);
  });

  it('declares a transport matching what the tool actually speaks', () => {
    // docs/115 (MCP-native, Claude rails) vs docs/114 (ACP-native). Getting this wrong
    // routes the play button at the wrong drive entirely.
    expect(driveFor('antigravity')!.transport).toBe('mcp-hooks');
    expect(driveFor('codex')!.transport).toBe('mcp-hooks');
    expect(driveFor('opencode')!.transport).toBe('acp');
  });

  it('every drive is a registered CLI-agent plugin with a runnable turn', () => {
    for (const id of driveIds()) {
      expect(getPlugin(id), `${id} drives but has no plugin`).not.toBeNull();
      expect(getPlugin(id)!.tier).toBe('cli-agent');
      expect(typeof driveFor(id)!.run).toBe('function');
    }
  });

  it('resolves case-insensitively', () => {
    expect(driveFor('Antigravity')).toBe(driveFor('antigravity'));
    expect(driveFor('Codex')).toBe(driveFor('codex'));
  });

  it('Claude, editor tools and unknown ids have NO drive — they fall to claude-channel', () => {
    // Claude's absence is temporary and deliberate: it is the persistent-channel path
    // phase 5 (HS-9494) converts, and that conversion is the real test of this interface.
    for (const id of ['claude', 'cursor', 'copilot', 'windsurf', 'gemini', 'goose', '', 'nope']) {
      expect(driveFor(id), `${id || '(empty)'} should have no drive`).toBeNull();
    }
  });
});

describe('MCP config capability (HS-9505)', () => {
  it('is declared only by tools with a config file to write', () => {
    // OpenCode is the meaningful absence: its MCP server rides the ACP `session/new`
    // payload, so there is no file (docs/114 §114.4). Declaring one would make the
    // generation loop probe for a binary and write nothing.
    expect(mcpConfigIds()).toEqual(['antigravity', 'codex']);
  });

  it('gates on the binary that must be installed', () => {
    expect(mcpConfigFor('antigravity')!.binary).toBe('agy');
    expect(mcpConfigFor('codex')!.binary).toBe('codex');
  });

  it('resolves case-insensitively and returns null for the rest', () => {
    expect(mcpConfigFor('Antigravity')).toBe(mcpConfigFor('antigravity'));
    for (const id of ['claude', 'opencode', 'cursor', '', 'nope']) {
      expect(mcpConfigFor(id), `${id || '(empty)'} should need no MCP config`).toBeNull();
    }
  });
});

describe('ACP entrypoint (HS-9505)', () => {
  it('is declared only for agents whose entrypoint was verified live', () => {
    // `opencode acp` was pinned by the HS-9330 spike against opencode 1.17.9. Goose and
    // Kiro get entries when theirs are actually verified — a guessed entrypoint fails at
    // spawn time, in front of the user.
    expect(acpCommandFor('opencode')).toEqual({ command: 'opencode', args: ['acp'] });
    for (const id of ['claude', 'codex', 'antigravity', 'goose', '', 'nope']) {
      expect(acpCommandFor(id), `${id || '(empty)'} should have no ACP entrypoint`).toBeNull();
    }
  });

  it('every ACP-transport drive has an entrypoint, and vice versa', () => {
    // The pairing that matters: an `acp` transport with no entrypoint would route the
    // play button into a spawn that cannot be built.
    const acpDrives = driveIds().filter(id => driveFor(id)!.transport === 'acp');
    for (const id of acpDrives) expect(acpCommandFor(id), `${id} drives over ACP`).not.toBeNull();
  });
});
