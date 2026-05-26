/**
 * HS-8612 — the page shell stamps `window.__HOTSHEET_DEMO__` only when the
 * process was launched in demo mode, so the client terminal renderer
 * (`shouldUseWebglRenderer`) forces the DOM renderer for domotion-svg capture.
 * The stamp must be absent on a normal launch (so production terminals keep the
 * default WebGL renderer).
 */
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';

import { setDemoMode } from '../demo-mode.js';
import type { AppEnv } from '../types.js';
import { pageRoutes } from './pages.js';

const app = new Hono<AppEnv>();
app.route('/', pageRoutes);

afterEach(() => {
  setDemoMode(false); // module-global — reset so tests don't leak state
});

describe('page shell demo-mode stamp (HS-8612)', () => {
  it('stamps window.__HOTSHEET_DEMO__ in the head when in demo mode', async () => {
    setDemoMode(true);
    const res = await app.request('/');
    const html = await res.text();
    expect(html).toContain('window.__HOTSHEET_DEMO__=true;');
  });

  it('omits the demo stamp entirely on a normal (non-demo) launch', async () => {
    setDemoMode(false);
    const res = await app.request('/');
    const html = await res.text();
    expect(html).not.toContain('__HOTSHEET_DEMO__');
  });
});
