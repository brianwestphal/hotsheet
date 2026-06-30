import type { Context } from 'hono';
import type { BodyData } from 'hono/utils/body';

/** Parse an integer route parameter. Returns the number or null if invalid. */
export function parseIntParam(c: Context, param = 'id'): number | null {
  const raw = c.req.param(param);
  if (raw == null) return null;
  const id = parseInt(raw, 10);
  return isNaN(id) ? null : id;
}

/**
 * HS-9227 — safely parse a multipart/form-data body. `c.req.parseBody()`
 * (which delegates to undici's `parseFormData`) throws
 * `TypeError: Failed to parse body as FormData` when the body is malformed,
 * truncated (e.g. a connection dropped mid-upload), or carries a
 * non-multipart Content-Type. Left uncaught, that surfaces as a bare 500.
 * This returns `null` on any parse failure so callers can answer with a clean
 * 400 instead. Returns the parsed body on success.
 */
export async function tryParseBody(c: Context): Promise<BodyData | null> {
  try {
    return await c.req.parseBody();
  } catch {
    return null;
  }
}
