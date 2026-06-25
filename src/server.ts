import { serve } from '@hono/node-server';
import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { Hono } from 'hono';
import type { Server as HttpServer } from 'http';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { createMtlsAuthzMiddleware } from './auth/authz.js';
import { buildMtlsServeConfig, collectServerCertHosts, type MtlsServeConfig, peerIdentityFromEnv } from './auth/tlsListener.js';
import { runWithDataDir } from './db/connection.js';
import { readGlobalConfig } from './global-config.js';
import { gracefulShutdown, registerHttpServerForShutdown } from './lifecycle.js';
import { getMimeType } from './mime-types.js';
import { getProjectBySecret } from './projects.js';
import { announcerRoutes } from './routes/announcer.js';
import { apiRoutes } from './routes/api.js';
import { evaluateOtelAccess } from './routes/apiAccess.js';
import { createApiAuthMiddleware } from './routes/apiAuthMiddleware.js';
import { backupRoutes } from './routes/backups.js';
import { dbRoutes } from './routes/db.js';
import { enrollmentRoutes } from './routes/enrollment.js';
import { gitRoutes } from './routes/git.js';
import { keysRoutes } from './routes/keys.js';
import { otelRoutes } from './routes/otel.js';
import { pageRoutes } from './routes/pages.js';
import { projectRoutes } from './routes/projects.js';
import { createRequestGuards } from './routes/requestGuards.js';
import { telemetryRoutes } from './routes/telemetry.js';
import { workerRoutes } from './routes/workers.js';
import { worktreeRoutes } from './routes/worktrees.js';
import { wireSyncWebSocket } from './routes/wsSync.js';
import { getProjectSecret } from './secret-file.js';
import { wireTerminalWebSocket } from './terminals/websocket.js';
import { isExposedBind } from './trusted-origin.js';
import type { AppEnv } from './types.js';

function tryServe(
  fetch: Hono['fetch'],
  port: number,
  hostname: string,
  tls?: MtlsServeConfig | null,
): Promise<{ port: number; server: HttpServer }> {
  return new Promise((resolve, reject) => {
    // HS-8993 — on the exposed (Tier-1) path, `tls` carries the HTTPS
    // `createServer` + mTLS `serverOptions` (`requestCert`/`rejectUnauthorized`).
    // On loopback/Tier-0 it's absent → plain HTTP, exactly as before.
    const server = serve({ fetch, port, hostname, ...(tls ?? {}) });
    server.on('listening', () => { resolve({ port, server: server as HttpServer }); });
    server.on('error', (err: NodeJS.ErrnoException) => {
      reject(err);
    });
  });
}

