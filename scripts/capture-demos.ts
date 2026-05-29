/**
 * HS-8683 — capture every demo scenario as a PNG (Playwright) + an SVG
 * (domotion-svg) in one pass. Spawns a fresh `tsx src/cli.ts --demo:N` server
 * per scenario in a temp data dir + temp HOME, opens it in headless Chromium,
 * performs the scenario-specific in-app navigation (sidebar widget click for
 * the dashboard demo, toolbar buttons for the terminal-dashboard / cross-
 * project-stats demos), and writes `docs/demo-N.png` + `docs/demo-N.svg`.
 *
 * Usage:
 *   npx tsx scripts/capture-demos.ts            # capture all scenarios
 *   npx tsx scripts/capture-demos.ts 8 13       # capture only the listed ids
 *   DEBUG_CAPTURE=1 npx tsx scripts/capture-demos.ts 13   # forward child stdout
 *
 * Plays nice with a running Hot Sheet instance: each capture spawns its own
 * server on an ephemeral port (4500-5500) in a fresh temp HOME so it never
 * touches `~/.hotsheet/`.
 */
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { chromium, type Page } from '@playwright/test';
import { captureElementTree, elementTreeToSvg, embedRemoteImages } from 'domotion-svg';

import { DEMO_SCENARIOS } from '../src/demo.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const DOCS_DIR = join(REPO_ROOT, 'docs');
const TSX_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli.ts');

const VIEWPORT = { width: 1400, height: 900 } as const;

/**
 * HS-8688 — click the first visible ticket row so the detail panel renders
 * with real content. The user-visible result: a scenario that previously
 * showed an empty "no ticket selected" detail panel now opens with the first
 * card's title, status pill, notes, etc. Skipped for scenarios where the
 * detail panel isn't visible (8 dashboard, 12 terminal dashboard) or where
 * the user is actively interacting with something else (2 ticket-entry input).
 *
 * Card selector covers both list view (`.ticket-row[data-id]`) and column
 * view (`.column-card[data-id]`) per the click handler in `src/client/app.tsx`.
 * Trash rows are excluded — those aren't real tickets.
 */
async function selectFirstTicket(page: Page): Promise<void> {
  const sel = '.ticket-row[data-id]:not(.trash-row), .column-card[data-id]';
  const first = await page.waitForSelector(sel, { state: 'visible', timeout: 5000 }).catch(() => null);
  if (!first) return;
  await first.click();
  // Let the detail panel paint.
  await page.waitForTimeout(250);
}

/**
 * Per-scenario in-app navigation hook, run after the page loads + the initial
 * settle wait. HS-8688 expanded this to cover the demo-screenshot polish asks:
 * pre-select a ticket so the detail panel has content, switch sidebar to the
 * right view (Up Next for demo 4, a custom view for demo 3), type example
 * text into the new-ticket entry input for demo 2, multi-select for demo 5,
 * hover the cumulative-flow chart for demo 8, and wait for every dashboard
 * tile to leave the cold "Not yet started" placeholder for demo 12.
 */
