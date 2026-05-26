/**
 * HS-8522 — internal runtime for the typed API layer.
 *
 * Per-resource modules (`git.ts`, …) define the request / response **zod
 * schemas** (the single source of truth — the server imports them for
 * request validation, the client validates responses against them) AND the
 * typed **caller functions** that wrap `apiCall(...)` into shapes like
 * `gitFetch()` / `getGitStatus()`. Callers never touch raw URLs, and inline
 * `api<{ … }>(path)` type literals disappear.
 *
 * **Server-safety.** This module imports only `zod`. The per-resource
 * modules import only this module + schema dependencies, so a server route
 * file can `import { GitRevealReqSchema } from '../api/git.js'` to validate
 * a request body WITHOUT dragging the client-only `api()` (which pulls in
 * `state` / `serverBusyChip` / `dom`, all of which touch the DOM) into the
 * Node server bundle. The actual fetch is performed by a transport the
 * client injects at boot via `setApiTransport`; `apiCall` is never invoked
 * server-side.
 *
 * Mirrors the approach taken in the sister project (glassbox `src/api/`,
 * GB-798 / GB-804) adapted to Hot Sheet's project-scoped `api()` runtime.
 */
import { z } from 'zod';

/** Shared `{ ok: true }` shape for mutating endpoints with nothing else to
 *  return. Centralized so it isn't redeclared per resource module. */
export const OkResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponseSchema>;

/** Options forwarded to the injected transport. Mirrors the subset of
 *  `api()` / `apiWithSecret()` options the typed callers need. */
export interface ApiCallOpts {
  method?: string;
  body?: unknown;
  /** Skip the auto-appended `?project=<active-secret>` (cross-project reads). */
  skipProjectScope?: boolean;
  /** Use this specific project secret instead of the active project
   *  (routes through `apiWithSecret`). */
  secret?: string;
}

/** The client-injected fetch transport. Returns the decoded JSON body as
 *  `unknown`; `apiCall` validates it against the response schema. */
export type ApiTransport = (path: string, opts: ApiCallOpts) => Promise<unknown>;

let transport: ApiTransport | null = null;

/** Wire the client runtime (`src/client/api.tsx`'s `api` / `apiWithSecret`)
 *  into the typed layer. Called once at client boot from `app.tsx`. Kept as
 *  injection rather than a direct import so this module stays free of
 *  client-only (DOM-touching) imports and remains server-safe. */
export function setApiTransport(t: ApiTransport): void {
  transport = t;
}

/**
 * Typed API call with response validation. Routes through the injected
 * transport, then validates the decoded body against `responseSchema`,
 * throwing a path-qualified error on mismatch (never silently returns the
 * wrong shape downstream).
 */
export async function apiCall<T>(responseSchema: z.ZodType<T>, path: string, opts: ApiCallOpts = {}): Promise<T> {
  if (transport === null) {
    throw new Error(`apiCall(${path}): no transport configured — setApiTransport must run at client boot.`);
  }
  const raw = await transport(path, opts);
  const result = responseSchema.safeParse(raw);
  if (!result.success) {
    const summary = result.error.issues.map(i => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
    throw new Error(`apiCall(${path}): response shape mismatch — ${summary}`);
  }
  return result.data;
}

/** Build a `?k=v&…` query string from a flat record. Skips `undefined` /
 *  `null`, coerces the rest to string. Returns `''` when empty so callers
 *  can always concatenate it onto a path. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) usp.set(k, String(v));
  }
  const s = usp.toString();
  return s === '' ? '' : '?' + s;
}
