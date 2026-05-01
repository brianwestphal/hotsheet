/**
 * HS-8055 — quit-confirm dialog DOM growth regression.
 *
 * The dialog opened with a real terminal preview pane (HS-8041 +
 * HS-7969 follow-up #2) was leaking DOM nodes / monotonically growing
 * the position of xterm-internal absolutely-positioned elements while
 * the dialog stayed open. Two fix layers cover this:
 *
 *   1. JS — `quitConfirm.tsx` ResizeObserver short-circuits when
 *      `fit.proposeDimensions()` matches the term's current cols/rows.
 *   2. CSS — `.quit-confirm-detail` (the grid 1fr track) and
 *      `.quit-confirm-detail-preview` carry `min-width: 0` + `overflow:
 *      hidden` so the absolutely-positioned `.xterm-screen` (whose
 *      width = `cols * cellWidth`) cannot push the grid track wider
 *      than its 1fr allocation. Without that, `proposeDimensions`
 *      returned a larger cols every tick, the JS gate never settled,
 *      and `.xterm-screen` width climbed unbounded (the user's
 *      Inspector screenshot caught it at 6745 px wide inside a ~400 px
 *      pane).
 *
 * This test reproduces the bug by:
 *   1. Configuring multiple PTYs running the existing `terminal-draw.sh`
 *      fixture so the dialog mounts more than one selectable row.
 *   2. Stubbing `__TAURI__.event.listen` so `initQuitConfirm`'s
 *      registration is captured and the test can synthesise the
 *      `quit-confirm-requested` event the Rust CloseRequested handler
 *      would normally fire.
 *   3. Forcing the project's confirm-quit setting to `'always'` so the
 *      §37.5 decision returns `shouldPrompt: true` regardless of what
 *      processes are running.
 *   4. Waiting for the dialog to mount and the auto-selected first
 *      row's preview xterm to start rendering history.
 *   5. Snapshotting growth-prone metrics over time, both while idle and
 *      while actively switching between rows (the user's repro path —
 *      "switch tabs in the quit dialog, actively inspect the
 *      xterm-screen element size over time").
 *   6. Asserting none of the metrics grow monotonically. The headline
 *      metric is `.xterm-screen` width: pre-fix it climbed by hundreds
 *      of pixels per second; post-fix it stays pinned to the value
 *      computed from the first fit.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page } from '@playwright/test';

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

    // Configure multiple eager-spawn terminals running the draw fixture.
    // Three rows is enough to exercise the row-switch path (initial
    // selection + two manual swaps). `confirm_quit_with_running_terminals:
    // 'always'` so the dialog always opens regardless of process
    // exempt-list.
    await request.patch('/api/file-settings', {
      headers,
      data: {
        terminal_enabled: 'true',
        drawer_open: 'false',
        confirm_quit_with_running_terminals: 'always',
        terminals: [
          { id: 'draw1', name: 'Draw 1', command: `/bin/bash ${DRAW_SCRIPT}`, lazy: false },
          { id: 'draw2', name: 'Draw 2', command: `/bin/bash ${DRAW_SCRIPT}`, lazy: false },
          { id: 'draw3', name: 'Draw 3', command: `/bin/bash ${DRAW_SCRIPT}`, lazy: false },
        ],
      },
    });

    // Restart any pre-existing PTYs so a fresh PTY runs the draw script.
    for (const id of ['draw1', 'draw2', 'draw3']) {
      try {
        await request.post('/api/terminal/restart', { headers, data: { terminalId: id } });
      } catch { /* not yet spawned — first run */ }
    }
  });

  test('preview pane never grows while idle or while switching between rows', async ({ page }) => {
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

    // The dialog should mount three rows (one per configured terminal).
    const rows = overlay.locator('.quit-confirm-row');
    await expect(rows).toHaveCount(3, { timeout: 5000 });

    // Give the layout one extra frame to settle so the first-snapshot
    // measurement isn't taken mid-fit.
    await page.waitForTimeout(400);

    // Anchor measurement: capture the .xterm-screen width and the
    // pane's clientWidth. The pre-fix bug climbed `.xterm-screen` width
    // by hundreds of px per second (the user's screenshot caught it at
    // 6745 px in a ~400 px pane); post-fix it stays pinned to the
    // value computed from the first fit. The pane width should NEVER
    // change because the grid track is now constrained by `min-width: 0
    // + overflow: hidden` on `.quit-confirm-detail`.
    const initial = await measureDialogGrowth(page);
    expect(initial.xtermScreenWidth).toBeGreaterThan(0); // sanity — the screen is rendered
    expect(initial.previewClientWidth).toBeGreaterThan(0);

    // === Phase A — idle wait ===
    // The bug manifests over time even with no user input because the
    // ResizeObserver feedback loop ticks every paint. Sample several
    // times so we can assert NO monotonic climb (one-off jitter from
    // the initial fit converging is acceptable; a steady climb is the
    // regression).
    const idleSamples: GrowthSnapshot[] = [initial];
    for (let i = 0; i < 4; i += 1) {
      await page.waitForTimeout(500);
      idleSamples.push(await measureDialogGrowth(page));
    }
    assertNoMonotonicGrowth('idle', idleSamples);

    // === Phase B — actively switch rows, sampling between switches ===
    // The user's note: "switch tabs in the quit dialog, actively
    // inspect the xterm-screen element size over time". Each row swap
    // releases the previous checkout + checks out the next terminal,
    // which schedules a fresh fit. If any switch leaves the pane in a
    // state where the ResizeObserver loop can re-fire, the
    // `.xterm-screen` width will climb across switches.
    const switchSamples: GrowthSnapshot[] = [];
    for (let i = 0; i < 4; i += 1) {
      const target = rows.nth(i % 3);
      await target.click();
      // Wait for the preview xterm to render its first frame after the
      // checkout swap (re-attaching to the same terminal-id replays
      // history near-instantly via the §54 scrollback frame).
      await expect(preview.locator('.xterm-screen')).toContainText(/TOP-STATUS-BAR/, { timeout: 5000 });
      await page.waitForTimeout(400);
      switchSamples.push(await measureDialogGrowth(page));
    }
    assertNoMonotonicGrowth('row-switch', switchSamples);

    // === Phase C — final long idle wait at the end-state ===
    // Combination guard: after the active switching, sit idle for 2 s
    // and re-confirm nothing climbs. This catches the case where a
    // switch leaves a stale ResizeObserver wired but the per-tick gate
    // still fires.
    const settled1 = await measureDialogGrowth(page);
    await page.waitForTimeout(2000);
    const settled2 = await measureDialogGrowth(page);
    expect(settled2.bodyScrollHeight - settled1.bodyScrollHeight).toBeLessThan(100);
    expect(settled2.maxAbsoluteTop - settled1.maxAbsoluteTop).toBeLessThan(100);
    expect(settled2.descendantCount - settled1.descendantCount).toBeLessThan(50);
    // Headline regression guard — `.xterm-screen` width must not climb.
    // A few px of jitter from cell-rounding is acceptable; anything >50
    // is the bug back.
    expect(settled2.xtermScreenWidth - settled1.xtermScreenWidth).toBeLessThan(50);
    // Pane width is structurally pinned by the grid track + min-width:
    // 0 / overflow: hidden CSS, so it must not change at all.
    expect(Math.abs(settled2.previewClientWidth - settled1.previewClientWidth)).toBeLessThan(5);
    // The .xterm-screen width also shouldn't massively exceed the pane
    // (cell-rounding may make it overflow by a few px). This is the
    // single most diagnostic check for the original bug — pre-fix the
    // ratio climbed past 10x; post-fix it's bounded.
    expect(settled2.xtermScreenWidth / settled2.previewClientWidth).toBeLessThan(2);

    // Cleanup so the next test starts clean.
    await page.locator('.quit-confirm-btn-cancel').click();
    await expect(overlay).toHaveCount(0, { timeout: 3000 });
  });
});

