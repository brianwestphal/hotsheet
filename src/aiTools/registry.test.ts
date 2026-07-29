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
import { DEV_FEATURES, devFeatureForAiTool } from '../devFeatures.js';
import { detectsSpec, detectsTool, listDetectedPlugins } from './detect.js';
import { AI_TOOL_AUTO, getPlugin, isKnownAiTool, listPlugins, normalizeAiToolId } from './registry.js';

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
  it('every docs/124 tool gate names a registered plugin', () => {
    for (const feature of DEV_FEATURES) {
      if (feature.aiTool === undefined) continue;
      expect(getPlugin(feature.aiTool), `gate ${feature.key} → unknown tool`).not.toBeNull();
    }
  });

  it("every plugin's devGateKey matches what devFeatures says for it", () => {
    for (const plugin of PLUGINS) {
      expect(plugin.devGateKey, `devGateKey drift for ${plugin.id}`)
        .toBe(devFeatureForAiTool(plugin.id)?.key ?? null);
    }
  });

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
  // Phase 1 does not yet ROUTE detection through the registry — `aiInstructionsTools.ts`
  // and `skills.ts` still own their predicates (phase 2, HS-9491). These pin the specs
  // against those predicates now, so the phase-2 swap is a verified no-op rather than a
  // hope. Expressed as literal expectations rather than by importing the old tables,
  // because the point is to catch a change on EITHER side.
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
