// HS-8916 (docs/86 §86.6) — extend the managed AI-instruction sections beyond
// CLAUDE.md to the other AI tools Hot Sheet detects: Cursor (`.cursor/rules/*.mdc`),
// Windsurf (`.windsurf/rules/*.md`), and GitHub Copilot
// (`.github/copilot-instructions.md`). Reuses the pure section/marker/versioning
// core from `aiInstructions.ts` — the ONLY per-tool differences are the target
// file path, the (Cursor/Windsurf) YAML frontmatter, and the detection predicate.
// Detection mirrors `skills.ts::ensureSkillsForDir` (PATH probe + folder presence).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import { ADAPTER_SECTIONS, applyManagedSections, canonicalClaudeSourceExists, getInstructionsStatus, type InstructionsStatus, MANAGED_SECTIONS,type ManagedSection } from './aiInstructions.js';
import type { AI_INSTRUCTION_TOOLS } from './api/aiInstructions.js';
import { isExecutableOnPath } from './utils/isExecutableOnPath.js';

// HS-9366 — derived from the wire SSOT (`src/api/aiInstructions.ts`), so adding
// a tool to the server table without the client schema is a compile error (the
// HS-9322/HS-9344 drift silently broke `/ai-instructions/status` validation).
export type AiInstructionTool = typeof AI_INSTRUCTION_TOOLS[number];

/**
 * HS-9366 (docs/118) — the AGENTS-family tools (their instruction file is
 * `AGENTS.md`) support ADAPTER MODE: when the project has a canonical Claude
 * source (`CLAUDE.md` + `.claude/skills`), their file gets the thin
 * `ADAPTER_SECTIONS` reference ("CLAUDE.md is the shared source of truth")
 * instead of a duplicate of the full managed sections.
 */
const AGENTS_FAMILY: ReadonlySet<AiInstructionTool> = new Set(['antigravity', 'opencode', 'codex']);

const SECTION_DESCRIPTION = 'Hot Sheet — ticket-driven work, testing, and requirements-doc conventions';

// Cursor `.mdc` rules need YAML frontmatter (`description` + `alwaysApply`);
// Windsurf `.md` rules need `trigger` + `description`. Claude/Copilot are plain
// markdown. Frontmatter is written only when CREATING a file; on update the
// existing frontmatter is preserved (`splitFrontmatter`).
const CURSOR_FRONTMATTER = `---\ndescription: ${SECTION_DESCRIPTION}\nalwaysApply: false\n---\n`;
const WINDSURF_FRONTMATTER = `---\ntrigger: manual\ndescription: ${SECTION_DESCRIPTION}\n---\n`;

interface ToolTarget {
  tool: AiInstructionTool;
  label: string;
  /** Path relative to the project root. */
  relPath: string;
  /** Frontmatter written when the file is first created ('' for plain markdown). */
  frontmatter: string;
  /** Is this tool used for the project? */
  detect: (projectRoot: string) => boolean;
}

const TOOLS: readonly ToolTarget[] = [
  {
    tool: 'claude', label: 'Claude Code', relPath: 'CLAUDE.md', frontmatter: '',
    detect: (r) => isExecutableOnPath('claude') || existsSync(join(r, '.claude')) || existsSync(join(r, 'CLAUDE.md')),
  },
  {
    tool: 'cursor', label: 'Cursor', relPath: join('.cursor', 'rules', 'hotsheet-instructions.mdc'), frontmatter: CURSOR_FRONTMATTER,
    detect: (r) => isExecutableOnPath('cursor') || existsSync(join(r, '.cursor')),
  },
  {
    tool: 'windsurf', label: 'Windsurf', relPath: join('.windsurf', 'rules', 'hotsheet-instructions.md'), frontmatter: WINDSURF_FRONTMATTER,
    detect: (r) => isExecutableOnPath('windsurf') || existsSync(join(r, '.windsurf')),
  },
  {
    tool: 'copilot', label: 'GitHub Copilot', relPath: join('.github', 'copilot-instructions.md'), frontmatter: '',
    detect: (r) => existsSync(join(r, '.github', 'copilot-instructions.md')) || existsSync(join(r, '.github', 'prompts')),
  },
  {
    // HS-9322 — Antigravity (`agy`) reads the AGENTS.md standard (verified in the
    // agy binary: instruction paths `GEMINI.md` / `AGENTS.md` / `.agents/rules/*.md`).
    // Plain markdown, repo root. Gives agy the same managed Hot Sheet sections as
    // CLAUDE.md. (The /hotsheet worklist SKILL — agy's `.agents/skills/` format — is
    // a separate follow-on; see HS-9322 notes.)
    tool: 'antigravity', label: 'Antigravity', relPath: 'AGENTS.md', frontmatter: '',
    detect: (r) => isExecutableOnPath('agy') || existsSync(join(r, 'AGENTS.md')),
  },
  {
    // HS-9344 — OpenCode (the lead ACP agent, docs/114) reads the same AGENTS.md
    // standard, so an opencode-driven project gets the managed Hot Sheet sections too.
    // Shares the AGENTS.md file with the Antigravity entry above — when both are present
    // the file is written twice, which is idempotent (`applyManagedSections` no-ops when
    // unchanged), so no special-casing is needed.
    tool: 'opencode', label: 'OpenCode', relPath: 'AGENTS.md', frontmatter: '',
    detect: (r) => isExecutableOnPath('opencode') || existsSync(join(r, 'AGENTS.md')),
  },
  {
    // HS-9366 (docs/118) — Codex reads the AGENTS.md standard (+ `.agents/skills`,
    // the video-studio model). Shares the AGENTS.md file with the two entries above
    // (idempotent double-write, same as the OpenCode note).
    tool: 'codex', label: 'Codex', relPath: 'AGENTS.md', frontmatter: '',
    detect: (r) => isExecutableOnPath('codex') || existsSync(join(r, 'AGENTS.md')),
  },
];

