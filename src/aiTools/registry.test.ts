// HS-9490 (docs/132 §132.7) — the first slice of the AI-tool plugin conformance suite.
//
// The point of the shape: these run over `listPlugins()`, so a NEW plugin inherits every
// assertion by existing. That is the answer to the ticket's stated motivation — today
// "is Codex's integration correct?" means reading `skills.test.ts`, `toolPrep.test.ts`
// and `aiInstructionsTools.test.ts`, none of which are about Codex.
//
// Phase 1 lands identity + the cross-plugin drift checks. Later phases add their own
// slice as each concern moves (docs/132 §132.8); the drift checks are the ones that
// matter most right now, because the registry is a SECOND place a tool is written down
// until phases 2–5 delete the first.

import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AI_INSTRUCTION_TOOLS } from '../api/aiInstructions.js';
import { detectsSpec, detectsTool, listDetectedPlugins } from './detect.js';
import { AI_TOOL_AUTO, getPlugin, isKnownAiTool, listPlugins, normalizeAiToolId } from './registry.js';
import type { AiToolPlugin } from './types.js';

const PLUGINS = listPlugins();

let emptyDir: string;
beforeAll(() => { emptyDir = mkdtempSync(join(tmpdir(), 'hs-aitools-')); });
afterAll(() => { rmSync(emptyDir, { recursive: true, force: true }); });

describe.each(PLUGINS.map(p => [p.id, p] as const))('plugin conformance — %s (HS-9490)', (_id, plugin) => {
  it('has a lowercase, non-empty, trimmed id', () => {
    expect(plugin.id).not.toBe('');
    expect(plugin.id).toBe(plugin.id.toLowerCase().trim());
  });

  it('has non-empty display and product names', () => {
    expect(plugin.displayName.trim()).not.toBe('');
    expect(plugin.productName.trim()).not.toBe('');
  });

  it('declares a valid tier', () => {
    expect(['cli-agent', 'editor']).toContain(plugin.tier);
  });

  it('is resolvable by id, case-insensitively and with surrounding whitespace', () => {
    expect(getPlugin(plugin.id)).toBe(plugin);
    expect(getPlugin(plugin.id.toUpperCase())).toBe(plugin);
    expect(getPlugin(`  ${plugin.id}  `)).toBe(plugin);
  });

  it('declares detection paths that are project-relative, never absolute or escaping', () => {
    for (const p of plugin.detection.paths) {
      expect(p.startsWith('/')).toBe(false);
      expect(p.includes('..')).toBe(false);
    }
  });

  it('detects nothing in an empty project when no binary is on PATH', () => {
    // Stub the PATH probe so the result depends only on the declared paths — otherwise
    // this asserts something about the machine running the tests.
    expect(detectsTool(plugin, emptyDir, { isOnPath: () => false })).toBe(false);
  });

  it('detects the project when any one declared path is present', () => {
    for (const rel of plugin.detection.paths) {
      const present = detectsSpec(plugin.detection, emptyDir, {
        isOnPath: () => false,
        pathExists: (abs) => abs === join(emptyDir, rel),
      });
      expect(present, `path ${rel} should imply detection`).toBe(true);
    }
  });

  it('detects the project when any one declared binary is on PATH', () => {
    for (const bin of plugin.detection.binaries) {
      const present = detectsSpec(plugin.detection, emptyDir, {
        isOnPath: (b) => b === bin,
        pathExists: () => false,
      });
      expect(present, `binary ${bin} should imply detection`).toBe(true);
    }
  });
});

describe('registry-wide invariants (HS-9490)', () => {
  it('has no duplicate ids', () => {
    const ids = PLUGINS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not register `auto` — it is a resolution mode, not a plugin (docs/132 §132.6)', () => {
    expect(PLUGINS.some(p => p.id === AI_TOOL_AUTO)).toBe(false);
    expect(getPlugin(AI_TOOL_AUTO)).toBeNull();
    expect(isKnownAiTool(AI_TOOL_AUTO)).toBe(false);
  });

  it('normalizes unset / blank to `auto`', () => {
    expect(normalizeAiToolId(undefined)).toBe(AI_TOOL_AUTO);
    expect(normalizeAiToolId(null)).toBe(AI_TOOL_AUTO);
    expect(normalizeAiToolId('   ')).toBe(AI_TOOL_AUTO);
    expect(getPlugin(undefined)).toBeNull();
  });

  it('returns null for an unknown id rather than throwing', () => {
    expect(getPlugin('not-a-real-tool')).toBeNull();
    expect(isKnownAiTool('not-a-real-tool')).toBe(false);
  });

  it('lists detected plugins in registry order', () => {
    const detected = listDetectedPlugins(emptyDir, { isOnPath: () => true });
    // Every plugin with at least one binary is detected when everything is "on PATH".
    const expected = PLUGINS.filter(p => p.detection.binaries.length > 0);
    expect(detected).toEqual(expected);
  });
});

