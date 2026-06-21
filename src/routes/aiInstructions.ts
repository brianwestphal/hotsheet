import { Hono } from 'hono';

import { getAiInstructionsState, projectRootFromDataDir, writeAiInstructions } from '../aiInstructions.js';
import type { AppEnv } from '../types.js';

/**
 * HS-8913 — install / inspect Hot Sheet's recommended AI-assistant instruction
 * sections in the active project's CLAUDE.md. Wire shapes are validated on the
 * client against `src/api/aiInstructions.ts`. Logic lives in `src/aiInstructions.ts`.
 */
export const aiInstructionsRoutes = new Hono<AppEnv>();

aiInstructionsRoutes.get('/ai-instructions/status', (c) => {
  const projectRoot = projectRootFromDataDir(c.get('dataDir'));
  return c.json(getAiInstructionsState(projectRoot));
});

aiInstructionsRoutes.post('/ai-instructions/apply', (c) => {
  const projectRoot = projectRootFromDataDir(c.get('dataDir'));
  return c.json(writeAiInstructions(projectRoot));
});