/**
 * HS-9366 — which section set a tool's instruction file should carry.
 * AGENTS-family + canonical Claude source present → the thin adapter, UNLESS the
 * file already contains any full managed section: a pre-adapter-era file keeps
 * full mode (grandfathered), because converting it would delete our marker
 * blocks — including a possibly user-filled specifics sub-block. Retiring those
 * duplicates is the HS-9358 L3 "retire stale files" work, out of scope here.
 */
function sectionSetFor(projectRoot: string, tool: AiInstructionTool, existingBody: string): ManagedSection[] {
  if (!AGENTS_FAMILY.has(tool)) return MANAGED_SECTIONS;
  if (!canonicalClaudeSourceExists(projectRoot)) return MANAGED_SECTIONS;
  const fullPresent = getInstructionsStatus(existingBody).sections.some(s => s.present);
  return fullPresent ? MANAGED_SECTIONS : ADAPTER_SECTIONS;
}

/**
 * Split a leading YAML frontmatter block (`---\n…\n---\n`) from the body. Pure.
 * A file with no frontmatter yields `{ frontmatter: '', body: content }` — so the
 * managed-section logic (which operates on the body) is identical for plain
 * (Claude/Copilot) and frontmatter (Cursor/Windsurf) files.
 */
export function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const m = /^(---\n[\s\S]*?\n---\n)/.exec(content);
  if (m === null) return { frontmatter: '', body: content };
  return { frontmatter: m[1], body: content.slice(m[1].length) };
}

/** Join frontmatter + section content with a blank line when frontmatter exists. */
function joinFrontmatter(frontmatter: string, content: string): string {
  if (frontmatter === '') return content;
  return `${frontmatter.replace(/\s+$/, '')}\n\n${content}`;
}

export interface ToolInstructionsState extends InstructionsStatus {
  tool: AiInstructionTool;
  label: string;
  /** Whether this tool is used for the project (drives the nudge + which files to write). */
  detected: boolean;
  /** Whether the tool's instruction file currently exists. */
  fileExists: boolean;
}

function stateForTarget(projectRoot: string, t: ToolTarget): ToolInstructionsState {
  const path = join(projectRoot, t.relPath);
  const exists = existsSync(path);
  let body = '';
  if (exists) {
    try { body = splitFrontmatter(readFileSync(path, 'utf-8')).body; } catch { /* unreadable → treat as empty */ }
  }
  // HS-9366 — evaluate against the section set the file SHOULD carry, so an
  // adapter-mode AGENTS.md isn't forever reported "missing" the full sections.
  return { ...getInstructionsStatus(body, sectionSetFor(projectRoot, t.tool, body)), tool: t.tool, label: t.label, detected: t.detect(projectRoot), fileExists: exists };
}

/** The managed-section state for every supported tool. */
export function getInstructionsStatesForTools(projectRoot: string): ToolInstructionsState[] {
  return TOOLS.map(t => stateForTarget(projectRoot, t));
}

/** Install / update the managed sections in one tool's instruction file (creating
 *  dirs + frontmatter as needed). Returns whether the file was written. */
export function writeInstructionsForTool(projectRoot: string, tool: AiInstructionTool): boolean {
  const t = TOOLS.find(x => x.tool === tool);
  if (t === undefined) return false;
  const path = join(projectRoot, t.relPath);
  const existed = existsSync(path);
  let frontmatter = t.frontmatter;
  let body = '';
  if (existed) {
    try {
      const split = splitFrontmatter(readFileSync(path, 'utf-8'));
      // Preserve whatever frontmatter the file already has (the user may have
      // customized it); only supply our default when creating.
      frontmatter = split.frontmatter;
      body = split.body;
    } catch { /* unreadable → recreate from scratch */ frontmatter = t.frontmatter; }
  }
  // HS-9366 — AGENTS-family files in adapter mode get the thin CLAUDE.md
  // reference instead of a duplicate of the full sections.
  const { content, changed } = applyManagedSections(body, sectionSetFor(projectRoot, tool, body));
  if (existed && !changed) return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, joinFrontmatter(frontmatter, content), 'utf-8');
    return true;
  } catch (err: unknown) {
    if (err instanceof Error) console.warn(`[ai-instructions] Failed to write ${t.relPath} in ${projectRoot}: ${err.message}`);
    return false;
  }
}

/** Write the managed sections to EVERY detected tool's instruction file. Returns
 *  the per-tool result (only detected tools are touched). */
export function writeInstructionsForDetectedTools(projectRoot: string): { tool: AiInstructionTool; written: boolean }[] {
  return TOOLS.filter(t => t.detect(projectRoot)).map(t => ({ tool: t.tool, written: writeInstructionsForTool(projectRoot, t.tool) }));
}

/** Any AI tool detected for the project (gates the once-per-project nudge across
 *  all tools, not just Claude). */
export function anyAiToolDetected(projectRoot: string): boolean {
  return TOOLS.some(t => t.detect(projectRoot));
}
