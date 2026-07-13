// HS-8916 — per-tool AI-instruction file writers (Cursor/Windsurf/Copilot + Claude).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  anyAiToolDetected,
  splitFrontmatter,
  writeInstructionsForDetectedTools,
  writeInstructionsForTool,
} from './aiInstructionsTools.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hs-aitools-')); });
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('splitFrontmatter', () => {
  it('separates a YAML frontmatter block from the body', () => {
    const { frontmatter, body } = splitFrontmatter('---\ndescription: x\nalwaysApply: false\n---\n\n## Body\ntext');
    expect(frontmatter).toBe('---\ndescription: x\nalwaysApply: false\n---\n');
    expect(body).toBe('\n## Body\ntext');
  });

  it('returns empty frontmatter for plain markdown', () => {
    const { frontmatter, body } = splitFrontmatter('## Just markdown\ntext');
    expect(frontmatter).toBe('');
    expect(body).toBe('## Just markdown\ntext');
  });
});

describe('writeInstructionsForTool', () => {
  it('creates CLAUDE.md (no frontmatter) with the managed sections', () => {
    expect(writeInstructionsForTool(root, 'claude')).toBe(true);
    const content = readFileSync(join(root, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('hotsheet:begin section=ticket-driven-work');
    expect(content.startsWith('---')).toBe(false); // no frontmatter for Claude
  });

  it('creates a Cursor .mdc with YAML frontmatter + the managed sections', () => {
    expect(writeInstructionsForTool(root, 'cursor')).toBe(true);
    const path = join(root, '.cursor', 'rules', 'hotsheet-instructions.mdc');
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf-8');
    expect(content.startsWith('---\n')).toBe(true);
    expect(content).toContain('alwaysApply: false');
    expect(content).toContain('hotsheet:begin section=ticket-driven-work');
  });

  it('creates a Windsurf .md with a `trigger: manual` frontmatter', () => {
    writeInstructionsForTool(root, 'windsurf');
    const content = readFileSync(join(root, '.windsurf', 'rules', 'hotsheet-instructions.md'), 'utf-8');
    expect(content).toContain('trigger: manual');
    expect(content).toContain('hotsheet:begin');
  });

  it('creates AGENTS.md (no frontmatter) for Antigravity — HS-9322', () => {
    expect(writeInstructionsForTool(root, 'antigravity')).toBe(true);
    const content = readFileSync(join(root, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('hotsheet:begin section=ticket-driven-work');
    expect(content.startsWith('---')).toBe(false); // plain markdown, like CLAUDE.md
  });

  it('creates AGENTS.md for OpenCode (same shared file as Antigravity) — HS-9344', () => {
    expect(writeInstructionsForTool(root, 'opencode')).toBe(true);
    const content = readFileSync(join(root, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('hotsheet:begin section=ticket-driven-work');
    expect(content.startsWith('---')).toBe(false);
    // Shared AGENTS.md: a second write via the Antigravity entry is an idempotent no-op.
    expect(writeInstructionsForTool(root, 'antigravity')).toBe(false);
  });

  it('is idempotent — a second write of an up-to-date file returns false', () => {
    expect(writeInstructionsForTool(root, 'cursor')).toBe(true);
    expect(writeInstructionsForTool(root, 'cursor')).toBe(false);
  });

  it('preserves the file’s existing frontmatter on update', () => {
    const dir = join(root, '.cursor', 'rules');
    mkdirSync(dir, { recursive: true });
    // A pre-existing file with CUSTOM frontmatter + user content, no managed sections.
    writeFileSync(join(dir, 'hotsheet-instructions.mdc'), '---\ndescription: MY custom desc\nalwaysApply: true\n---\n\nMy own notes.\n');
    expect(writeInstructionsForTool(root, 'cursor')).toBe(true);
    const content = readFileSync(join(dir, 'hotsheet-instructions.mdc'), 'utf-8');
    expect(content).toContain('description: MY custom desc'); // custom frontmatter kept
    expect(content).toContain('alwaysApply: true');
    expect(content).toContain('My own notes.');                // user body kept
    expect(content).toContain('hotsheet:begin');               // managed sections appended
  });
});

describe('writeInstructionsForDetectedTools + anyAiToolDetected', () => {
  it('writes every folder-detected tool', () => {
    // Folder presence makes detection deterministic regardless of PATH (`claude` /
    // `cursor` may or may not be installed on the test host).
    mkdirSync(join(root, '.cursor'), { recursive: true });
    mkdirSync(join(root, '.windsurf'), { recursive: true });
    mkdirSync(join(root, '.github'), { recursive: true });
    writeFileSync(join(root, '.github', 'copilot-instructions.md'), '# existing\n');
    expect(anyAiToolDetected(root)).toBe(true);

    const tools = writeInstructionsForDetectedTools(root).map(r => r.tool);
    for (const t of ['cursor', 'windsurf', 'copilot'] as const) expect(tools).toContain(t);
    expect(existsSync(join(root, '.cursor', 'rules', 'hotsheet-instructions.mdc'))).toBe(true);
    expect(existsSync(join(root, '.windsurf', 'rules', 'hotsheet-instructions.md'))).toBe(true);
    expect(readFileSync(join(root, '.github', 'copilot-instructions.md'), 'utf-8')).toContain('hotsheet:begin');
  });
});