async function navigateForScenario(page: Page, id: number): Promise<void> {
  switch (id) {
    case 2: {
      // HS-8688 — Quick entry demo. The whole point is the bullet-list new-
      // ticket input; type example text so the screenshot shows the input
      // actively being used. Don't press Enter — submitting would create the
      // ticket and clear the input.
      const draft = await page.waitForSelector('input.draft-input', { state: 'visible', timeout: 5000 }).catch(() => null);
      if (draft) {
        await draft.fill('Add dark mode support to the settings dialog');
        // Make sure the input keeps focus so the caret renders in the shot.
        await draft.focus();
      }
      // No `selectFirstTicket` here — focus belongs in the entry input.
      break;
    }
    case 3: {
      // HS-8688 — Sidebar filtering demo. Switch from "All Tickets" to one of
      // the configured custom views (per `SCENARIO_3_VIEWS` in `src/demo.ts`)
      // so the screenshot demonstrates the filtering feature, not the default
      // view. `high-priority-bugs` is the more visually obvious choice.
      const customView = await page.waitForSelector(
        '.sidebar-item[data-view="custom:high-priority-bugs"]',
        { state: 'visible', timeout: 5000 },
      ).catch(() => null);
      if (customView) await customView.click();
      await page.waitForTimeout(250);
      await selectFirstTicket(page);
      break;
    }
    case 4: {
      // HS-8688 — AI worklist demo. Switch the sidebar to the Up Next view
      // (the built-in filter, `data-view="up-next"`) so the screenshot
      // matches the demo's framing.
      const upNext = await page.waitForSelector(
        '.sidebar-item[data-view="up-next"]',
        { state: 'visible', timeout: 5000 },
      ).catch(() => null);
      if (upNext) await upNext.click();
      await page.waitForTimeout(250);
      await selectFirstTicket(page);
      break;
    }
    case 5: {
      // HS-8688 — Batch operations demo. The whole point is the multi-select
      // toolbar, so select 3 tickets via Cmd/Ctrl-click. Selectable rows are
      // both list-view `.ticket-row[data-id]` and column-view
      // `.column-card[data-id]` (the scenario uses column layout per the
      // HS-8430 COLUMN_VIEW_SCENARIOS set in `src/demo.ts`).
      const cards = await page.locator('.column-card[data-id], .ticket-row[data-id]:not(.trash-row)').all();
      const targets = cards.slice(0, 3);
      // Cmd on macOS / Ctrl elsewhere — Playwright's `'Meta'` works on
      // Chromium across platforms because the click-handler in `app.tsx`
      // treats Meta + Ctrl identically for additive selection.
      for (const t of targets) {
        await t.click({ modifiers: ['Meta'] });
      }
      await page.waitForTimeout(250);
      break;
    }
    case 8: {
      // Stats dashboard — sidebar widget click toggles dashboard mode.
      await page.click('#sidebar-dashboard-widget');
      await page.waitForSelector('#dashboard-container, .dashboard-section', { timeout: 5000 });
      // HS-8688 — hover the Cumulative Flow chart so its tooltip popup
      // renders. The hover handler lives in `addChartHover` in
      // `src/client/dashboard.tsx` and listens to `mousemove` on the chart's
      // `<svg>` directly, using `clientX`/`clientY` against the SVG's
      // `getBoundingClientRect`. So a `page.mouse.move(x, y)` to an
      // absolute viewport coord inside the SVG is enough; no special
      // synthetic-event dispatch needed.
      await page.waitForTimeout(800); // chart render settle
      // Scoped to `.dashboard-chart-body svg` so we hit the chart's actual SVG,
      // NOT the `INFO_ICON` SVG sitting in `.dashboard-chart-header > button`
      // (the i-button next to the chart title). A bare `svg.first()` selector
      // picked up the info icon — which IS still an SVG but isn't wired to
      // `addChartHover`'s `mousemove` listener, so the popup never showed.
      const cfdSvg = page.locator('.dashboard-chart-card', { hasText: 'Cumulative Flow' }).locator('.dashboard-chart-body svg');
      const box = await cfdSvg.boundingBox();
      if (box) {
        // 70% across the time axis — late enough that the stacked bands have
        // mass to show in the tooltip, far enough from the right edge that
        // the tooltip popup itself doesn't clip out of the SVG.
        await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5);
        // Tooltip is rendered synchronously on the same mousemove, but allow
        // a frame for the DOM update to flush before the screenshot.
        await page.waitForTimeout(150);
      }
      break;
    }
    case 12: {
      // Terminal dashboard — toolbar button (`square-terminal` icon). The
      // button starts at `style="display:none"` and `initTerminalDashboard`
      // reveals it via `style.display = ''`. Playwright's default
      // `state: 'visible'` handles that transition correctly.
      await page.waitForSelector('#terminal-dashboard-toggle', { state: 'visible', timeout: 10_000 });
      await page.click('#terminal-dashboard-toggle');
      await page.waitForSelector('.terminal-dashboard, .terminal-dashboard-section', { timeout: 5000 });
      // HS-8688 — every tile starts at `state: 'not_spawned'` and renders the
      // "Not yet started" play-glyph placeholder until its WebSocket-checkout
      // triggers the lazy spawn and the PTY's output streams through. The §54
      // `mountTileViaCheckout` connects synchronously on each tile mount, so
      // a generous settle wait gets every visible tile attached + its bytes
      // painted. We deliberately do NOT click cold placeholders as a "kick":
      // the first click enters the §25 center-magnify state which then sits
      // in front of the other tiles and eats subsequent clicks, leaving the
      // rest cold AND the dashboard in a magnified-one-tile pose nobody wants
      // in a marketing shot.
      //
      // HS-8689 — bumped from 5 s to 12 s to span one full iteration of the
      // scenario-12 terminals' `while :; do clear-then-printf; sleep 10; done`
      // re-emit loop. The HS-6799 first-attach scrollback clear wipes whatever
      // bytes the eager-spawned PTY had written before WS attach; the next
      // loop iteration (within ≤ 10 s) repaints the content. Waiting at least
      // one loop interval guarantees the screenshot catches the repaint.
      await page.waitForTimeout(12_000);
      break;
    }
    case 13: {
      // Cross-project stats — header `line-chart` button. Revealed by the
      // `setSectionVisibility` poll once telemetry_enabled is true on at
      // least one registered project.
      await page.waitForSelector('#cross-project-stats-toggle', { state: 'visible', timeout: 15_000 });
      await page.click('#cross-project-stats-toggle');
      await page.waitForSelector('.cross-project-stats-page, .telemetry-dashboard-title', { timeout: 5000 });
      // Sections render asynchronously via fetchAndRender — let them paint.
      await page.waitForTimeout(1000);
      break;
    }
    default:
      // HS-8688 — every "static" scenario (1, 6, 7, 9, 10, 11) at least
      // benefits from a pre-selected ticket so its detail panel renders with
      // content instead of the empty placeholder. The seeder already
      // configured the right view; this just clicks the first card.
      await selectFirstTicket(page);
      break;
  }
}

