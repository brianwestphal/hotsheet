import { serve } from '@hono/node-server';
import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { Hono } from 'hono';
import type { Server as HttpServer } from 'http';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { runWithDataDir } from './db/connection.js';
import { readFileSettings } from './file-settings.js';
import { readGlobalConfig } from './global-config.js';
import { gracefulShutdown, registerHttpServerForShutdown } from './lifecycle.js';
import { getMimeType } from './mime-types.js';
import { getProjectBySecret } from './projects.js';
import { announcerRoutes } from './routes/announcer.js';
import { apiRoutes } from './routes/api.js';
import { createApiAuthMiddleware } from './routes/apiAuthMiddleware.js';
import { backupRoutes } from './routes/backups.js';
import { dbRoutes } from './routes/db.js';
import { gitRoutes } from './routes/git.js';
import { keysRoutes } from './routes/keys.js';
import { otelRoutes } from './routes/otel.js';
import { pageRoutes } from './routes/pages.js';
import { projectRoutes } from './routes/projects.js';
import { telemetryRoutes } from './routes/telemetry.js';
import { workerRoutes } from './routes/workers.js';
import { worktreeRoutes } from './routes/worktrees.js';
import { wireTerminalWebSocket } from './terminals/websocket.js';
import { isExposedBind } from './trusted-origin.js';
import type { AppEnv } from './types.js';

function tryServe(fetch: Hono['fetch'], port: number, hostname: string): Promise<{ port: number; server: HttpServer }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch, port, hostname });
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
    const settings = readFileSettings(resolvedDataDir);
    c.set('projectSecret', settings.secret ?? '');
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

  // Secret validation + origin access-control middleware (HS-1684 / HS-1982 /
  // HS-2083 / HS-7940). Mutations need the secret OR a trusted same-origin
  // (CSRF guard); GETs poll openly on a loopback bind but require the secret
  // from untrusted origins once the server is exposed; `/api/projects/*` +
  // heartbeat stay open to local/trusted callers. Extracted to a factory so the
  // access matrix is tested against the real code (`src/routes/apiAuthMiddleware.ts`).
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

  // HS-8143 — Claude Code OTLP/HTTP receiver (§67.5). Three routes on
  // `/v1/{metrics,logs,traces}`. NOT under `/api/*` so the
  // `X-Hotsheet-Secret` middleware doesn't reject Claude Code's bundled
  // exporter (it can't send that header). Security model is the
  // `hotsheet_project` resource-attribute drop + the localhost bind.
  // See src/routes/otel.ts file-level comment for full rationale.
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

  let actualPort = port;
  let httpServer: HttpServer | null = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const result = await tryServe(app.fetch, port + attempt, bind);
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
    wireTerminalWebSocket(httpServer);
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
    console.log(`    GET requests from untrusted origins now require X-Hotsheet-Secret.`);
    console.log(`    Trusted origins: ${trustedOrigins.length > 0 ? trustedOrigins.join(', ') : '(none configured — only localhost is trusted)'}`);
  }

  const url = `http://localhost:${actualPort}`;
  // HS-8704 — LOAD-BEARING log line. The Tauri shell (`src-tauri/src/lib.rs`)
  // greps sidecar stdout for the exact substring `running at ` and slices the
  // URL out after it to navigate the WebView off the "Starting Hot Sheet…"
  // splash. Reword this and the installed app hangs on the splash forever.
  // The coupling is pinned by `src/launchReadinessContract.test.ts`.
  console.log(`\n  Hot Sheet running at ${url}\n`);

  // Open browser (unless suppressed for Tauri sidecar mode)
  if (options?.noOpen !== true) {
    const openCmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start'
      : 'xdg-open';
    execFile(openCmd, [url]);
  }

  return actualPort;
}
