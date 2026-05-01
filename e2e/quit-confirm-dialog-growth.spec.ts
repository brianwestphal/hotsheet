/**
 * HS-8055 — quit-confirm dialog DOM growth regression.
 *
 * The dialog opened with a real terminal preview pane (HS-8041 +
 * HS-7969 follow-up #2) was leaking DOM nodes / monotonically growing
 * the position of xterm-internal absolutely-positioned elements while
 * the dialog stayed open. The cause was a ResizeObserver feedback loop
 * inside `showQuitConfirmDialog`: every fire of the observer called
 * `fit.fit()` + `handle.resize(...)`, which mutated xterm's internal
 * DOM (canvas + accessibility rows + helper textarea), the resulting
 * layout pass ticked the ResizeObserver again, and the loop kept
 * running. The dialog itself looked stable (the user reported
 * "apparent in inspector only") but `document.body.scrollHeight` and
 * the highest absolutely-positioned `top` value inside the dialog
 * grew unbounded over time.
 *
 * This test reproduces the loop by:
 *   1. Configuring a real PTY via the existing `terminal-draw.sh`
 *      fixture so the preview pane attaches to a live xterm.
 *   2. Stubbing `__TAURI__.event.listen` so `initQuitConfirm`'s
 *      registration is captured + the test can synthesise the
 *      `quit-confirm-requested` event the Rust CloseRequested handler
 *      would normally fire.
 *   3. Forcing the project's confirm-quit setting to `'always'` so the
 *      §37.5 decision returns `shouldPrompt: true` regardless of what
 *      processes are running.
 *   4. Waiting for the dialog to mount + the auto-selected first row's
 *      preview xterm to start rendering history.
 *   5. Snapshotting `document.body.scrollHeight` + the maximum `top`
 *      pixel value across all absolutely-positioned descendants of
 *      the overlay, twice, ~2 seconds apart.
 *   6. Asserting neither value grew between snapshots (any growth
 *      indicates the ResizeObserver loop has reappeared OR a new
 *      growth source was introduced that the existing fix doesn't
 *      cover — either way the user-visible inspector regression
 *      from HS-8055 is back).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from './coverage-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRAW_SCRIPT = path.join(__dirname, 'fixtures', 'terminal-draw.sh');

let headers: Record<string, string> = {};

test.describe('Quit-confirm dialog DOM growth (HS-8055)', () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get('/api/projects');
    const projects = await res.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.beforeEach(async ({ page, request }) => {
    // Stub __TAURI__ + capture every event listener registration so the
    // test can synthesise `quit-confirm-requested` later. The shape
    // mirrors `getTauriInvoke()` + `getTauriEventListener()` in
    // `tauriIntegration.tsx`.
    await page.addInitScript(() => {
      const listeners: Record<string, ((e: { payload: unknown }) => void)[]> = {};
      const w = window as unknown as Record<string, unknown>;
      w.__TAURI__ = {
        core: { invoke: async () => undefined },
        event: {
          listen: async (eventName: string, handler: (e: { payload: unknown }) => void) => {
            if (listeners[eventName] === undefined) listeners[eventName] = [];
            listeners[eventName].push(handler);
            return () => {
              const arr = listeners[eventName];
              if (arr === undefined) return;
              const idx = arr.indexOf(handler);
              if (idx >= 0) arr.splice(idx, 1);
            };
          },
        },
      };
      w.__hotsheetFireTauriEvent = (eventName: string, payload: unknown) => {
        const arr = listeners[eventName];
        if (arr === undefined) return;
        for (const h of arr) h({ payload });
      };
    });

    // Tear down dynamic terminals from earlier tests so the project
    // boots with a single known config.
    try {
      const list = await (await request.get('/api/terminal/list', { headers })).json() as {
        dynamic?: { id: string }[];
      };
      for (const d of list.dynamic ?? []) {
        await request.post('/api/terminal/destroy', { headers, data: { terminalId: d.id } });
      }
    } catch { /* fine on first run */ }

    // Configure a single eager-spawn terminal that runs the draw fixture.
    // `confirm_quit_with_running_terminals: 'always'` so the dialog
    // always opens regardless of process exempt-list.
    await request.patch('/api/file-settings', {
      headers,
      data: {
        terminal_enabled: 'true',
        drawer_open: 'false',
        confirm_quit_with_running_terminals: 'always',
        terminals: [
          { id: 'draw', name: 'Draw', command: `/bin/bash ${DRAW_SCRIPT}`, lazy: false },
        ],
      },
    });

    // Restart any pre-existing PTY for this id so a fresh PTY runs the
    // draw script.
    try {
      await request.post('/api/terminal/restart', { headers, data: { terminalId: 'draw' } });
    } catch { /* not yet spawned — first run */ }
  });

  test('opens via Tauri event + does not grow DOM while idle', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Fire the synthetic `quit-confirm-requested` event. The
    // `initQuitConfirm` listener registered at app init runs the
    // §37.5 decision + mounts the dialog. We don't await the
    // resulting promise — the dialog stays open until the user
    // dismisses it.
    await page.evaluate(() => {
      const w = window as unknown as { __hotsheetFireTauriEvent?: (e: string, p: unknown) => void };
      w.__hotsheetFireTauriEvent?.('quit-confirm-requested', null);
    });

    // The overlay mounts as soon as the /api/projects/quit-summary
    // fetch resolves. Wait for the auto-selected first row's preview
    // pane to start rendering xterm content (the test fixture writes
    // 'TOP-STATUS-BAR' on first paint).
    const overlay = page.locator('.quit-confirm-overlay');
    await expect(overlay).toBeVisible({ timeout: 10000 });
    const preview = overlay.locator('.quit-confirm-detail-preview');
    await expect(preview).toBeVisible({ timeout: 5000 });
    await expect(preview.locator('.xterm-screen')).toContainText(/TOP-STATUS-BAR/, { timeout: 8000 });

    // Give the layout one extra frame to settle so the first-snapshot
    // measurement isn't taken mid-fit.
    await page.waitForTimeout(400);

    // Snapshot 1.
    const snapshot1 = await measureDialogGrowth(page);

    // Idle wait — the bug manifests over time even with no user input
    // because the ResizeObserver feedback loop ticks every paint.
    await page.waitForTimeout(2000);

    // Snapshot 2.
    const snapshot2 = await measureDialogGrowth(page);

    // The maximum tolerated drift is small. Pre-fix the bug grew the
    // values monotonically by hundreds of pixels per second; the fix
    // settles within one rAF and produces zero drift in practice. Any
    // drift of >100 px is the regression. (Some sub-pixel jitter from
    // xterm's own paint cycle is normal — e.g. xterm-helper-textarea
    // following the cursor as PTY output writes new chars — so the
    // assertion is "no monotonic growth," not "perfect equality.")
    expect(snapshot2.bodyScrollHeight - snapshot1.bodyScrollHeight).toBeLessThan(100);
    expect(snapshot2.maxAbsoluteTop - snapshot1.maxAbsoluteTop).toBeLessThan(100);
    expect(snapshot2.descendantCount - snapshot1.descendantCount).toBeLessThan(50);

    // Cleanup so the next test starts clean.
    await page.locator('.quit-confirm-btn-cancel').click();
    await expect(overlay).toHaveCount(0, { timeout: 3000 });
  });
});