async function pollServerReady(port: number, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1000);
      try {
        const res = await fetch(`http://localhost:${port}/api/stats`, { signal: ctrl.signal });
        if (res.ok) return;
      } finally { clearTimeout(t); }
    } catch {
      // Connection refused while the server is starting up.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server on port ${port} did not become ready within ${timeoutMs}ms`);
}

function pickRandomPort(): number {
  return 4500 + Math.floor(Math.random() * 1000);
}

interface Scenario { id: number; label: string }

async function captureScenario(scenario: Scenario): Promise<void> {
  const port = pickRandomPort();
  const homeDir = mkdtempSync(join(tmpdir(), 'hs-capture-home-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'hs-capture-data-'));

  console.log(`\n[demo-${scenario.id}] ${scenario.label}`);
  console.log(`  port=${port}, home=${homeDir}`);
  console.log(`  spawning server...`);

  const proc: ChildProcess = spawn(TSX_BIN, [
    CLI_ENTRY,
    '--data-dir', dataDir,
    '--no-open',
    '--port', String(port),
    `--demo:${scenario.id}`,
  ], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, PLUGINS_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (process.env.DEBUG_CAPTURE !== undefined && process.env.DEBUG_CAPTURE !== '') {
    proc.stdout?.on('data', (c: Buffer) => process.stdout.write(`[${scenario.id}] ${c.toString()}`));
    proc.stderr?.on('data', (c: Buffer) => process.stderr.write(`[${scenario.id}] ${c.toString()}`));
  } else {
    // Drain stdout/stderr so the child doesn't block on a full pipe buffer.
    proc.stdout?.on('data', () => { /* drop */ });
    proc.stderr?.on('data', () => { /* drop */ });
  }

  try {
    await pollServerReady(port);
    console.log(`  server ready, launching browser...`);

    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: { width: VIEWPORT.width, height: VIEWPORT.height } });
      const page = await context.newPage();

      // HS-8367 — suppress the §50 upgrade-nudge overlay (otherwise it
      // covers the chrome on a fresh browser context).
      await page.addInitScript(() => {
        try {
          window.localStorage.setItem('hotsheet_upgrade_nudge_last_shown', String(Number.MAX_SAFE_INTEGER));
        } catch { /* private mode */ }
      });

      // `'load'` not `'networkidle'` — Hot Sheet's `/api/poll` long-poll keeps
      // the network active forever, so `'networkidle'` (Playwright's "500 ms
      // of no requests") never resolves and times out at 30 s.
      await page.goto(`http://localhost:${port}/`, { waitUntil: 'load', timeout: 30_000 });
      // The app's first paint can race the early API loads; settle wait
      // matches the e2e fixture's pattern.
      await page.waitForTimeout(800);

      await navigateForScenario(page, scenario.id);

      // Final settle so any post-nav async loads (chart fetches, etc.) land.
      await page.waitForTimeout(500);

      const pngPath = join(DOCS_DIR, `demo-${scenario.id}.png`);
      await page.screenshot({ path: pngPath, fullPage: false });
      console.log(`  ✓ PNG: ${pngPath}`);

      const tree = await captureElementTree(page, 'body', { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height });
      await embedRemoteImages(tree);
      // HS-8687 / domotion-svg 0.6.0: `elementTreeToSvg` now returns a complete
      // SVG document (outer `<svg xmlns viewBox …>` included) AND its variadic
      // tail moved into an `opts` object. The old (0.5.0) function returned
      // inner-body markup only — the previously-saved `docs/demo-N.svg` files
      // were technically malformed because we wrote that bare inner content
      // straight to disk. The new shape produces a self-contained, browser-
      // openable SVG with no caller-side `wrapSvg` step.
      const svg = elementTreeToSvg(tree, VIEWPORT.width, VIEWPORT.height, { idPrefix: `demo-${scenario.id}-` });
      const svgPath = join(DOCS_DIR, `demo-${scenario.id}.svg`);
      writeFileSync(svgPath, svg);
      console.log(`  ✓ SVG: ${svgPath} (${(svg.length / 1024).toFixed(1)} KB)`);
    } finally {
      await browser.close();
    }
  } finally {
    proc.kill('SIGTERM');
    // Give the child a beat to release the port + clean up its PGLite.
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function main(): Promise<void> {
  // Optional filter: `tsx scripts/capture-demos.ts 8 13`
  const filterArgs = process.argv.slice(2).map(Number).filter((n) => !isNaN(n));
  const scenarios = filterArgs.length > 0
    ? DEMO_SCENARIOS.filter((s) => filterArgs.includes(s.id))
    : DEMO_SCENARIOS;

  if (scenarios.length === 0) {
    console.error(`No matching scenarios. Available ids: ${DEMO_SCENARIOS.map((s) => s.id).join(', ')}`);
    process.exit(1);
  }

  console.log(`Capturing ${scenarios.length} demo scenario(s): ${scenarios.map((s) => s.id).join(', ')}`);
  console.log(`Output dir: ${DOCS_DIR}`);

  const failures: Array<{ id: number; error: unknown }> = [];
  for (const s of scenarios) {
    try {
      await captureScenario(s);
    } catch (e) {
      console.error(`[demo-${s.id}] FAILED: ${e instanceof Error ? e.message : String(e)}`);
      failures.push({ id: s.id, error: e });
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} scenario(s) failed:`);
    for (const f of failures) console.error(`  demo-${f.id}: ${f.error instanceof Error ? f.error.message : String(f.error)}`);
    process.exit(1);
  }

  console.log(`\n✓ All ${scenarios.length} captures complete.`);
}

void main();
