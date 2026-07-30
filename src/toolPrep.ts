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
import { join, sep } from 'path';

import { adapterConversionPlanFor, type AiInstructionTool, convertToolFileToAdapter, getInstructionsStatesForTools, instructionFileRelPath, writeInstructionsForTool } from './aiInstructionsTools.js';
import { skillsCapabilityFor } from './aiTools/serverCapabilities.js';
import { AI_INSTRUCTION_TOOLS } from './api/aiInstructions.js';
import { readFileSettings } from './file-settings.js';
import { ensureSkillsForDir, parseVersionHeader, SKILL_VERSION } from './skills.js';
import type { CategoryDef } from './types.js';

export interface ToolPrepStatus {
  /** The project's selected `ai_tool` (normalized; `auto` when unset). */
  aiTool: string;
  /** The mapped instruction tool, or null when the tool has no instruction
   *  convention yet (goose — unverified, HS-9374) or the selection is `auto`. */
  instructionTool: AiInstructionTool | null;
  /** Instruction file missing/outdated for the tool (adapter-aware). */
  instructionsNeeded: boolean;
  /** Repo-relative instruction file path for UI copy (null when unmapped). */
  instructionsPath: string | null;
  /** Main generated skill artifact absent or version-stale. */
  skillsNeeded: boolean;
  /** Repo-relative main skill artifact path (null = tool has no skill format). */
  skillsPath: string | null;
  /** HS-9375 (docs/120) — the tool's instruction file still carries the FULL
   *  duplicated sections with user-FILLED specifics that can be safely migrated
   *  into CLAUDE.md; the prep dialog offers the conversion (ask-first).
   *  (`lossless` conversions happen automatically; `conflict` is never offered.) */
  conversionOffered: boolean;
  /** instructionsNeeded || skillsNeeded — drives the ask-first nudge (the client
   *  also dialogs on `conversionOffered`). */
  needed: boolean;
}

/** The main generated skill artifact per `ai_tool` — the file whose presence +
 *  version header tell us whether the tool's skills are prepared. Null → no skill
 *  format for the tool (goose — unverified, see HS-9374).
 *
 *  HS-9503 — the per-tool answer now comes from the plugin's skills capability, which
 *  also owns the generator, so the two cannot drift. They used to be a switch here and
 *  an if-chain in `skills.ts`, and a mismatch between them is the docs/119 failure where
 *  prep reports "needed" forever because it checks a path nothing writes.
 *
 *  HS-9374 — `projectRoot` disambiguates OpenCode, whose generator targets the CANONICAL
 *  `.claude/skills` when it exists (OpenCode reads it directly) and the shared
 *  `.agents/skills` otherwise. */
export function skillArtifactRelPath(aiTool: string, projectRoot?: string): string | null {
  // HS-9503 — was a switch over every tool; now the plugin's skills capability owns it
  // (docs/132 §132.11.1). `projectRoot` stays optional for callers that only want the
  // static answer: OpenCode is the sole tool whose target depends on the filesystem, and
  // without a root it falls back to the same `.agents/skills` a project with no
  // canonical Claude source gets.
  const capability = skillsCapabilityFor(aiTool);
  if (capability === null) return null;
  const posix = capability.mainArtifactRelPath(projectRoot);
  return posix.split('/').join(sep);
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
    return { aiTool, instructionTool: null, instructionsNeeded: false, instructionsPath: null, skillsNeeded: false, skillsPath: null, conversionOffered: false, needed: false };
  }

  const instructionTool = isInstructionTool(aiTool) ? aiTool : null;
  let instructionsNeeded = false;
  let instructionsPath: string | null = null;
  let conversionOffered = false;
  if (instructionTool !== null) {
    instructionsPath = instructionFileRelPath(instructionTool);
    const st = getInstructionsStatesForTools(projectRoot).find(s => s.tool === instructionTool);
    // `setupNeeded` = missing || outdated, evaluated against the section set the
    // file SHOULD carry (adapter-aware, HS-9366) — exactly "prep needed".
    instructionsNeeded = st !== undefined && st.setupNeeded;
    // HS-9375 — a full-mode file with migratable filled specifics: offer the
    // ask-first conversion (performed by `prepareToolConfig`).
    conversionOffered = adapterConversionPlanFor(projectRoot, instructionTool)?.outcome === 'migratable';
  }

  const skillsPath = skillArtifactRelPath(aiTool, projectRoot);
  const skillsNeeded = skillsPath !== null && skillArtifactStale(projectRoot, skillsPath);

  return { aiTool, instructionTool, instructionsNeeded, instructionsPath, skillsNeeded, skillsPath, conversionOffered, needed: instructionsNeeded || skillsNeeded };
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
  // HS-9375 — the user accepted the prep dialog, which disclosed the conversion:
  // migrate the filled specifics into CLAUDE.md, strip the duplicated full
  // sections, install the thin adapter. (Never reached silently — the status's
  // `conversionOffered` gates the dialog.)
  if (before.conversionOffered && before.instructionTool !== null) {
    instructionsWritten = convertToolFileToAdapter(projectRoot, before.instructionTool) || instructionsWritten;
  }
  if (before.instructionTool !== null) {
    instructionsWritten = writeInstructionsForTool(projectRoot, before.instructionTool) || instructionsWritten;
  }
  // Skills + MCP config + permissions/hooks — `wantsTool(dataDir)` inside
  // narrows generation to the selected tool.
  const platforms = ensureSkillsForDir(projectRoot, categories, dataDir);
  return { instructionsWritten, platforms, status: getToolPrepStatus(projectRoot, dataDir) };
}
