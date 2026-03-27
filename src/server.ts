import { serve } from '@hono/node-server';
import { exec } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { Hono } from 'hono';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { readFileSettings } from './file-settings.js';
import { apiRoutes } from './routes/api.js';
import { backupRoutes } from './routes/backups.js';
import { pageRoutes } from './routes/pages.js';
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

  // Inject context
  app.use('*', async (c, next) => {
    c.set('dataDir', dataDir);
    await next();
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
    const filename = c.req.param('filename');
    const filePath = join(distDir, 'assets', filename);
    if (!existsSync(filePath)) return c.notFound();
    const content = readFileSync(filePath);
    const ext = filename.split('.').pop();
    const mimeTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml' };
    return new Response(content, { headers: { 'Content-Type': mimeTypes[ext || ''] || 'application/octet-stream', 'Cache-Control': 'max-age=86400' } });
  });

  // Secret validation middleware for API routes (HS-1684, HS-1982, HS-2083)
  // Mutation requests (POST/PATCH/PUT/DELETE) MUST include the correct secret unless from
  // a same-origin browser request. GET requests are allowed without secret (browser polling).
  app.use('/api/*', async (c, next) => {
    const settings = readFileSettings(dataDir);
    const expectedSecret = settings.secret;
    if (!expectedSecret) { await next(); return; }

    const headerSecret = c.req.header('X-Hotsheet-Secret');
    const method = c.req.method;
    const isMutation = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';

    if (headerSecret) {
      // Header present: validate it
      if (headerSecret !== expectedSecret) {
        return c.json({
          error: 'Secret mismatch — you may be connecting to the wrong Hot Sheet instance.',
          recovery: 'Re-read .hotsheet/settings.json to get the correct port and secret, and re-read your skill files (e.g. .claude/skills/hotsheet/SKILL.md) for updated instructions.',
        }, 403);
      }
    } else if (isMutation) {
      // No header on a mutation: allow if from same-origin browser request, reject otherwise.
      // Must validate the Origin/Referer value matches localhost to prevent CSRF from malicious sites.
      const origin = c.req.header('Origin');
      const referer = c.req.header('Referer');
      const localhostPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;
      const isSameOrigin = (origin && localhostPattern.test(origin))
        || (referer && localhostPattern.test(referer));
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

  // Page routes
  app.route('/', pageRoutes);

  let actualPort = port;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      actualPort = await tryServe(app.fetch, port + attempt);
      break;
    } catch (err: unknown) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        if (options?.strictPort) {
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
  if (!options?.noOpen) {
    const openCmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start'
      : 'xdg-open';
    exec(`${openCmd} ${url}`);
  }

  return actualPort;
}