/**
 * Snapshot the dialog's growth-prone metrics:
 *   - `bodyScrollHeight`: total page scroll height — grows when any
 *     descendant pushes the document layout taller.
 *   - `maxAbsoluteTop`: highest `style.top` value across every
 *     absolutely-positioned descendant of the overlay (xterm puts its
 *     accessibility rows + helper textarea at absolute offsets, and
 *     these are what HS-8055 was showing in the user's inspector).
 *   - `descendantCount`: total DOM-node count under the overlay —
 *     grows when xterm leaks accessibility spans or any other repeat-
 *     rendered DOM accumulates.
 */
async function measureDialogGrowth(page: import('@playwright/test').Page): Promise<{
  bodyScrollHeight: number;
  maxAbsoluteTop: number;
  descendantCount: number;
}> {
  return await page.evaluate(() => {
    const overlay = document.querySelector('.quit-confirm-overlay');
    let maxAbsoluteTop = 0;
    let descendantCount = 0;
    if (overlay !== null) {
      const all = overlay.querySelectorAll<HTMLElement>('*');
      descendantCount = all.length;
      for (const el of all) {
        const cs = window.getComputedStyle(el);
        if (cs.position === 'absolute') {
          const top = parseFloat(cs.top);
          if (!Number.isNaN(top) && top > maxAbsoluteTop) maxAbsoluteTop = top;
        }
      }
    }
    return {
      bodyScrollHeight: document.body.scrollHeight,
      maxAbsoluteTop,
      descendantCount,
    };
  });
}