interface GrowthSnapshot {
  bodyScrollHeight: number;
  maxAbsoluteTop: number;
  descendantCount: number;
  /** `.xterm-screen` element's `clientWidth`. Pre-fix this climbed
   *  unbounded as `cols * cellWidth` grew on every ResizeObserver
   *  tick. */
  xtermScreenWidth: number;
  /** `.quit-confirm-detail-preview` `clientWidth`. Should be pinned
   *  by the grid track. */
  previewClientWidth: number;
}

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
 *   - `xtermScreenWidth`: `.xterm-screen` `clientWidth` — the headline
 *     metric for HS-8055.
 *   - `previewClientWidth`: parent pane `clientWidth` — should be
 *     structurally pinned by the grid track + CSS containment.
 */
async function measureDialogGrowth(page: Page): Promise<GrowthSnapshot> {
  return await page.evaluate(() => {
    const overlay = document.querySelector('.quit-confirm-overlay');
    let maxAbsoluteTop = 0;
    let descendantCount = 0;
    let xtermScreenWidth = 0;
    let previewClientWidth = 0;
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
      const screen = overlay.querySelector<HTMLElement>('.xterm-screen');
      if (screen !== null) xtermScreenWidth = screen.clientWidth;
      const preview = overlay.querySelector<HTMLElement>('.quit-confirm-detail-preview');
      if (preview !== null) previewClientWidth = preview.clientWidth;
    }
    return {
      bodyScrollHeight: document.body.scrollHeight,
      maxAbsoluteTop,
      descendantCount,
      xtermScreenWidth,
      previewClientWidth,
    };
  });
}

/**
 * Assert that none of the growth-prone metrics climb monotonically
 * across the supplied snapshot series. Allows small per-sample jitter
 * (xterm's paint cycle moves the helper textarea by a few px when the
 * cursor moves) but flags any sustained climb. The headline metric is
 * `xtermScreenWidth` — pre-fix it grew by hundreds of px per second.
 */
function assertNoMonotonicGrowth(label: string, snapshots: GrowthSnapshot[]): void {
  if (snapshots.length < 2) return;
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  // Net climb across the series, tolerated bounds chosen to flag the
  // original bug (hundreds of px / many DOM nodes added) without
  // tripping on benign per-paint jitter.
  expect(last.bodyScrollHeight - first.bodyScrollHeight, `${label}: bodyScrollHeight`).toBeLessThan(150);
  expect(last.maxAbsoluteTop - first.maxAbsoluteTop, `${label}: maxAbsoluteTop`).toBeLessThan(150);
  expect(last.descendantCount - first.descendantCount, `${label}: descendantCount`).toBeLessThan(80);
  expect(last.xtermScreenWidth - first.xtermScreenWidth, `${label}: xtermScreenWidth`).toBeLessThan(50);
  expect(Math.abs(last.previewClientWidth - first.previewClientWidth), `${label}: previewClientWidth`).toBeLessThan(5);
}
