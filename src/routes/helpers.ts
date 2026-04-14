import type { Context } from 'hono';

/** Parse an integer route parameter. Returns the number or null if invalid. */
export function parseIntParam(c: Context, param = 'id'): number | null {
  const raw = c.req.param(param);
  if (raw == null) return null;
  const id = parseInt(raw, 10);
  return isNaN(id) ? null : id;
}
