// HS-9302 (docs/112 §112.3) — the remotes-store HTTP surface. The browser can't
// read `~/.hotsheet/remotes.json` directly, so the LOCAL server exposes it: GET to
// read the mounted remote servers/projects (the client merges them into the tab
// strip), PUT to replace the store (HS-9303's "Add remote server" flow does a
// read-modify-write). These are control-plane paths — they always target the
// local server (see `remoteOrigin.ts` LOCAL_ONLY_PREFIXES `/remotes`).

import { Hono } from 'hono';

import { readRemotes, writeRemotes } from '../remotes.js';
import type { AppEnv } from '../types.js';
import { parseBody, RemotesFileSchema } from './validation.js';

export const remotesRoutes = new Hono<AppEnv>();

/** GET /api/remotes — the machine-global remote servers + their mounted projects. */
remotesRoutes.get('/remotes', (c) => {
  return c.json(readRemotes());
});

/** PUT /api/remotes — replace the whole remotes store (the caller read-modify-writes). */
remotesRoutes.put('/remotes', async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  const parsed = parseBody(RemotesFileSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  return c.json(writeRemotes(parsed.data));
});
