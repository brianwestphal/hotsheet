import { Hono } from 'hono';

import { getAiInstructionsState, projectRootFromDataDir, writeAiInstructions } from '../aiInstructions.js';
import { getInstructionsStatesForTools, writeInstructionsForDetectedTools } from '../aiInstructionsTools.js';
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
