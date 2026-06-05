/**
 * HS-8751 — REST endpoints for the global API-key registry. Metadata-only over
 * the wire (the secret value is write-only — accepted on create/update, never
 * returned). Storage + resolution live in `src/secret-keys.ts`; the wire shapes
 * are the SSOT in `src/api/keys.ts`. See docs/79-api-keys.md.
 */
import { Hono } from 'hono';

import { CreateKeyReqSchema, UpdateKeyReqSchema } from '../api/keys.js';
import { createKey, deleteKey, listKeyMetas, updateKey } from '../secret-keys.js';
import type { AppEnv } from '../types.js';
import { parseBody } from './validation.js';

export const keysRoutes = new Hono<AppEnv>();

// GET /api/keys — all key metadata (no values).
keysRoutes.get('/keys', (c) => {
  return c.json({ keys: listKeyMetas() });
});

// POST /api/keys — create { type, name, value } → returns the new metadata.
keysRoutes.post('/keys', async (c) => {
  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = parseBody(CreateKeyReqSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const key = await createKey(parsed.data.type, parsed.data.name, parsed.data.value);
  return c.json({ key });
});

// PUT /api/keys/:id — update name/type and optionally the value.
keysRoutes.put('/keys/:id', async (c) => {
  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = parseBody(UpdateKeyReqSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const key = await updateKey(c.req.param('id'), parsed.data);
  if (key === null) return c.json({ error: 'Not found' }, 404);
  return c.json({ key });
});

// DELETE /api/keys/:id — remove metadata + the keychain secret.
keysRoutes.delete('/keys/:id', async (c) => {
  const ok = await deleteKey(c.req.param('id'));
  if (!ok) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});