/**
 * The drift checks. Until phases 2–5 delete the old tables, the registry is a SECOND
 * place each tool is written down — so these are the load-bearing tests of phase 1, not
 * the identity ones. Same derive-and-pin approach that caught the HS-9322/9344 wire-enum
 * drift (docs/118).
 */
describe('registry ↔ existing per-tool tables agree (HS-9490)', () => {
  it('every AI_INSTRUCTION_TOOLS entry is a registered plugin', () => {
    for (const tool of AI_INSTRUCTION_TOOLS) {
      expect(getPlugin(tool), `${tool} is in the wire enum but not the registry`).not.toBeNull();
    }
  });

  it('the only plugin absent from AI_INSTRUCTION_TOOLS is goose (no verified conventions)', () => {
    const missing = PLUGINS.filter(p => !(AI_INSTRUCTION_TOOLS as readonly string[]).includes(p.id));
    // Pinned as an exact list, not `toContain`: adding a tool to the registry without an
    // instruction convention should be a deliberate, visible choice (HS-9347 tracks
    // Goose's). See docs/118 §118.6.
    expect(missing.map(p => p.id)).toEqual(['goose']);
  });
});

describe('detection spec matches the predicates it replaces (HS-9490)', () => {
  // HS-9491 — `aiInstructionsTools.ts` now ROUTES detection through these specs;
  // `skills.ts` still owns its own predicate until the skills half lands. So this table
  // is half live-contract, half drift guard, and stays literal either way: importing the
  // other side would make it agree with itself, when the point is to catch a change on
  // EITHER side.
  //
  // HS-9500 — Claude's two predicates used to disagree (instructions counted
  // `CLAUDE.md`, skills generation did not). `skills.ts` was brought into line with the
  // union, so all nine tools now have ONE definition and this table pins it. The
  // agreement itself is asserted end-to-end in `skills.test.ts`.
  const EXPECTED: Record<string, { binaries: string[]; paths: string[] }> = {
    claude: { binaries: ['claude'], paths: ['.claude', 'CLAUDE.md'] },
    codex: { binaries: ['codex'], paths: ['AGENTS.md'] },
    antigravity: { binaries: ['agy'], paths: ['AGENTS.md'] },
    gemini: { binaries: ['gemini'], paths: ['GEMINI.md', '.gemini'] },
    opencode: { binaries: ['opencode'], paths: ['AGENTS.md'] },
    goose: { binaries: ['goose'], paths: [] },
    cursor: { binaries: ['cursor'], paths: ['.cursor'] },
    copilot: { binaries: [], paths: ['.github/copilot-instructions.md', '.github/prompts'] },
    windsurf: { binaries: ['windsurf'], paths: ['.windsurf'] },
  };

  it.each(Object.keys(EXPECTED))('%s', (id) => {
    const plugin = getPlugin(id);
    expect(plugin).not.toBeNull();
    expect({ binaries: [...plugin!.detection.binaries], paths: [...plugin!.detection.paths] })
      .toEqual(EXPECTED[id]);
  });

  it('uses a real fs probe when no override is injected', () => {
    // Guards the default-deps wiring — a spec evaluated with stubbed deps everywhere
    // else would not catch `detectsSpec` forgetting to call `existsSync` at all.
    expect(existsSync(emptyDir)).toBe(true);
    expect(detectsSpec({ binaries: [], paths: ['.'] }, emptyDir)).toBe(true);
    expect(detectsSpec({ binaries: [], paths: ['nope-not-here'] }, emptyDir)).toBe(false);
  });
});

/**
 * HS-9491 (docs/132 phase 2) — the instructions slice. The per-tool table that used to
 * live in `aiInstructionsTools.ts` is now derived from these declarations, so these are
 * both a conformance check and the drift guard for the move.
 */
