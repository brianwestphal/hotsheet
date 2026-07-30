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

import { initSkills, parseVersionHeader, setSkillCategories, SKILL_VERSION } from '../skills.js';
import { DEFAULT_CATEGORIES } from '../types.js';
import { getPlugin, listPlugins } from './registry.js';
import { skillsCapabilityFor, skillsCapabilityIds } from './serverCapabilities.js';

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
