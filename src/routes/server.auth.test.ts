// HS-7940 — pins the `/api/*` access-control matrix (docs/46 §46.5). Two
// layers: the pure decision (`evaluateNoSecretApiAccess`) and the real
// middleware (`createApiAuthMiddleware`) mounted in-process via Hono's
// `app.request()` so the integrated behavior — secret header, exposed GET
// lockdown, projects-exemption — runs against production code without sockets.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { Hono } from 'hono';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppEnv } from '../types.js';
import { evaluateNoSecretApiAccess, evaluateOtelAccess } from './apiAccess.js';
import { createApiAuthMiddleware } from './apiAuthMiddleware.js';

describe('evaluateNoSecretApiAccess (pure matrix)', () => {
  const trusted = ['tailscale'];

  it('allows a localhost GET whether or not the server is exposed', () => {
    const base = { method: 'GET', origin: 'http://localhost:4174', referer: undefined, trustedOrigins: [] as string[] };
    expect(evaluateNoSecretApiAccess({ ...base, exposed: false }).allow).toBe(true);
    expect(evaluateNoSecretApiAccess({ ...base, exposed: true }).allow).toBe(true);
  });

  it('allows an untrusted GET on a NON-exposed server (today\'s open polling)', () => {
    const d = evaluateNoSecretApiAccess({ method: 'GET', origin: undefined, referer: undefined, exposed: false, trustedOrigins: [] });
    expect(d.allow).toBe(true);
  });

  it('rejects an untrusted/origin-less GET on an EXPOSED server', () => {
    const noOrigin = evaluateNoSecretApiAccess({ method: 'GET', origin: undefined, referer: undefined, exposed: true, trustedOrigins: [] });
    expect(noOrigin).toEqual({ allow: false, status: 403, reason: 'get-exposed-untrusted-no-secret' });
    const evil = evaluateNoSecretApiAccess({ method: 'GET', origin: 'https://evil.com', referer: undefined, exposed: true, trustedOrigins: [] });
    expect(evil.allow).toBe(false);
  });

  it('allows a tailnet GET on an exposed server only when tailscale is trusted', () => {
    const tailnet = { method: 'GET', origin: 'http://100.96.1.2:4174', referer: undefined, exposed: true };
    expect(evaluateNoSecretApiAccess({ ...tailnet, trustedOrigins: trusted }).allow).toBe(true);
    expect(evaluateNoSecretApiAccess({ ...tailnet, trustedOrigins: [] }).allow).toBe(false);
  });

  it('HS-8995 — a verified mTLS cert (clientAuthenticated) is trusted without a secret/origin', () => {
    // An untrusted-origin GET + mutation on an exposed server that would normally
    // 403 both pass when the request is cert-authenticated (the cert is the credential).
    expect(evaluateNoSecretApiAccess({ method: 'GET', origin: 'https://evil.com', referer: undefined, exposed: true, trustedOrigins: [], clientAuthenticated: true }).allow).toBe(true);
    expect(evaluateNoSecretApiAccess({ method: 'POST', origin: undefined, referer: undefined, exposed: true, trustedOrigins: [], clientAuthenticated: true }).allow).toBe(true);
  });

  it('rejects a no-secret mutation from an untrusted (or absent) origin', () => {
    expect(evaluateNoSecretApiAccess({ method: 'POST', origin: 'https://evil.com', referer: undefined, exposed: false, trustedOrigins: [] }).allow).toBe(false);
    expect(evaluateNoSecretApiAccess({ method: 'POST', origin: undefined, referer: undefined, exposed: false, trustedOrigins: [] }).allow).toBe(false);
  });

  it('allows a no-secret mutation from a trusted same-origin', () => {
    expect(evaluateNoSecretApiAccess({ method: 'POST', origin: 'http://localhost:4174', referer: undefined, exposed: true, trustedOrigins: [] }).allow).toBe(true);
    expect(evaluateNoSecretApiAccess({ method: 'PUT', origin: 'http://100.96.1.2', referer: undefined, exposed: true, trustedOrigins: trusted }).allow).toBe(true);
  });
});

