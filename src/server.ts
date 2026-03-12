import { serve } from '@hono/node-server';
import { exec } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { Hono } from 'hono';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { apiRoutes } from './routes/api.js';
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

  // API routes
  app.route('/api', apiRoutes);

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
