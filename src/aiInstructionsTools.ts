// HS-8916 (docs/86 §86.6) — extend the managed AI-instruction sections beyond
// CLAUDE.md to the other AI tools Hot Sheet detects: Cursor (`.cursor/rules/*.mdc`),
// Windsurf (`.windsurf/rules/*.md`), and GitHub Copilot
// (`.github/copilot-instructions.md`). Reuses the pure section/marker/versioning
// core from `aiInstructions.ts` — the ONLY per-tool differences are the target
// file path, the (Cursor/Windsurf) YAML frontmatter, and the detection predicate.
// Detection mirrors `skills.ts::ensureSkillsForDir` (PATH probe + folder presence).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import { ADAPTER_SECTIONS, type AdapterConversionPlan, applyManagedSections, canonicalClaudeSourceExists, claudeMdPath, convertBodyToAdapter, getInstructionsStatus, type InstructionsStatus, MANAGED_SECTIONS,type ManagedSection, planAdapterConversion, readClaudeMd, removeManagedSections } from './aiInstructions.js';
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
 * HS-9366 / HS-9375 (docs/118 §118.3, docs/120) — which section set a tool's
 * instruction file should carry, and whether the old full sections should be
 * STRIPPED first (the adapter retirement).
 *
 * AGENTS-family + canonical Claude source present → the thin adapter. A file
 * that already carries the full sections (pre-adapter era):
 *  - **lossless** (every specifics block still scaffolded/absent) → converted
 *    automatically: strip our marker blocks, install the adapter. Nothing
 *    user-authored is deleted.
 *  - **migratable** (a filled specifics block whose CLAUDE.md counterpart is
 *    unfilled/absent) → stays FULL here; conversion is ask-first via the
 *    HS-9367 tool-prep flow (`prepareToolConfig` migrates the filled blocks
 *    into CLAUDE.md, then converts).
 *  - **conflict** (filled block differing from a filled CLAUDE.md one) → stays
 *    FULL; the user must reconcile (docs/120 §120.4).
 */
function sectionSetFor(projectRoot: string, tool: AiInstructionTool, existingBody: string): { sections: ManagedSection[]; stripFullSections: boolean } {
  if (!AGENTS_FAMILY.has(tool)) return { sections: MANAGED_SECTIONS, stripFullSections: false };
  if (!canonicalClaudeSourceExists(projectRoot)) return { sections: MANAGED_SECTIONS, stripFullSections: false };
  const fullPresent = getInstructionsStatus(existingBody).sections.some(s => s.present);
  if (!fullPresent) return { sections: ADAPTER_SECTIONS, stripFullSections: false };
  const plan = planAdapterConversion(existingBody, readClaudeMd(projectRoot) ?? '');
  if (plan.outcome === 'lossless' || plan.outcome === 'not-applicable') {
    return { sections: ADAPTER_SECTIONS, stripFullSections: true };
  }
  return { sections: MANAGED_SECTIONS, stripFullSections: false };
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
  // (A lossless-convertible full-mode file reports against the ADAPTER set —
  // its "missing adapter section" drives the automatic HS-9375 conversion via
  // the §86 silent-update / apply path.)
  return { ...getInstructionsStatus(body, sectionSetFor(projectRoot, t.tool, body).sections), tool: t.tool, label: t.label, detected: t.detect(projectRoot), fileExists: exists };
}

/** The managed-section state for every supported tool. */
export function getInstructionsStatesForTools(projectRoot: string): ToolInstructionsState[] {
  return TOOLS.map(t => stateForTarget(projectRoot, t));
}

/** HS-9367 — a tool's instruction file path relative to the project root (for
 *  the tool-prep status/nudge copy). Null for an unknown tool id. */
export function instructionFileRelPath(tool: AiInstructionTool): string | null {
  return TOOLS.find(t => t.tool === tool)?.relPath ?? null;
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
  // reference instead of a duplicate of the full sections. HS-9375 — a
  // grandfathered full-mode file whose conversion is LOSSLESS is retired here:
  // strip our old marker blocks, then install the adapter section.
  const mode = sectionSetFor(projectRoot, tool, body);
  const baseBody = mode.stripFullSections ? removeManagedSections(body) : body;
  const { content } = applyManagedSections(baseBody, mode.sections);
  const changed = content !== body; // vs the ORIGINAL body — a strip alone is a change
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

/**
 * HS-9375 (docs/120) — the retirement plan for a tool's instruction file, or
 * null when retirement doesn't apply (not AGENTS-family, no canonical source,
 * file absent/unreadable, or no full sections present). `migratable` drives the
 * ask-first offer in the HS-9367 tool-prep flow; `lossless` converts silently
 * inside `writeInstructionsForTool`; `conflict` stays full-mode.
 */
export function adapterConversionPlanFor(projectRoot: string, tool: AiInstructionTool): AdapterConversionPlan | null {
  if (!AGENTS_FAMILY.has(tool) || !canonicalClaudeSourceExists(projectRoot)) return null;
  const t = TOOLS.find(x => x.tool === tool);
  if (t === undefined) return null;
  const path = join(projectRoot, t.relPath);
  if (!existsSync(path)) return null;
  let body: string;
  try { body = splitFrontmatter(readFileSync(path, 'utf-8')).body; } catch { return null; }
  if (!getInstructionsStatus(body).sections.some(s => s.present)) return null;
  return planAdapterConversion(body, readClaudeMd(projectRoot) ?? '');
}

/**
 * HS-9375 — perform the MIGRATABLE conversion for a tool's instruction file:
 * move its filled specifics blocks into CLAUDE.md (whose counterparts are
 * unfilled/absent — verified by the plan), strip the full sections, install the
 * thin adapter. Both files written. Returns false when the plan isn't
 * `lossless`/`migratable` (nothing written). Called from the ask-first
 * `prepareToolConfig` path — never silently.
 */
export function convertToolFileToAdapter(projectRoot: string, tool: AiInstructionTool): boolean {
  const t = TOOLS.find(x => x.tool === tool);
  if (t === undefined) return false;
  const path = join(projectRoot, t.relPath);
  if (!existsSync(path)) return false;
  let frontmatter = '';
  let body = '';
  try {
    const split = splitFrontmatter(readFileSync(path, 'utf-8'));
    frontmatter = split.frontmatter;
    body = split.body;
  } catch { return false; }
  const claudeMd = readClaudeMd(projectRoot) ?? '';
  const plan = planAdapterConversion(body, claudeMd);
  if (plan.outcome === 'conflict' || plan.outcome === 'not-applicable') return false;
  const res = convertBodyToAdapter(body, claudeMd);
  try {
    if (res.claudeMd !== claudeMd) writeFileSync(claudeMdPath(projectRoot), res.claudeMd, 'utf-8');
    writeFileSync(path, joinFrontmatter(frontmatter, res.agentsBody), 'utf-8');
    return true;
  } catch (err: unknown) {
    if (err instanceof Error) console.warn(`[ai-instructions] Adapter conversion failed for ${t.relPath} in ${projectRoot}: ${err.message}`);
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
