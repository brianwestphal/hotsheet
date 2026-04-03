import { Hono } from 'hono';

import { clearLog, getLogCount, getLogEntries } from '../db/queries.js';
import type { AppEnv } from '../types.js';

export const commandLogRoutes = new Hono<AppEnv>();

commandLogRoutes.get('/command-log', async (c) => {
  const url = new URL(c.req.url);
  const limit = parseInt(url.searchParams.get('limit') ?? '100', 10);
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
  const eventType = url.searchParams.get('event_type') ?? undefined;
  const search = url.searchParams.get('search') ?? undefined;
  const entries = await getLogEntries({ limit, offset, eventType, search });
  return c.json(entries);
});

commandLogRoutes.delete('/command-log', async (c) => {
  await clearLog();
  return c.json({ ok: true });
});

commandLogRoutes.get('/command-log/count', async (c) => {
  const url = new URL(c.req.url);
  const eventType = url.searchParams.get('event_type') ?? undefined;
  const search = url.searchParams.get('search') ?? undefined;
  const count = await getLogCount({ eventType, search });
  return c.json({ count });
});