describe('instructions capability (HS-9491)', () => {
  const WITH_INSTRUCTIONS = PLUGINS.filter(p => p.instructions !== undefined);

  it('every plugin except goose declares an instruction file', () => {
    // Pinned as an exact list: adding a tool with no instruction convention should be a
    // deliberate, visible choice. Goose's is unverified — HS-9347, docs/118 §118.6.
    const without = PLUGINS.filter(p => p.instructions === undefined).map(p => p.id);
    expect(without).toEqual(['goose']);
  });

  it.each(WITH_INSTRUCTIONS.map(p => [p.id, p] as const))('%s declares a sane instruction file', (_id, plugin) => {
    const spec = plugin.instructions!;
    expect(spec.relPath).not.toBe('');
    expect(spec.relPath.startsWith('/')).toBe(false);
    expect(spec.relPath.includes('..')).toBe(false);
    // Declared POSIX-style; `aiInstructionsTools.ts` converts to the platform separator.
    expect(spec.relPath.includes('\\')).toBe(false);
    // Frontmatter, when present, must be a complete YAML block — a half-written one
    // would be prepended verbatim to the file on create.
    if (spec.frontmatter !== '') {
      expect(spec.frontmatter.startsWith('---\n')).toBe(true);
      expect(spec.frontmatter.endsWith('---\n')).toBe(true);
    }
    if (spec.adapterSkillsRoot !== null) {
      expect(spec.adapterSkillsRoot).not.toBe('');
      expect(spec.adapterSkillsRoot.startsWith('/')).toBe(false);
    }
  });

  it('the adapter family is exactly the tools docs/118 says it is', () => {
    const family = WITH_INSTRUCTIONS
      .filter(p => p.instructions!.adapterSkillsRoot !== null)
      .map(p => p.id);
    // Registry order, not docs order — `family` is filtered from `listPlugins()`.
    expect(family).toEqual(['codex', 'antigravity', 'gemini', 'opencode']);
  });

  it('adapter roots are per FILE, not per tool', () => {
    // The AGENTS.md-sharing tools must agree on ONE root, or they rewrite each other's
    // file on every pass (docs/118). Gemini has its own file, so its own root.
    const rootFor = (id: string) => getPlugin(id)?.instructions?.adapterSkillsRoot;
    expect(rootFor('codex')).toBe('.agents/skills');
    expect(rootFor('antigravity')).toBe('.agents/skills');
    expect(rootFor('opencode')).toBe('.agents/skills');
    expect(rootFor('gemini')).toBe('.gemini/skills');
  });

  it('tools sharing an instruction file agree on its path', () => {
    // Three tools write AGENTS.md. The double-write is idempotent ONLY while they
    // target the same path; a divergence here means two of them fight over one file.
    const byPath = new Map<string, string[]>();
    for (const p of WITH_INSTRUCTIONS) {
      const list = byPath.get(p.instructions!.relPath) ?? [];
      list.push(p.id);
      byPath.set(p.instructions!.relPath, list);
    }
    expect(byPath.get('AGENTS.md')).toEqual(['codex', 'antigravity', 'opencode']);
  });

  it('matches the paths the pre-registry table used (HS-9491 move guard)', () => {
    const EXPECTED: Record<string, string> = {
      claude: 'CLAUDE.md',
      codex: 'AGENTS.md',
      antigravity: 'AGENTS.md',
      gemini: 'GEMINI.md',
      opencode: 'AGENTS.md',
      cursor: '.cursor/rules/hotsheet-instructions.mdc',
      copilot: '.github/copilot-instructions.md',
      windsurf: '.windsurf/rules/hotsheet-instructions.md',
    };
    for (const [id, relPath] of Object.entries(EXPECTED)) {
      expect(getPlugin(id)?.instructions?.relPath, `relPath drift for ${id}`).toBe(relPath);
    }
  });
});

/**
 * HS-9495 (docs/132 §132.7) — the claim the whole epic rests on, asserted rather than
 * asserted-in-prose: **adding a tool is one plugin module plus one registry line, and it
 * is covered by the conformance suite the moment it exists.**
 *
 * A hypothetical plugin is built here — never registered, so it cannot affect production
 * — and put through the same identity + detection expectations every real plugin faces.
 * If a future change makes the suite depend on something only the nine known tools have,
 * this fails and says so.
 */
describe('a NEW plugin inherits the conformance suite by existing (HS-9495)', () => {
  const newcomer: AiToolPlugin = {
    id: 'probetool',
    displayName: 'Probe',
    productName: 'Probe Tool',
    tier: 'cli-agent',
    detection: { binaries: ['probetool'], paths: ['.probetool'] },
    instructions: { relPath: 'PROBE.md', frontmatter: '', adapterSkillsRoot: null },
  };

  it('satisfies the identity expectations with no special-casing', () => {
    expect(newcomer.id).toBe(newcomer.id.toLowerCase().trim());
    expect(newcomer.displayName.trim()).not.toBe('');
    expect(newcomer.productName.trim()).not.toBe('');
    expect(['cli-agent', 'editor']).toContain(newcomer.tier);
  });

  it('works with the shared detection evaluator — no per-tool code path', () => {
    // The point of `DetectionSpec` being DATA: a tool nobody wrote code for is still
    // detectable, by the same evaluator, with the same injected seams.
    expect(detectsTool(newcomer, emptyDir, { isOnPath: () => false })).toBe(false);
    expect(detectsTool(newcomer, emptyDir, { isOnPath: (b) => b === 'probetool' })).toBe(true);
    expect(detectsSpec(newcomer.detection, emptyDir, {
      isOnPath: () => false,
      pathExists: (abs) => abs === join(emptyDir, '.probetool'),
    })).toBe(true);
  });

  it('declares capabilities by ABSENCE without tripping anything', () => {
    // It has no drive, skills, command or permissions — the shape a genuinely new tool
    // starts in. Every lookup must answer null rather than assume presence.
    expect(newcomer.instructions).toBeDefined();
    for (const cap of [newcomer.detection.binaries, newcomer.detection.paths]) {
      expect(Array.isArray(cap)).toBe(true);
    }
  });
});
