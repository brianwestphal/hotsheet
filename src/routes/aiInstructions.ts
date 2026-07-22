import { Hono } from 'hono';

import { getAiInstructionsState, projectRootFromDataDir, writeAiInstructions } from '../aiInstructions.js';
import { getInstructionsStatesForTools, writeInstructionsForDetectedTools } from '../aiInstructionsTools.js';
import { getCategories } from '../db/settings.js';
import { getToolPrepStatus, prepareToolConfig } from '../toolPrep.js';
import type { AppEnv } from '../types.js';

/**
 * HS-8913 / HS-8916 — install / inspect Hot Sheet's recommended AI-assistant
 * instruction sections in the active project's `CLAUDE.md` AND the other detected
 * AI tools (Cursor `.cursor/rules/*.mdc`, Windsurf `.windsurf/rules/*.md`, Copilot
 * `.github/copilot-instructions.md`). Wire shapes validated on the client against
 * `src/api/aiInstructions.ts`. Logic: `src/aiInstructions.ts` (pure core) +
 * `src/aiInstructionsTools.ts` (per-tool targets).
 */
export const aiInstructionsRoutes = new Hono<AppEnv>();

aiInstructionsRoutes.get('/ai-instructions/status', (c) => {
  const projectRoot = projectRootFromDataDir(c.get('dataDir'));
  // The top-level fields stay Claude-scoped (back-compat); `tools` carries the
  // per-tool state (Claude/Cursor/Windsurf/Copilot).
  return c.json({ ...getAiInstructionsState(projectRoot), tools: getInstructionsStatesForTools(projectRoot) });
});

aiInstructionsRoutes.post('/ai-instructions/apply', (c) => {
  const projectRoot = projectRootFromDataDir(c.get('dataDir'));
  // Always ensure CLAUDE.md (the explicit action, back-compat) + write every
  // OTHER detected tool's instruction file (Cursor/Windsurf/Copilot). HS-8916.
  const claude = writeAiInstructions(projectRoot);
  writeInstructionsForDetectedTools(projectRoot); // idempotent; Claude re-write is a no-op
  return c.json({ ...claude, state: { ...claude.state, tools: getInstructionsStatesForTools(projectRoot) } });
});

// HS-9367 (docs/119) — is anything missing/stale for the project's SELECTED
// `ai_tool` (instruction file + main skill artifact)? Drives the ask-first
// prepare nudge on an ai_tool switch and the project-open drift check.
aiInstructionsRoutes.get('/ai-instructions/tool-prep', (c) => {
  const dataDir = c.get('dataDir');
  return c.json(getToolPrepStatus(projectRootFromDataDir(dataDir), dataDir));
});

// HS-9367 — prepare the FULL config for the project's selected tool
// (instruction file [adapter-mode via HS-9366] + skills + MCP + permissions),
// reusing the idempotent generators. The one-click "Prepare" action.
aiInstructionsRoutes.post('/ai-instructions/prepare-tool', async (c) => {
  const dataDir = c.get('dataDir');
  // The project's OWN categories (HS-8910 — never the process-global set).
  const categories = await getCategories();
  return c.json(prepareToolConfig(projectRootFromDataDir(dataDir), dataDir, categories));
});
