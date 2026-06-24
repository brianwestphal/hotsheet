import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { AppEnv } from '../types.js';
import {
  createRequestGuards, defaultBodyCap, JSON_BODY_CAP_BYTES,
  OTLP_BODY_CAP_BYTES, parseContentLength, UPLOAD_BODY_CAP_BYTES,
} from './requestGuards.js';

describe('defaultBodyCap (per route class)', () => {
  it('large for attachment uploads, moderate for OTLP, JSON cap otherwise', () => {
    expect(defaultBodyCap('/api/tickets/5/attachments')).toBe(UPLOAD_BODY_CAP_BYTES);
    expect(defaultBodyCap('/v1/metrics')).toBe(OTLP_BODY_CAP_BYTES);
    expect(defaultBodyCap('/api/tickets')).toBe(JSON_BODY_CAP_BYTES);
    expect(defaultBodyCap('/api/settings')).toBe(JSON_BODY_CAP_BYTES);
  });
});

describe('parseContentLength', () => {
  it('parses a valid length, rejects junk/absent', () => {
    expect(parseContentLength('1024')).toBe(1024);
    expect(parseContentLength('0')).toBe(0);
    expect(parseContentLength(undefined)).toBeNull();
    expect(parseContentLength('')).toBeNull();
    expect(parseContentLength('abc')).toBeNull();
    expect(parseContentLength('-5')).toBeNull();
  });
});

function appWith(guards: ReturnType<typeof createRequestGuards>) {
  const app = new Hono<AppEnv>();
  app.use('/api/*', guards);
  app.post('/api/x', (c) => c.json({ ok: true }));
  app.get('/api/x', (c) => c.json({ ok: true }));
  app.post('/api/tickets/1/attachments', (c) => c.json({ ok: true }));
  return app;
}

describe('createRequestGuards — per-route caps (default path-aware)', () => {
  it('caps a JSON path at the JSON cap but allows the same size on an upload path', async () => {
    const app = appWith(createRequestGuards({ exposed: false })); // path-aware default
    const over = String(JSON_BODY_CAP_BYTES + 1);
    expect((await app.request('/api/x', { method: 'POST', headers: { 'Content-Length': over } })).status).toBe(413);
    // The same size is under the (larger) attachment cap → allowed.
    expect((await app.request('/api/tickets/1/attachments', { method: 'POST', headers: { 'Content-Length': over } })).status).toBe(200);
  });
});

describe('createRequestGuards — body-size cap', () => {
  it('rejects a body over the cap with 413', async () => {
    const app = appWith(createRequestGuards({ exposed: false, maxBodyBytes: 100 }));
    const res = await app.request('/api/x', {
      method: 'POST',
      headers: { 'Content-Length': '101', 'Content-Type': 'application/json' },
      body: 'x'.repeat(101),
    });
    expect(res.status).toBe(413);
  });

  it('allows a body at/under the cap', async () => {
    const app = appWith(createRequestGuards({ exposed: false, maxBodyBytes: 100 }));
    const res = await app.request('/api/x', {
      method: 'POST',
      headers: { 'Content-Length': '50', 'Content-Type': 'application/json' },
      body: 'x'.repeat(50),
    });
    expect(res.status).toBe(200);
  });
});

describe('createRequestGuards — rate limit', () => {
  it('does NOT rate-limit when the server is not exposed', async () => {
    const app = appWith(createRequestGuards({ exposed: false, rateLimit: { windowMs: 1000, max: 1 } }));
    for (let i = 0; i < 5; i++) {
      const res = await app.request('/api/x');
      expect(res.status).toBe(200);
    }
  });

  it('rate-limits a non-loopback peer on an exposed server (429 over the cap)', async () => {
    // happy-dom/hono test requests carry no node socket → remoteAddress is
    // undefined → treated as a non-loopback peer (key "unknown"), which is the
    // path we want to exercise.
    const app = appWith(createRequestGuards({ exposed: true, rateLimit: { windowMs: 60_000, max: 2 }, now: () => 0 }));
    expect((await app.request('/api/x')).status).toBe(200);
    expect((await app.request('/api/x')).status).toBe(200);
    expect((await app.request('/api/x')).status).toBe(429); // 3rd in-window
  });
});
