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

describe('detail-panel telemetry block placement (HS-8648)', () => {
  it('renders the per-ticket telemetry container just above the Notes section', async () => {
    const res = await app.request('/');
    const html = await res.text();
    const telemetryIdx = html.indexOf('id="detail-telemetry-stats"');
    const notesIdx = html.indexOf('id="detail-notes-section"');
    const metaIdx = html.indexOf('id="detail-meta"');

    // All three must be present in the rendered shell.
    expect(telemetryIdx).toBeGreaterThan(-1);
    expect(notesIdx).toBeGreaterThan(-1);
    expect(metaIdx).toBeGreaterThan(-1);

    // HS-8648 moved telemetry from the bottom (after meta) to directly above
    // Notes: telemetry < notes < meta in source order.
    expect(telemetryIdx).toBeLessThan(notesIdx);
    expect(notesIdx).toBeLessThan(metaIdx);
  });
});