describe('evaluateOtelAccess (HS-8983)', () => {
  const base = { origin: undefined, referer: undefined, trustedOrigins: [] as string[], hasSecret: false };

  it('is open when the server is not exposed', () => {
    expect(evaluateOtelAccess({ ...base, exposed: false, remoteAddress: '203.0.113.9' }).allow).toBe(true);
  });

  it('allows a loopback peer on an exposed server (the local exporter)', () => {
    expect(evaluateOtelAccess({ ...base, exposed: true, remoteAddress: '127.0.0.1' }).allow).toBe(true);
    expect(evaluateOtelAccess({ ...base, exposed: true, remoteAddress: '::ffff:127.0.0.1' }).allow).toBe(true);
  });

  it('rejects an untrusted remote peer on an exposed server', () => {
    const d = evaluateOtelAccess({ ...base, exposed: true, remoteAddress: '203.0.113.9' });
    expect(d).toEqual({ allow: false, status: 403, reason: 'otel-exposed-untrusted' });
  });

  it('allows a trusted origin or a valid secret from a remote peer', () => {
    expect(evaluateOtelAccess({ ...base, exposed: true, remoteAddress: '100.96.1.2', trustedOrigins: ['tailscale'], origin: 'http://100.96.1.2' }).allow).toBe(true);
    expect(evaluateOtelAccess({ ...base, exposed: true, remoteAddress: '203.0.113.9', hasSecret: true }).allow).toBe(true);
  });
});

describe('createApiAuthMiddleware (integrated)', () => {
  const SECRET = 'auth-itest-secret';
  let dataDir: string;

  function buildApp(opts: { exposed: boolean; trustedOrigins: string[] }) {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('dataDir', dataDir);
      c.set('projectSecret', SECRET);
      await next();
    });
    app.use('/api/*', createApiAuthMiddleware(opts));
    // Minimal stand-in routes so an allowed request returns 200.
    app.get('/api/tickets', (c) => c.json({ ok: true }));
    app.post('/api/tickets', (c) => c.json({ ok: true }, 201));
    app.get('/api/projects', (c) => c.json({ projects: [] }));
    return app;
  }

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'hs-auth-'));
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ secret: SECRET, port: 4174 }));
  });

  afterAll(() => {
    if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
  });

  describe('NOT exposed (default loopback bind)', () => {
    const app = () => buildApp({ exposed: false, trustedOrigins: [] });

    it('allows an open GET with no origin or secret', async () => {
      const res = await app().request('/api/tickets');
      expect(res.status).toBe(200);
    });

    it('still rejects a no-secret mutation from an untrusted origin (CSRF)', async () => {
      const res = await app().request('/api/tickets', {
        method: 'POST',
        headers: { 'Origin': 'https://evil.com', 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(403);
    });

    it('accepts the correct secret header', async () => {
      const res = await app().request('/api/tickets', { method: 'POST', headers: { 'X-Hotsheet-Secret': SECRET } });
      expect(res.status).toBe(201);
    });

    it('rejects a wrong secret header', async () => {
      const res = await app().request('/api/tickets', { headers: { 'X-Hotsheet-Secret': 'nope' } });
      expect(res.status).toBe(403);
    });

    it('leaves /api/projects open to local callers', async () => {
      const res = await app().request('/api/projects');
      expect(res.status).toBe(200);
    });
  });

  describe('exposed (--bind 0.0.0.0)', () => {
    it('locks down a GET with no origin and no secret', async () => {
      const res = await buildApp({ exposed: true, trustedOrigins: [] }).request('/api/tickets');
      expect(res.status).toBe(403);
    });

    it('allows that GET when the correct secret is supplied', async () => {
      const res = await buildApp({ exposed: true, trustedOrigins: [] }).request('/api/tickets', {
        headers: { 'X-Hotsheet-Secret': SECRET },
      });
      expect(res.status).toBe(200);
    });

    it('allows a GET from a trusted (configured) origin without a secret', async () => {
      const res = await buildApp({ exposed: true, trustedOrigins: ['tailscale'] }).request('/api/tickets', {
        headers: { 'Origin': 'http://100.96.1.2:4174' },
      });
      expect(res.status).toBe(200);
    });

    it('still allows a localhost GET (always trusted)', async () => {
      const res = await buildApp({ exposed: true, trustedOrigins: [] }).request('/api/tickets', {
        headers: { 'Origin': 'http://localhost:4174' },
      });
      expect(res.status).toBe(200);
    });

    it('requires a secret for /api/projects from an untrusted remote', async () => {
      const res = await buildApp({ exposed: true, trustedOrigins: [] }).request('/api/projects', {
        headers: { 'Origin': 'https://evil.com' },
      });
      expect(res.status).toBe(403);
    });

    it('keeps /api/projects open to a trusted origin', async () => {
      const res = await buildApp({ exposed: true, trustedOrigins: ['tailscale'] }).request('/api/projects', {
        headers: { 'Origin': 'http://100.96.1.2:4174' },
      });
      expect(res.status).toBe(200);
    });
  });
});
