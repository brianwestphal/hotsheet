// HS-7940 — the `/api/*` authentication + access-control middleware, extracted
// from `src/server.ts` into a factory so the full access matrix runs against
// the REAL code in `src/routes/server.auth.test.ts` (in-process, no sockets)
// instead of a drift-prone replica. `server.ts` wires the live instance with
// the resolved `exposed` + `trustedOrigins`.
//
// Decision flow for an `/api/*` request:
//   1. `/api/projects/*` + `/api/channel/heartbeat` are local-management /
//      heartbeat endpoints — open to local/trusted callers; once the server is
//      exposed, an untrusted remote falls through to the secret check.
//   2. No project secret configured → open (fresh/un-secured project).
//   3. Secret header present → exact-match passes; a foreign-but-valid secret
//      re-targets the project context; an unknown secret is 403.
//   4. No secret header → `evaluateNoSecretApiAccess` (CSRF guard for mutations,
//      GET lockdown when exposed).

import type { MiddlewareHandler } from 'hono';

import { getProjectBySecret } from '../projects.js';
import { getProjectSecret } from '../secret-file.js';
import { isRequestTrusted } from '../trusted-origin.js';
import type { AppEnv } from '../types.js';
import { evaluateNoSecretApiAccess } from './apiAccess.js';

export interface ApiAuthOptions {
  /** Server bound to a non-loopback address (reachable off-box). */
  exposed: boolean;
  /** Allow-list of non-localhost trusted origins. */
  trustedOrigins: string[];
}

const SECRET_MISMATCH_BODY = {
  error: 'Secret mismatch — you may be connecting to the wrong Hot Sheet instance.',
  recovery: 'Re-read .hotsheet/settings.json to get the correct port and secret, and re-read your skill files (e.g. .claude/skills/hotsheet/SKILL.md) for updated instructions.',
};

const MISSING_SECRET_BODY = {
  error: 'Missing X-Hotsheet-Secret header. Read .hotsheet/settings.json for the correct port and secret.',
  recovery: 'Re-read .hotsheet/settings.json to get the correct port and secret, and re-read your skill files for updated instructions.',
};

export function createApiAuthMiddleware({ exposed, trustedOrigins }: ApiAuthOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const origin = c.req.header('Origin');
    const referer = c.req.header('Referer');

    // (1) Management / heartbeat endpoints — open to local/trusted callers only.
    if (c.req.path.startsWith('/api/projects') || c.req.path === '/api/channel/heartbeat') {
      if (!exposed || isRequestTrusted(origin, referer, trustedOrigins)) {
        await next();
        return;
      }
    }

    const currentDataDir = c.get('dataDir');
    // HS-8999 — the secret lives in the `secret.json` sidecar (falls back to the
    // legacy settings.json value for an un-migrated project).
    const expectedSecret = getProjectSecret(currentDataDir);
    // (2) No secret configured → nothing to enforce.
    if (expectedSecret === '') { await next(); return; }

    const headerSecret = c.req.header('X-Hotsheet-Secret');

    // (3) Secret header present.
    if (headerSecret !== undefined && headerSecret !== '') {
      if (headerSecret !== expectedSecret) {
        const project = getProjectBySecret(headerSecret);
        if (!project) return c.json(SECRET_MISMATCH_BODY, 403);
        c.set('dataDir', project.dataDir);
        c.set('projectSecret', project.secret);
      }
      await next();
      return;
    }

    // (4) No secret header → origin-based access matrix.
    const decision = evaluateNoSecretApiAccess({
      method: c.req.method,
      origin,
      referer,
      exposed,
      trustedOrigins,
    });
    if (!decision.allow) return c.json(MISSING_SECRET_BODY, decision.status);

    await next();
  };
}
