// HS-8916 — per-tool AI-instruction file writers (Cursor/Windsurf/Copilot + Claude).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  anyAiToolDetected,
  getInstructionsStatesForTools,
  splitFrontmatter,
  writeInstructionsForDetectedTools,
  writeInstructionsForTool,
} from './aiInstructionsTools.js';
import { ToolInstructionsStateSchema } from './api/aiInstructions.js';

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

// HS-9366 (docs/118) — adapter mode: AGENTS-family instruction files reference
// the canonical CLAUDE.md instead of duplicating the full managed sections.
describe('adapter mode (HS-9366)', () => {
  const makeCanonical = (): void => {
    writeFileSync(join(root, 'CLAUDE.md'), '# Project\n');
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
  };

  it('writes the thin adapter section into AGENTS.md when the canonical Claude source exists', () => {
    makeCanonical();
    expect(writeInstructionsForTool(root, 'codex')).toBe(true);
    const content = readFileSync(join(root, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('hotsheet:begin section=claude-adapter');
    expect(content).toContain('shared source of truth');
    expect(content).not.toContain('section=ticket-driven-work'); // no duplicated full sections
  });

  it('CLAUDE.md alone is NOT a canonical source (needs .claude/skills too) → full sections', () => {
    writeFileSync(join(root, 'CLAUDE.md'), '# Project\n');
    writeInstructionsForTool(root, 'codex');
    const content = readFileSync(join(root, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('section=ticket-driven-work');
    expect(content).not.toContain('section=claude-adapter');
  });

  it('no canonical source at all → full sections (a project that started on Codex)', () => {
    writeInstructionsForTool(root, 'codex');
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf-8')).toContain('section=ticket-driven-work');
  });

  it('grandfathers an AGENTS.md already carrying the full sections (no destructive conversion)', () => {
    // Full sections installed pre-adapter-era (no canonical source yet)…
    expect(writeInstructionsForTool(root, 'antigravity')).toBe(true);
    // …then the canonical source appears. Retiring the duplicate is HS-9358 L3;
    // for now the file stays in full mode and stays up to date.
    makeCanonical();
    expect(writeInstructionsForTool(root, 'antigravity')).toBe(false); // already current in full mode
    const content = readFileSync(join(root, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('section=ticket-driven-work');
    expect(content).not.toContain('section=claude-adapter');
  });

  it('adapter write is idempotent and preserves user content around the section', () => {
    makeCanonical();
    writeFileSync(join(root, 'AGENTS.md'), '# My agents notes\n\nCustom content.\n');
    expect(writeInstructionsForTool(root, 'codex')).toBe(true);
    expect(writeInstructionsForTool(root, 'codex')).toBe(false); // no-op second time
    const content = readFileSync(join(root, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('Custom content.');            // user content kept
    expect(content).toContain('section=claude-adapter');     // adapter appended
  });

  it('non-AGENTS tools keep the full sections even with a canonical source', () => {
    makeCanonical();
    writeInstructionsForTool(root, 'cursor');
    const content = readFileSync(join(root, '.cursor', 'rules', 'hotsheet-instructions.mdc'), 'utf-8');
    expect(content).toContain('section=ticket-driven-work');
    expect(content).not.toContain('section=claude-adapter');
  });

  it('status reflects adapter mode — an adapter AGENTS.md is not "missing" the full sections', () => {
    makeCanonical();
    writeInstructionsForTool(root, 'codex');
    const codex = getInstructionsStatesForTools(root).find(s => s.tool === 'codex');
    expect(codex).toBeDefined();
    expect(codex?.setupNeeded).toBe(false);
    expect(codex?.fileExists).toBe(true);
  });

  it('detects codex via AGENTS.md presence', () => {
    writeFileSync(join(root, 'AGENTS.md'), '# existing\n');
    const codex = getInstructionsStatesForTools(root).find(s => s.tool === 'codex');
    expect(codex?.detected).toBe(true);
  });

  it('every server tool-state row validates against the wire schema (HS-9366 regression guard)', () => {
    // HS-9322/HS-9344 added tools to the server TOOLS table without extending the
    // client wire enum, so EVERY `/ai-instructions/status` response failed zod
    // validation and the §86 nudge/silent-update path was silently dead. The tool
    // id list is now a shared SSOT; this pins server output ⊆ wire schema.
    for (const st of getInstructionsStatesForTools(root)) {
      const parsed = ToolInstructionsStateSchema.safeParse(st);
      expect(parsed.success, `tool row '${st.tool}' must validate against the wire schema`).toBe(true);
    }
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
