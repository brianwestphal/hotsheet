import { serve } from '@hono/node-server';
import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { Hono } from 'hono';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { runWithDataDir } from './db/connection.js';
import { readFileSettings } from './file-settings.js';
import { getMimeType } from './mime-types.js';
import { getProjectBySecret } from './projects.js';
import { apiRoutes } from './routes/api.js';
import { backupRoutes } from './routes/backups.js';
import { pageRoutes } from './routes/pages.js';
import { projectRoutes } from './routes/projects.js';
import type { AppEnv } from './types.js';

function tryServe(fetch: Hono['fetch'], port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch, port });
    server.on('listening', () => { resolve(port); });
    server.on('error', (err: NodeJS.ErrnoException) => {
      reject(err);
    });
  });
}

export async function startServer(port: number, dataDir: string, options?: { noOpen?: boolean; strictPort?: boolean }): Promise<number> {
  const app = new Hono<AppEnv>();

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

  // Secret validation middleware for API routes (HS-1684, HS-1982, HS-2083)
  // Mutation requests (POST/PATCH/PUT/DELETE) MUST include the correct secret unless from
  // a same-origin browser request. GET requests are allowed without secret (browser polling).
  // Skip secret validation for /api/projects/* — these are management endpoints used by
  // the CLI for multi-project registration, accessible only from localhost.
  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/projects') || c.req.path === '/api/channel/heartbeat') {
      await next();
      return;
    }

    const currentDataDir = c.get('dataDir');
    const settings = readFileSettings(currentDataDir);
    const expectedSecret = settings.secret;
    if (expectedSecret === undefined || expectedSecret === '') { await next(); return; }

    const headerSecret = c.req.header('X-Hotsheet-Secret');
    const method = c.req.method;
    const isMutation = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';

    if (headerSecret !== undefined && headerSecret !== '') {
      // Header present: validate it against the resolved project's secret
      if (headerSecret !== expectedSecret) {
        // Also check if it matches ANY registered project (multi-project support)
        const project = getProjectBySecret(headerSecret);
        if (!project) {
          return c.json({
            error: 'Secret mismatch — you may be connecting to the wrong Hot Sheet instance.',
            recovery: 'Re-read .hotsheet/settings.json to get the correct port and secret, and re-read your skill files (e.g. .claude/skills/hotsheet/SKILL.md) for updated instructions.',
          }, 403);
        }
        // Project found by secret — update context to use that project
        c.set('dataDir', project.dataDir);
        c.set('projectSecret', project.secret);
      }
    } else if (isMutation) {
      // No header on a mutation: allow if from same-origin browser request, reject otherwise.
      // Must validate the Origin/Referer value matches localhost to prevent CSRF from malicious sites.
      const origin = c.req.header('Origin');
      const referer = c.req.header('Referer');
      const localhostPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;
      const isSameOrigin = (origin !== undefined && origin !== '' && localhostPattern.test(origin))
        || (referer !== undefined && referer !== '' && localhostPattern.test(referer));
      if (!isSameOrigin) {
        return c.json({
          error: 'Missing X-Hotsheet-Secret header. Read .hotsheet/settings.json for the correct port and secret.',
          recovery: 'Re-read .hotsheet/settings.json to get the correct port and secret, and re-read your skill files for updated instructions.',
        }, 403);
      }
    }

    await next();
  });

  // API routes
  app.route('/api', apiRoutes);
  app.route('/api/backups', backupRoutes);
  app.route('/api/projects', projectRoutes);

  // Graceful shutdown endpoint (used by stale instance cleanup)
  app.post('/api/shutdown', (c) => {
    console.log('[server] Shutdown requested');
    setTimeout(() => process.exit(0), 500);
    return c.json({ ok: true });
  });

  // Page routes
  app.route('/', pageRoutes);

  let actualPort = port;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      actualPort = await tryServe(app.fetch, port + attempt);
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

  if (actualPort !== port) {
    console.log(`  Port ${port} in use, using ${actualPort} instead.`);
  }

  const url = `http://localhost:${actualPort}`;
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
