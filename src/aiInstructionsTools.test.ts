// HS-8916 — per-tool AI-instruction file writers (Cursor/Windsurf/Copilot + Claude).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  adapterConversionPlanFor,
  anyAiToolDetected,
  convertToolFileToAdapter,
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

  it('HS-9375 — AUTO-retires a full-mode AGENTS.md whose specifics are all unfilled (lossless)', () => {
    // Full sections installed pre-adapter-era (no canonical source yet)…
    expect(writeInstructionsForTool(root, 'antigravity')).toBe(true);
    // …then the canonical source appears. Every specifics block still carries the
    // needs-setup sentinel, so conversion loses nothing → automatic.
    makeCanonical();
    expect(writeInstructionsForTool(root, 'antigravity')).toBe(true); // the conversion write
    const content = readFileSync(join(root, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('section=claude-adapter');
    expect(content).not.toContain('section=ticket-driven-work'); // duplicates retired
    // Idempotent afterwards.
    expect(writeInstructionsForTool(root, 'antigravity')).toBe(false);
  });

  it('HS-9375 — a full-mode AGENTS.md with FILLED specifics stays full (conversion is ask-first)', () => {
    writeInstructionsForTool(root, 'antigravity');
    // The user filled in the testing specifics (sentinel removed) in AGENTS.md.
    const path = join(root, 'AGENTS.md');
    const filled = readFileSync(path, 'utf-8').replace(
      /<!-- hotsheet:begin specifics=testing-philosophy v=\d+ -->[\s\S]*?<!-- hotsheet:end specifics=testing-philosophy -->/,
      '<!-- hotsheet:begin specifics=testing-philosophy v=1 -->\nMY FILLED TEST SETUP\n<!-- hotsheet:end specifics=testing-philosophy -->',
    );
    writeFileSync(path, filled, 'utf-8');
    makeCanonical(); // CLAUDE.md exists but has no sections → migratable, not lossless

    expect(writeInstructionsForTool(root, 'antigravity')).toBe(false); // no silent conversion
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('section=ticket-driven-work'); // kept full
    expect(content).toContain('MY FILLED TEST SETUP');       // user content untouched
    expect(content).not.toContain('section=claude-adapter');
    // …but the ask-first plan reports it as migratable.
    expect(adapterConversionPlanFor(root, 'antigravity')?.outcome).toBe('migratable');
  });

  it('HS-9375 — convertToolFileToAdapter migrates the filled specifics into CLAUDE.md, then retires', () => {
    writeInstructionsForTool(root, 'antigravity');
    const path = join(root, 'AGENTS.md');
    const filled = readFileSync(path, 'utf-8').replace(
      /<!-- hotsheet:begin specifics=testing-philosophy v=\d+ -->[\s\S]*?<!-- hotsheet:end specifics=testing-philosophy -->/,
      '<!-- hotsheet:begin specifics=testing-philosophy v=1 -->\nMY FILLED TEST SETUP\n<!-- hotsheet:end specifics=testing-philosophy -->',
    );
    writeFileSync(path, filled, 'utf-8');
    makeCanonical();

    expect(convertToolFileToAdapter(root, 'antigravity')).toBe(true);
    const agents = readFileSync(path, 'utf-8');
    expect(agents).toContain('section=claude-adapter');
    expect(agents).not.toContain('MY FILLED TEST SETUP'); // moved, not duplicated
    const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('MY FILLED TEST SETUP');   // …into the canonical file
    // Post-conversion, the normal write is a no-op (adapter current).
    expect(writeInstructionsForTool(root, 'antigravity')).toBe(false);
  });

  it('HS-9375 — a CONFLICTING filled block (differs from a filled CLAUDE.md one) blocks conversion', () => {
    writeInstructionsForTool(root, 'antigravity');
    const fill = (content: string, text: string): string => content.replace(
      /<!-- hotsheet:begin specifics=testing-philosophy v=\d+ -->[\s\S]*?<!-- hotsheet:end specifics=testing-philosophy -->/,
      `<!-- hotsheet:begin specifics=testing-philosophy v=1 -->\n${text}\n<!-- hotsheet:end specifics=testing-philosophy -->`,
    );
    const path = join(root, 'AGENTS.md');
    writeFileSync(path, fill(readFileSync(path, 'utf-8'), 'AGENTS VERSION'), 'utf-8');
    // CLAUDE.md carries the full sections too, with a DIFFERENT filled block.
    writeInstructionsForTool(root, 'claude');
    const cm = join(root, 'CLAUDE.md');
    writeFileSync(cm, fill(readFileSync(cm, 'utf-8'), 'CLAUDE VERSION'), 'utf-8');
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true });

    expect(adapterConversionPlanFor(root, 'antigravity')?.outcome).toBe('conflict');
    expect(convertToolFileToAdapter(root, 'antigravity')).toBe(false); // refuses
    expect(readFileSync(path, 'utf-8')).toContain('AGENTS VERSION');   // nothing touched
    expect(readFileSync(cm, 'utf-8')).toContain('CLAUDE VERSION');
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

  // HS-9374 — Gemini CLI: GEMINI.md instruction file whose adapter references
  // ITS skills root (`.gemini/skills`, verified against gemini-cli 0.49.0).
  it('gemini: writes a GEMINI.md adapter referencing .gemini/skills when canonical exists', () => {
    makeCanonical();
    expect(writeInstructionsForTool(root, 'gemini')).toBe(true);
    const content = readFileSync(join(root, 'GEMINI.md'), 'utf-8');
    expect(content).toContain('section=claude-adapter');
    expect(content).toContain('`.gemini/skills/`');
    expect(content).not.toContain('`.agents/skills/`'); // gemini's root, not the AGENTS family's
    expect(content).not.toContain('section=ticket-driven-work');
  });

  it('gemini: full sections in GEMINI.md without a canonical source', () => {
    writeInstructionsForTool(root, 'gemini');
    const content = readFileSync(join(root, 'GEMINI.md'), 'utf-8');
    expect(content).toContain('section=ticket-driven-work');
    expect(content).not.toContain('section=claude-adapter');
  });

  it('the AGENTS.md adapter text is IDENTICAL for all tools sharing the file (no rewrite ping-pong)', () => {
    makeCanonical();
    writeInstructionsForTool(root, 'codex');
    const afterCodex = readFileSync(join(root, 'AGENTS.md'), 'utf-8');
    // A different AGENTS.md-family tool writing the same file must be a NO-OP —
    // if their adapter texts diverged, auto mode would rewrite on every pass.
    expect(writeInstructionsForTool(root, 'antigravity')).toBe(false);
    expect(writeInstructionsForTool(root, 'opencode')).toBe(false);
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf-8')).toBe(afterCodex);
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
