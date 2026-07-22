/**
 * HS-9367 (docs/119) — per-tool config PREPARATION for an `ai_tool` switch (and
 * the project-open drift check). Answers two questions for the project's
 * currently-selected tool:
 *
 *  - **status** (`getToolPrepStatus`) — is anything MISSING or STALE for this
 *    tool: its instruction file (adapter-aware via HS-9366's `sectionSetFor`)
 *    and/or its main generated skill artifact (absent or version-behind)?
 *  - **prepare** (`prepareToolConfig`) — write the full config for the tool by
 *    reusing the existing idempotent generators: `writeInstructionsForTool`
 *    (instruction file, adapter mode when the canonical Claude source exists)
 *    + `ensureSkillsForDir` (skills + MCP registration + permissions/hooks,
 *    already narrowed to the selected tool by `wantsTool`).
 *
 * The client uses status to decide whether to ASK FIRST (the §86-style nudge —
 * "Prepare Codex config for this project?") before anything is written to the
 * repo on a dropdown change, and fires the same check on project open (the L1
 * drift fallback). `auto` never needs preparation — it keeps the silent
 * detect-and-seed-everything behavior.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { type AiInstructionTool, getInstructionsStatesForTools, instructionFileRelPath, writeInstructionsForTool } from './aiInstructionsTools.js';
import { AI_INSTRUCTION_TOOLS } from './api/aiInstructions.js';
import { readFileSettings } from './file-settings.js';
import { ensureSkillsForDir, parseVersionHeader, SKILL_VERSION } from './skills.js';
import type { CategoryDef } from './types.js';

export interface ToolPrepStatus {
  /** The project's selected `ai_tool` (normalized; `auto` when unset). */
  aiTool: string;
  /** The mapped instruction tool, or null when the tool has no instruction
   *  convention yet (gemini/goose) or the selection is `auto`. */
  instructionTool: AiInstructionTool | null;
  /** Instruction file missing/outdated for the tool (adapter-aware). */
  instructionsNeeded: boolean;
  /** Repo-relative instruction file path for UI copy (null when unmapped). */
  instructionsPath: string | null;
  /** Main generated skill artifact absent or version-stale. */
  skillsNeeded: boolean;
  /** Repo-relative main skill artifact path (null = tool has no skill format). */
  skillsPath: string | null;
  /** instructionsNeeded || skillsNeeded — drives the ask-first nudge. */
  needed: boolean;
}

/** The main generated skill artifact per `ai_tool` — the file whose presence +
 *  version header tell us whether the tool's skills are prepared. Mirrors the
 *  generator targets in `skills.ts` (`ensureClaudeSkills` /
 *  `ensureAgentsFamilySkills` / `ensureCursorRules` / `ensureWindsurfRules` /
 *  `ensureCopilotPrompts`). Null → no skill format for the tool (opencode /
 *  gemini / goose — see HS-9374). */
export function skillArtifactRelPath(aiTool: string): string | null {
  switch (aiTool) {
    case 'claude': return join('.claude', 'skills', 'hotsheet', 'SKILL.md');
    case 'antigravity':
    case 'codex': return join('.agents', 'skills', 'hotsheet', 'SKILL.md');
    case 'cursor': return join('.cursor', 'rules', 'hotsheet.mdc');
    case 'windsurf': return join('.windsurf', 'rules', 'hotsheet.md');
    case 'copilot': return join('.github', 'prompts', 'hotsheet.prompt.md');
    default: return null;
  }
}

function isInstructionTool(aiTool: string): aiTool is AiInstructionTool {
  return (AI_INSTRUCTION_TOOLS as readonly string[]).includes(aiTool);
}

/** Is the tool's main skill artifact absent or version-behind? Injectable fs
 *  probes for unit tests. */
export function skillArtifactStale(
  projectRoot: string,
  relPath: string,
  deps: { fileExists?: (p: string) => boolean; readFile?: (p: string) => string } = {},
): boolean {
  const fileExists = deps.fileExists ?? existsSync;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf-8'));
  const path = join(projectRoot, relPath);
  if (!fileExists(path)) return true;
  try {
    const version = parseVersionHeader(readFile(path));
    return version === null || version < SKILL_VERSION;
  } catch {
    return true; // unreadable → treat as needing preparation
  }
}

/** The selected tool's preparation status for a project. */
export function getToolPrepStatus(projectRoot: string, dataDir: string): ToolPrepStatus {
  const raw = readFileSettings(dataDir).ai_tool;
  const aiTool = typeof raw === 'string' && raw.trim() !== '' ? raw.trim().toLowerCase() : 'auto';

  // `auto` = detect-and-seed-everything; nothing tool-specific to prepare (the
  // existing detected-tool flows already cover it silently).
  if (aiTool === 'auto') {
    return { aiTool, instructionTool: null, instructionsNeeded: false, instructionsPath: null, skillsNeeded: false, skillsPath: null, needed: false };
  }

  const instructionTool = isInstructionTool(aiTool) ? aiTool : null;
  let instructionsNeeded = false;
  let instructionsPath: string | null = null;
  if (instructionTool !== null) {
    instructionsPath = instructionFileRelPath(instructionTool);
    const st = getInstructionsStatesForTools(projectRoot).find(s => s.tool === instructionTool);
    // `setupNeeded` = missing || outdated, evaluated against the section set the
    // file SHOULD carry (adapter-aware, HS-9366) — exactly "prep needed".
    instructionsNeeded = st !== undefined && st.setupNeeded;
  }

  const skillsPath = skillArtifactRelPath(aiTool);
  const skillsNeeded = skillsPath !== null && skillArtifactStale(projectRoot, skillsPath);

  return { aiTool, instructionTool, instructionsNeeded, instructionsPath, skillsNeeded, skillsPath, needed: instructionsNeeded || skillsNeeded };
}

export interface ToolPrepResult {
  /** Whether the instruction file was (re)written. */
  instructionsWritten: boolean;
  /** Platform labels `ensureSkillsForDir` reported as updated. */
  platforms: string[];
  /** Post-write status (should read `needed: false` for a mapped tool). */
  status: ToolPrepStatus;
}

/**
 * Prepare the FULL config for the project's selected tool: instruction file
 * (adapter mode via HS-9366 when the canonical Claude source exists) + skills +
 * MCP registration + permissions/hooks. Everything is idempotent and
 * non-destructive — re-running on an already-prepared project is a no-op.
 */
export function prepareToolConfig(projectRoot: string, dataDir: string, categories?: CategoryDef[]): ToolPrepResult {
  const before = getToolPrepStatus(projectRoot, dataDir);
  let instructionsWritten = false;
  if (before.instructionTool !== null) {
    instructionsWritten = writeInstructionsForTool(projectRoot, before.instructionTool);
  }
  // Skills + MCP config + permissions/hooks — `wantsTool(dataDir)` inside
  // narrows generation to the selected tool.
  const platforms = ensureSkillsForDir(projectRoot, categories, dataDir);
  return { instructionsWritten, platforms, status: getToolPrepStatus(projectRoot, dataDir) };
}