export async function startServer(
  port: number,
  dataDir: string,
  options?: { noOpen?: boolean; strictPort?: boolean; bind?: string },
): Promise<number> {
  const app = new Hono<AppEnv>();

  // HS-7940 — bind defaults to loopback (`127.0.0.1`) so the single-machine
  // install is closed by default; `--bind 0.0.0.0` (or a specific interface IP)
  // opts into off-box reachability. `exposed` drives the GET-secret lockdown;
  // `trustedOrigins` is the user's allow-list for non-localhost callers. Read
  // once at startup (a config change needs a restart to take effect).
  const globalConfig = readGlobalConfig();
  const bind = options?.bind ?? globalConfig.bind ?? '127.0.0.1';
  const exposed = isExposedBind(bind);
  const trustedOrigins = globalConfig.trustedOrigins ?? [];

  // HS-8993 — resolve the verified mTLS client identity (Tier-1) into the
  // request context. `null` on a plain-HTTP loopback (Tier-0) connection; on the
  // exposed TLS listener the peer cert is already verified against the CA (the
  // connection wouldn't exist otherwise), so a non-null value is an authenticated
  // device. Authz (sub-ticket 4) reads it; until then it's just surfaced.
  app.use('*', async (c, next) => {
    c.set('clientIdentity', peerIdentityFromEnv(c.env));
    c.set('clientAuthenticated', false); // upgraded by the mTLS authz middleware on Tier-1
    await next();
  });

  // Inject context: resolve which project the request is for.
  // For requests with X-Hotsheet-Secret header, look up the project by secret.
  // For GET requests, use a `project` query param (secret), or fall back to the default dataDir.
  // Wraps next() in runWithDataDir() so all downstream getDb() calls use the correct database.
  app.use('*', async (c, next) => {
    let resolvedDataDir = dataDir;

    const headerSecret = c.req.header('X-Hotsheet-Secret');
    if (headerSecret !== undefined && headerSecret !== '') {
      const project = getProjectBySecret(headerSecret);
      if (project) {
        resolvedDataDir = project.dataDir;
      }
    } else {
      const projectParam = c.req.query('project');
      if (projectParam !== undefined && projectParam !== '') {
        const project = getProjectBySecret(projectParam);
        if (project) {
          resolvedDataDir = project.dataDir;
        }
      }
    }

    c.set('dataDir', resolvedDataDir);
    c.set('projectSecret', getProjectSecret(resolvedDataDir));
    await runWithDataDir(resolvedDataDir, () => next());
  });

  // Static client assets
  const selfDir = dirname(fileURLToPath(import.meta.url));
  const distDir = existsSync(join(selfDir, 'client', 'styles.css'))
    ? join(selfDir, 'client')
    : join(selfDir, '..', 'dist', 'client');

  app.get('/static/styles.css', (c) => {
    const css = readFileSync(join(distDir, 'styles.css'), 'utf-8');
    return c.text(css, 200, { 'Content-Type': 'text/css', 'Cache-Control': 'no-cache' });
  });
  app.get('/static/app.js', (c) => {
    const js = readFileSync(join(distDir, 'app.global.js'), 'utf-8');
    return c.text(js, 200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' });
  });
  app.get('/static/assets/:filename', (c) => {
    const filename = basename(c.req.param('filename'));
    const filePath = join(distDir, 'assets', filename);
    if (!existsSync(filePath)) return c.notFound();
    const content = readFileSync(filePath);
    const ext = filename.split('.').pop() ?? '';
    return new Response(content, { headers: { 'Content-Type': getMimeType(ext), 'Cache-Control': 'max-age=86400' } });
  });

  // HS-8986 — front-line request hardening (body-size cap + flood rate limit),
  // BEFORE auth + handlers, on the API + OTLP ingest surfaces. One shared
  // limiter instance across both so a flood is bounded per remote IP. No-op for
  // loopback callers; rate limiting only engages on an exposed server.
  const requestGuards = createRequestGuards({ exposed });
  app.use('/api/*', requestGuards);
  app.use('/v1/*', requestGuards);

  // HS-8995 — mTLS authz (Tier-1 only): map the verified client cert → an
  // enrolled, non-revoked device before any handler; a revoked / unenrolled cert
  // gets 403, a valid one is marked `clientAuthenticated` so the secret/origin
  // gate below treats it as the credential. No-op on Tier-0 (loopback). Runs
  // BEFORE the secret middleware so the cert is the primary credential.
  app.use('/api/*', createMtlsAuthzMiddleware({ exposed }));

  // Secret validation + origin access-control middleware (HS-1684 / HS-1982 /
  // HS-2083 / HS-7940). Mutations need the secret OR a trusted same-origin
  // (CSRF guard); GETs poll openly on a loopback bind but require the secret
  // from untrusted origins once the server is exposed; `/api/projects/*` +
  // heartbeat stay open to local/trusted callers. Extracted to a factory so the
  // access matrix is tested against the real code (`src/routes/apiAuthMiddleware.ts`).
  // HS-8995 — a `clientAuthenticated` mTLS request is treated as trusted here.
  app.use('/api/*', createApiAuthMiddleware({ exposed, trustedOrigins }));

  // API routes
  app.route('/api', apiRoutes);
  app.route('/api/backups', backupRoutes);
  app.route('/api/db', dbRoutes);
  app.route('/api/projects', projectRoutes);
  // HS-7954 — git status chip. `GET /api/git/status` returns `GitStatus | null`.
  app.route('/api', gitRoutes);
  // HS-8935 — git worktree management (docs/89-git-worktrees.md Phase B).
  app.route('/api', worktreeRoutes);
  // HS-8863 — distributed worker launch (docs/90 §90.5 / §90.7).
  app.route('/api', workerRoutes);

  // §78 Announcer (HS-8745) — `/api/announcer/*`: opt-in toggle, key selection,
  // derived-summary generation, entries, and the listen cursor.
  app.route('/api', announcerRoutes);

  // HS-8751 — global API-key registry. `/api/keys` CRUD over the machine-wide
  // named-secret list the announcer (and future TTS) selects from.
  app.route('/api', keysRoutes);

  // HS-8994 — mTLS client-cert enrollment (§94.4.2). `/api/auth/devices/*`: mint
  // a `.p12`, sign a CSR (both loopback-only), list, revoke. Behind the standard
  // `/api/*` auth; credential creation adds its own loopback guard.
  app.route('/api', enrollmentRoutes);

  // HS-8143 — Claude Code OTLP/HTTP receiver (§67.5). Three routes on
  // `/v1/{metrics,logs,traces}`. NOT under `/api/*` so the
  // `X-Hotsheet-Secret` middleware doesn't reject Claude Code's bundled
  // exporter (it can't send that header). Security model is the
  // `hotsheet_project` resource-attribute drop + the localhost bind.
  // See src/routes/otel.ts file-level comment for full rationale.
  // HS-8983 — once the server is exposed (`--bind` non-loopback) the
  // "localhost bind" assumption is gone, so re-apply it: a loopback peer (the
  // local exporter), a trusted origin, or a secret-bearing request may ingest;
  // other remotes get 403. No-op on the default loopback bind.
  app.use('/v1/*', async (c, next) => {
    const headerSecret = c.req.header('X-Hotsheet-Secret') ?? c.req.query('project');
    // `@hono/node-server` passes the raw `{ incoming }` as the (untyped) env; the
    // socket's remoteAddress is the request peer. Cast is justified: AppEnv has
    // no Bindings type for it and there's a runtime guard (optional chaining).
    // `?? {}` because env is absent in the in-process test harness.
    const env = (c.env ?? {}) as { incoming?: { socket?: { remoteAddress?: string } } };
    const decision = evaluateOtelAccess({
      exposed,
      remoteAddress: env.incoming?.socket?.remoteAddress,
      origin: c.req.header('Origin'),
      referer: c.req.header('Referer'),
      trustedOrigins,
      hasSecret: headerSecret !== undefined && headerSecret !== '' && getProjectBySecret(headerSecret) !== undefined,
    });
    if (!decision.allow) return c.json({ error: 'forbidden' }, decision.status);
    await next();
  });
  app.route('/', otelRoutes);

  // HS-8148 — telemetry rollup API for the footer drawer Telemetry tab
  // (§67.10.2). `GET /api/telemetry/drawer?scope=project|all` returns
  // the drawer's full payload in one round trip.
  app.route('/api', telemetryRoutes);

  // Graceful shutdown endpoint (used by stale instance cleanup and `--close`).
  // HS-7528: kill every live PTY before the process exits so interactive
  // shells don't outlive the Hot Sheet instance that launched them.
  // HS-7931: also `await db.close()` per cached PGLite instance so the
  // postmaster.pid + WAL get a clean checkpoint instead of being left for
  // HS-7888's reactive mitigation to mop up. The full pipeline lives in
  // `src/lifecycle.ts` and is shared with the SIGINT/SIGTERM handlers in
  // `cli.ts`.
  app.post('/api/shutdown', (c) => {
    console.log('[server] Shutdown requested');
    void gracefulShutdown('http').finally(() => {
      // Yield once so Hono's response flushes to the client before we exit.
      // Without it the curl that triggered the shutdown sometimes races the
      // socket close and reports "Empty reply from server" even though the
      // shutdown ran cleanly.
      setImmediate(() => process.exit(0));
    });
    return c.json({ ok: true });
  });

  // Page routes
  app.route('/', pageRoutes);

  // HS-8993 — on the exposed (Tier-1) path, stand up mTLS: an HTTPS listener
  // requiring a CA-signed client cert. Loopback/Tier-0 stays plain HTTP +
  // shared secret (UNCHANGED). An exposed server REQUIRES mTLS — if the CA can't
  // be set up (no durable keychain; HS-9019) we fail startup rather than silently
  // exposing a plaintext, secret-only surface (the whole point of §94).
  let mtls: MtlsServeConfig | null = null;
  if (exposed) {
    try {
      const hosts = collectServerCertHosts(bind, trustedOrigins, globalConfig.tlsServerHosts ?? []);
      mtls = await buildMtlsServeConfig(dataDir, hosts);
    } catch (err) {
      console.error('\n  Error: cannot start mTLS on the exposed bind — the project CA could not be set up.');
      console.error('  An off-localhost server requires mutual TLS (docs/94). This usually means the OS');
      console.error('  keychain is unavailable (e.g. Windows / headless). See HS-9019.');
      console.error(`  Underlying error: ${err instanceof Error ? err.message : String(err)}\n`);
      throw err;
    }
  }

  let actualPort = port;
  let httpServer: HttpServer | null = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const result = await tryServe(app.fetch, port + attempt, bind, mtls);
      actualPort = result.port;
      httpServer = result.server;
      break;
    } catch (err: unknown) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        if (options?.strictPort === true) {
          // In strict port mode (Tauri dev), the Tauri window connects to the exact port
          // configured in tauri.conf.json's devUrl, so we can't silently switch ports.
          console.error(`\n  Error: Port ${port} is already in use.`);
          console.error(`  In --strict-port mode, the server must start on the requested port`);
          console.error(`  because the Tauri dev window is configured to connect to it.`);
          console.error(`  Stop whatever is using port ${port} and try again.\n`);
          process.exit(1);
        }
        if (attempt < 19) continue;
      }
      throw err;
    }
  }

  if (httpServer !== null) {
    wireTerminalWebSocket(httpServer, { exposed });
    // HS-8979 — `/ws/sync` push channel (docs/93). Same shared-port upgrade
    // pattern; honors the HS-7940 exposed/trusted-origin gate.
    wireSyncWebSocket(httpServer, { exposed, trustedOrigins });
    // HS-7931: register the live HTTP server with the lifecycle module so
    // `gracefulShutdown` can close it before issuing CHECKPOINTs.
    registerHttpServerForShutdown(httpServer);
  }

  if (actualPort !== port) {
    console.log(`  Port ${port} in use, using ${actualPort} instead.`);
  }

  // HS-7940 — make off-box exposure visible. The default loopback bind prints
  // nothing (unchanged). When exposed, surface the bind address + whether a
  // trusted-origin allow-list is configured so the user knows the surface area.
  if (exposed) {
    console.log(`  ⚠ Bound to ${bind} — reachable off this machine.`);
    // HS-8993 — on an exposed bind the listener is now HTTPS with mutual TLS:
    // every connection must present a CA-signed client cert (enroll one via the
    // sub-ticket-3 `.p12` flow). The shared secret / origin gate remain as
    // defense-in-depth but the client cert is the primary credential.
    console.log(`    🔒 Mutual TLS REQUIRED — connect over https:// with an enrolled client certificate.`);
    console.log(`    GET requests from untrusted origins also require X-Hotsheet-Secret (defense-in-depth).`);
    console.log(`    Trusted origins: ${trustedOrigins.length > 0 ? trustedOrigins.join(', ') : '(none configured — only localhost is trusted)'}`);
  }

  // HS-8993 — an exposed bind is HTTPS (mTLS); loopback/Tier-0 stays http.
  const url = `${exposed ? 'https' : 'http'}://localhost:${actualPort}`;
  // HS-8704 — LOAD-BEARING log line. The Tauri shell (`src-tauri/src/lib.rs`)
  // greps sidecar stdout for the exact substring `running at ` and slices the
  // URL out after it to navigate the WebView off the "Starting Hot Sheet…"
  // splash. Reword this and the installed app hangs on the splash forever.
  // The coupling is pinned by `src/launchReadinessContract.test.ts`. (Tauri only
  // ever launches the default loopback bind, so the scheme there stays http.)
  console.log(`\n  Hot Sheet running at ${url}\n`);

  // Open browser (unless suppressed for Tauri sidecar mode). HS-8993 — never
  // auto-open on an exposed mTLS bind: the local browser has no client cert, so
  // the connection would just fail; the user connects from an enrolled device.
  if (options?.noOpen !== true && !exposed) {
    const openCmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start'
      : 'xdg-open';
    execFile(openCmd, [url]);
  }

  return actualPort;
}
