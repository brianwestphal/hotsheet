// HS-9367 (docs/119) — selected-tool config preparation: status detection +
// the one-shot prepare that reuses the idempotent generators.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SKILL_VERSION } from './skills.js';
import { getToolPrepStatus, prepareToolConfig, skillArtifactRelPath, skillArtifactStale } from './toolPrep.js';

let root: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hs-toolprep-'));
  dataDir = join(root, '.hotsheet');
  mkdirSync(dataDir, { recursive: true });
});
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

function setAiTool(tool: string | undefined): void {
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(tool === undefined ? {} : { ai_tool: tool }), 'utf-8');
}

describe('skillArtifactRelPath', () => {
  it('maps each tool with a skill format to its main generated artifact', () => {
    expect(skillArtifactRelPath('claude')).toBe(join('.claude', 'skills', 'hotsheet', 'SKILL.md'));
    expect(skillArtifactRelPath('codex')).toBe(join('.agents', 'skills', 'hotsheet', 'SKILL.md'));
    expect(skillArtifactRelPath('antigravity')).toBe(join('.agents', 'skills', 'hotsheet', 'SKILL.md'));
    expect(skillArtifactRelPath('cursor')).toBe(join('.cursor', 'rules', 'hotsheet.mdc'));
    expect(skillArtifactRelPath('windsurf')).toBe(join('.windsurf', 'rules', 'hotsheet.md'));
    expect(skillArtifactRelPath('copilot')).toBe(join('.github', 'prompts', 'hotsheet.prompt.md'));
  });

  it('returns null for tools without a skill format (opencode/gemini/goose/auto)', () => {
    for (const t of ['opencode', 'gemini', 'goose', 'auto']) expect(skillArtifactRelPath(t)).toBeNull();
  });
});

describe('skillArtifactStale', () => {
  it('missing → stale; behind SKILL_VERSION → stale; current → fresh (injected probes)', () => {
    const rel = 'x/SKILL.md';
    expect(skillArtifactStale(root, rel, { fileExists: () => false })).toBe(true);
    expect(skillArtifactStale(root, rel, {
      fileExists: () => true,
      readFile: () => `<!-- hotsheet-skill-version: ${SKILL_VERSION - 1} -->\nbody`,
    })).toBe(true);
    expect(skillArtifactStale(root, rel, {
      fileExists: () => true,
      readFile: () => 'no version header at all',
    })).toBe(true);
    expect(skillArtifactStale(root, rel, {
      fileExists: () => true,
      readFile: () => `<!-- hotsheet-skill-version: ${SKILL_VERSION} -->\nbody`,
    })).toBe(false);
  });
});

describe('getToolPrepStatus', () => {
  it('auto (or unset) never needs preparation', () => {
    setAiTool('auto');
    expect(getToolPrepStatus(root, dataDir).needed).toBe(false);
    setAiTool(undefined);
    expect(getToolPrepStatus(root, dataDir)).toMatchObject({ aiTool: 'auto', needed: false });
  });

  it('codex on an empty project needs both the instruction file and the skills', () => {
    setAiTool('codex');
    const st = getToolPrepStatus(root, dataDir);
    expect(st).toMatchObject({
      aiTool: 'codex',
      instructionTool: 'codex',
      instructionsNeeded: true,
      instructionsPath: 'AGENTS.md',
      skillsNeeded: true,
      needed: true,
    });
    expect(st.skillsPath).toBe(join('.agents', 'skills', 'hotsheet', 'SKILL.md'));
  });

  it('a tool with no instruction convention or skill format (goose) needs nothing', () => {
    setAiTool('goose');
    expect(getToolPrepStatus(root, dataDir)).toMatchObject({
      aiTool: 'goose', instructionTool: null, instructionsPath: null, skillsPath: null, needed: false,
    });
  });
});

describe('prepareToolConfig', () => {
  it('codex on an empty project: writes AGENTS.md (full sections) + the .agents skills; post-status is satisfied', () => {
    setAiTool('codex');
    const res = prepareToolConfig(root, dataDir);

    expect(res.instructionsWritten).toBe(true);
    const agentsMd = readFileSync(join(root, 'AGENTS.md'), 'utf-8');
    // No canonical Claude source → the FULL sections (started-on-Codex fallback).
    expect(agentsMd).toContain('hotsheet:begin section=ticket-driven-work');
    expect(agentsMd).not.toContain('section=claude-adapter');

    const skill = readFileSync(join(root, '.agents', 'skills', 'hotsheet', 'SKILL.md'), 'utf-8');
    expect(skill).toContain(`<!-- hotsheet-skill-version: ${SKILL_VERSION} -->`);
    // No canonical `.claude/skills` was invented for a Codex-only project.
    expect(existsSync(join(root, '.claude'))).toBe(false);

    expect(res.status.needed).toBe(false); // fully prepared now
  });

  it('codex with a canonical Claude source: writes the ADAPTER AGENTS.md + adapter skills', () => {
    setAiTool('codex');
    writeFileSync(join(root, 'CLAUDE.md'), '# Project\n');
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true });

    const res = prepareToolConfig(root, dataDir);
    expect(res.instructionsWritten).toBe(true);
    const agentsMd = readFileSync(join(root, 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain('section=claude-adapter');
    expect(agentsMd).not.toContain('section=ticket-driven-work');

    const skill = readFileSync(join(root, '.agents', 'skills', 'hotsheet', 'SKILL.md'), 'utf-8');
    expect(skill).toContain('../../../.claude/skills/hotsheet/SKILL.md');
    expect(res.status.needed).toBe(false);
  });

  it('is idempotent — a second prepare is a no-op', () => {
    setAiTool('codex');
    prepareToolConfig(root, dataDir);
    const second = prepareToolConfig(root, dataDir);
    expect(second.instructionsWritten).toBe(false);
    expect(second.platforms).toEqual([]);
    expect(second.status.needed).toBe(false);
  });
});
