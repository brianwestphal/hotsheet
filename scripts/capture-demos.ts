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
 * Per-scenario in-app navigation hook, run after the page loads + the initial
 * settle wait. Most scenarios are static (the demo seeder already configured
 * settings to land on the right view); only the three "open a different
 * surface" demos need a click.
 */
async function navigateForScenario(page: Page, id: number): Promise<void> {
  switch (id) {
    case 8: {
      // Stats dashboard — sidebar widget click toggles dashboard mode.
      await page.click('#sidebar-dashboard-widget');
      await page.waitForSelector('#dashboard-container, .dashboard-section', { timeout: 5000 });
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
      // Give the tile xterms a beat to render their canned PTY output.
      await page.waitForTimeout(1500);
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
      // No navigation; the seeder configured everything.
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
      const svg = elementTreeToSvg(tree, VIEWPORT.width, VIEWPORT.height, `demo-${scenario.id}-`);
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
