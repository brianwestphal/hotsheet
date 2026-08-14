/**
 * HS-8683 — capture every demo scenario as a PNG (Playwright) + an animated SVG
 * (domotion-svg) in one pass. Spawns a fresh `tsx src/cli.ts --demo:N` server
 * per scenario in a temp data dir + temp HOME, opens it in headless Chromium,
 * performs the scenario-specific in-app navigation (sidebar widget click for
 * the dashboard demo, toolbar buttons for the terminal-dashboard / cross-
 * project-stats demos, Listen button for the announcer demo), and writes
 * `docs/demo-N.png` (a raw Playwright still) + `docs/demo-N.svg`.
 *
 * HS-9003 — `docs/demo-N.svg` is no longer a bare screenshot: `buildStoryboard`
 * composes each capture into a short, self-contained ANIMATED storyboard —
 * a light title card (per-demo copy from `DEMO_META`) → the app framed in a
 * light macOS-style window bezel with a white-on-dark lower-third caption — on a
 * transparent background, driven through the `domotion` CLI verbs (`template` /
 * `composite` / `storyboard`). The README embeds these SVGs. The announcer demo
 * (14) additionally mocks the `/api/announcer/*` read endpoints client-side (the
 * PIP can't be seeded headlessly — see `setupRoutesForScenario`).
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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { chromium, type Page } from '@playwright/test';
import { captureElementTree, elementTreeToSvg, embedRemoteImages, wrapInDeviceChrome } from 'domotion-svg';

import { DEMO_SCENARIOS } from '../src/demo.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const DOCS_DIR = join(REPO_ROOT, 'docs');
const TSX_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const DOMOTION_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'domotion');
const SVG_TO_VIDEO_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'svg-to-video');
const SVG_TO_IMAGE_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'svg-to-image');
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli.ts');

const VIEWPORT = { width: 1400, height: 900 } as const;

// HS-9003 — motion knobs for the dynamic demo treatment (below). No title card:
// each demo opens directly on the UI, then a per-demo camera move (a gentle
// full-window "dolly" or a "focus" push toward a hero element) plays while an
// in-context caption fades in. Timings follow the domotion motion playbook
// (ease-out entrance, hold long enough to read).
const PAD_X = 50; // transparent margin the window "grows into" during the push (L/R)
const PAD_TOP = 46; // top margin
const PAD_BOTTOM = 46; // bottom margin (caption overlaps the lower window, lower-third style)
const DOLLY_SCALE = 1.06; // whole-window push (overview/grid demos)
const FOCUS_SCALE = 1.28; // push toward a hero element (feature demos) — tighter so the highlighted feature is legible at README size (codex feedback, HS-9663)
const MOVE_START_MS = 700; // hold the establishing frame, then begin the move
const MOVE_DUR_MS = 1700; // camera-move duration
const CAPTION_HOLD_MS = 2100; // caption on-screen time (enter + hold + exit)
const TOTAL_MS = 4600; // full clip length
const MOVE_EASE = 'cubic-bezier(0.215,0.61,0.355,1)'; // ease-out (entrance feel)

/**
 * HS-9003 — per-demo dynamic-demo spec. Each captured app screen is framed in a
 * light macOS window bezel and composed into a short animated SVG that opens
 * directly on the UI (no title card), plays a `verb` camera move, and fades in a
 * white-on-dark lower-third `caption` naming the feature as the move settles.
 *
 * `verb`:
 *   'dolly' — a gentle whole-window push (overview / grid demos, where cropping
 *             would just remove the context that IS the point).
 *   'focus' — a stronger push toward `heroSelector`'s center, so the highlighted
 *             element enlarges and draws the eye. Falls back to 'dolly' when the
 *             selector doesn't resolve (logged), so a missed selector degrades to
 *             a safe move rather than an awkward crop.
 * `captionPosition` moves the lower-third off content-heavy bottoms.
 */
interface DemoMeta {
  verb: 'dolly' | 'focus';
  caption: string;
  heroSelector?: string;
  captionPosition?: 'bottom-center' | 'top-center';
  /** HS-9664 — per-demo push strength override (default `FOCUS_SCALE`), for demos
   *  whose hero wants a tighter crop than the shared value gives. */
  focusScale?: number;
  /** HS-9664 — draw a purple rounded-rect emphasis ring around the hero element,
   *  baked into the app SVG (so it scales with the camera push). Varies the visual
   *  verb away from zoom-only: the ring points the eye at the exact feature. */
  highlight?: boolean;
}
const DEMO_META: Record<number, DemoMeta> = {
  1: { verb: 'dolly', caption: 'Categories, priorities & statuses — at a glance' },
  2: { verb: 'focus', heroSelector: 'input.draft-input', caption: 'Capture a ticket in one keystroke' },
  3: { verb: 'focus', heroSelector: '.sidebar, #sidebar', caption: 'Slice your work — custom views & filters' },
  4: { verb: 'focus', heroSelector: '.detail-panel', caption: 'Watch AI work update tickets live' },
  5: { verb: 'focus', heroSelector: '.selection-toolbar, .batch-toolbar, .list-controls, [class*="controls"]', caption: 'Multi-select → edit many at once' },
  6: { verb: 'focus', heroSelector: '.detail-panel', caption: 'The full story — details, tags & notes', captionPosition: 'top-center' },
  7: { verb: 'dolly', caption: 'A kanban board by status' },
  8: { verb: 'focus', heroSelector: '.dashboard-chart-card', caption: 'Throughput, flow & cycle time', captionPosition: 'top-center' },
  9: { verb: 'focus', heroSelector: '#channel-play-section, [id^="channel-play"]', caption: 'Send a ticket straight to Claude Code', captionPosition: 'top-center' },
  10: { verb: 'focus', heroSelector: '.project-tabs-inner', caption: 'Switch projects without leaving Hot Sheet', captionPosition: 'bottom-center', focusScale: 1.55, highlight: true },
  11: { verb: 'focus', heroSelector: '#footer-drawer, [id^="drawer-"]', caption: 'Terminals, built right in', captionPosition: 'top-center' },
  12: { verb: 'dolly', caption: 'Every terminal at once', captionPosition: 'top-center' },
  13: { verb: 'focus', heroSelector: '#telemetry-dashboard-cost-over-time, .cross-project-stats-page', caption: 'Track Claude Code costs over time', captionPosition: 'top-center' },
  14: { verb: 'focus', heroSelector: '.announcer-pip', caption: 'Hear what shipped — narrated, with diffs', captionPosition: 'top-center' },
};

/**
 * HS-9664 — REAL-INTERACTION demos. A handful of demos earn a live interaction
 * (typing, clicking, scrolling, a context menu) instead of a camera move: they
 * read as a usable tool, not a pretty screenshot. These drive the LIVE demo
 * server through `domotion animate` (0.23.0+, `networkidle` now opt-in so the
 * long-poll no longer blocks navigation): `typeResample` types key-by-key into
 * the app's own field, `actions` click/press/hover with an animated cursor,
 * `scroll` really scrolls, `evaluate` drives a state change / suppresses nudges.
 * The animated app SVG is then wrapped in the same window chrome + caption as the
 * camera demos (`buildInteractionDemo`), so the set stays visually cohesive.
 *
 * A demo listed here takes the interaction path in `captureScenario` INSTEAD of
 * the static-capture + camera-move path; its caption still comes from `DEMO_META`.
 */
type AnimateFrame = Record<string, unknown>;
interface InteractionSpec {
  /** Timeline position (ms) to grab the PNG poster / payoff still. */
  posterAtMs: number;
  /** Build the animate frames for a live server URL. Frame 0's `actions` get the
   *  nudge-suppress `evaluate` prepended automatically. The clip's total duration
   *  is read back from the rendered SVG (typeResample expands frame 1), so it is
   *  not specified here. `secret` is the demo project's API secret (from
   *  `<dataDir>/secret.json`) for demos that drive a mutation via `evaluate` +
   *  `fetch` (e.g. the live-update demo). */
  frames: (url: string, secret: string) => AnimateFrame[];
}

/** Injected as frame 0's first action: hide any nudge/network overlay (the
 *  upgrade nudge is a modal that would intercept the interaction clicks) whenever
 *  it appears, via a persistent stylesheet rule + an immediate sweep. */
const NUDGE_SUPPRESS =
  "var st=document.createElement('style'); " +
  "st.textContent='.upgrade-nudge-overlay,[class*=\"nudge-overlay\"],#network-error-popup,.network-error-popup,#channel-disconnected-alert{display:none !important}'; " +
  "document.head.appendChild(st); " +
  "document.querySelectorAll('.upgrade-nudge-overlay,[class*=\"nudge-overlay\"],#network-error-popup,#channel-disconnected-alert').forEach(function(el){el.remove();});";

const INTERACTIONS: Record<number, InteractionSpec> = {
  // demo-2 — quick capture: type a ticket title key-by-key, press Enter, the new
  // card appears at the top of NOT STARTED (and the detail panel opens on it).
  2: {
    posterAtMs: 5200,
    frames: (url) => [
      {
        input: url,
        waitFor: 'input.draft-input',
        wait: 700,
        actions: [{ type: 'click', selector: 'input.draft-input' }],
        typeResample: { selector: 'input.draft-input', text: 'Add dark mode support to the settings dialog', speed: 22, caret: true },
        duration: 2400,
      },
      {
        continue: true,
        actions: [{ type: 'focus', selector: 'input.draft-input' }, { type: 'press', key: 'Enter' }, { type: 'wait', ms: 1300 }],
        duration: 2600,
        transition: { type: 'crossfade', duration: 300 },
      },
    ],
  },
  // demo-4 — live update: open a ticket, then an AI/MCP-style change lands via
  // fetch (status → started + a progress note). The WS push (docs/93) updates the
  // open detail panel AND moves the card to the STARTED column live — no reload.
  4: {
    posterAtMs: 4300,
    frames: (url, secret) => [
      {
        input: url,
        waitFor: '.column-card[data-id], .ticket-row[data-id]',
        wait: 500,
        actions: [
          { type: 'click', selector: '.column-card[data-id], .ticket-row[data-id]:not(.trash-row)' },
          { type: 'wait', ms: 800 },
        ],
        duration: 1500,
      },
      {
        continue: true,
        actions: [
          // Mutate the OPEN ticket as an external agent would (the channel/MCP
          // path). The WS bus pushes `ticket-updated` → the client updates in place.
          { type: 'evaluate', script: "var card=document.querySelector('.column-card.selected, .ticket-row.selected'); var id=card&&card.getAttribute('data-id'); if(id){fetch('/api/tickets/'+id,{method:'PATCH',headers:{'Content-Type':'application/json','X-Hotsheet-Secret':'" + secret + "','X-Hotsheet-Actor':'claude','X-Hotsheet-Actor-Label':'Claude Code'},body:JSON.stringify({status:'started',notes:'Started working on this — implemented the core change and added tests. All passing; opening a PR for review.'})});}" },
          { type: 'wait', ms: 1500 },
        ],
        duration: 2700,
        transition: { type: 'crossfade', duration: 300 },
      },
    ],
  },
  // demo-5 — batch ops: switch to list view, click three rows' checkboxes (the
  // selection grows with an animated cursor), right-click a selected row to open
  // the context menu, open its Priority submenu, and set High — a real batch
  // change applied to all three at once.
  5: {
    posterAtMs: 5900,
    frames: (url) => [
      {
        input: url,
        waitFor: '#layout-toggle .layout-btn[data-layout="list"]',
        wait: 500,
        actions: [
          { type: 'click', selector: '#layout-toggle .layout-btn[data-layout="list"]' },
          { type: 'wait', ms: 500 },
        ],
        duration: 1100,
      },
      // Select three rows one at a time. `:not(:checked)` always targets the
      // topmost still-unselected row, so repeating the same click walks down.
      { continue: true, actions: [{ type: 'click', selector: '.ticket-row[data-id] .ticket-checkbox:not(:checked)' }, { type: 'wait', ms: 200 }], duration: 650, transition: { type: 'crossfade', duration: 180 } },
      { continue: true, actions: [{ type: 'click', selector: '.ticket-row[data-id] .ticket-checkbox:not(:checked)' }, { type: 'wait', ms: 200 }], duration: 650, transition: { type: 'crossfade', duration: 180 } },
      { continue: true, actions: [{ type: 'click', selector: '.ticket-row[data-id] .ticket-checkbox:not(:checked)' }, { type: 'wait', ms: 200 }], duration: 900, transition: { type: 'crossfade', duration: 180 } },
      // Right-click a selected row → context menu (positioned via a real MouseEvent).
      {
        continue: true,
        actions: [
          { type: 'evaluate', script: "var row=document.querySelector('.ticket-row:has(.ticket-checkbox:checked)'); if(row){var r=row.getBoundingClientRect(); row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:Math.round(r.left+140),clientY:Math.round(r.top+16)}));}" },
          { type: 'wait', ms: 300 },
        ],
        duration: 1200,
        transition: { type: 'crossfade', duration: 200 },
      },
      // Open the Priority submenu (force it visible at its CSS position).
      {
        continue: true,
        actions: [
          { type: 'evaluate', script: "var it=[].slice.call(document.querySelectorAll('.context-menu .context-menu-item.has-submenu')).filter(function(el){var l=el.querySelector('.context-menu-label');return l&&l.textContent.trim()==='Priority';})[0]; if(it){var sm=it.querySelector('.context-submenu'); if(sm){sm.style.display='block';}}" },
          { type: 'wait', ms: 250 },
        ],
        duration: 1100,
      },
      // Click "High" → applyToSelected('priority','high') updates all three.
      {
        continue: true,
        actions: [
          { type: 'evaluate', script: "var it=[].slice.call(document.querySelectorAll('.context-menu .context-menu-item.has-submenu')).filter(function(el){var l=el.querySelector('.context-menu-label');return l&&l.textContent.trim()==='Priority';})[0]; if(it){var opt=[].slice.call(it.querySelectorAll('.context-submenu .context-menu-item')).filter(function(el){var l=el.querySelector('.context-menu-label');return l&&l.textContent.trim()==='High';})[0]; if(opt){opt.click();}}" },
          { type: 'wait', ms: 500 },
        ],
        duration: 1700,
        transition: { type: 'crossfade', duration: 200 },
      },
    ],
  },
  // demo-9 — send a ticket to Claude: click the channel play button, then open
  // the Claude terminal tab to reveal a realistic session picking up the top Up
  // Next ticket (HS-4) and starting work. The terminal is lazy, so opening the
  // tab spawns it and the canned session streams in "in response" to the play.
  9: {
    posterAtMs: 5600,
    frames: (url) => [
      {
        input: url,
        waitFor: '#channel-play-btn',
        wait: 600,
        duration: 1400,
      },
      {
        continue: true,
        actions: [{ type: 'click', selector: '#channel-play-btn' }, { type: 'wait', ms: 600 }],
        duration: 1200,
        transition: { type: 'crossfade', duration: 200 },
      },
      {
        continue: true,
        actions: [
          { type: 'click', selector: '.drawer-tab[data-drawer-tab="terminal:claude-work"]' },
          { type: 'wait', ms: 2000 },
        ],
        duration: 3200,
        transition: { type: 'crossfade', duration: 250 },
      },
    ],
  },
  // demo-6 — the full story: open a ticket, then really scroll its Details panel
  // (bottom orientation) down through details → tags → notes.
  6: {
    posterAtMs: 4300,
    frames: (url) => [
      {
        // HS-1 (mixed-shipping bug) is the content-rich ticket — long details +
        // a note — so #detail-body actually overflows and the scroll targets it
        // (a sparse ticket leaves nothing to scroll, so domotion falls back to
        // scrolling the whole window, which ghosts).
        input: url,
        waitFor: '.column-card[data-id="1"], .ticket-row[data-id="1"]',
        wait: 500,
        actions: [
          { type: 'click', selector: '.column-card[data-id="1"], .ticket-row[data-id="1"]' },
          { type: 'wait', ms: 800 },
        ],
        duration: 1400,
      },
      // domotion's `scroll` frame is built for scrolling a tall PAGE (it
      // translates the whole capture), which ghosts a fixed-viewport app whose
      // only scroller is a nested panel. So drive `#detail-body.scrollTop`
      // directly across continue-frames — only the panel content moves, the
      // chrome stays fixed. Short crossfades read as a paced scroll-through.
      {
        continue: true,
        waitFor: '#detail-body',
        actions: [{ type: 'evaluate', script: "document.getElementById('detail-body').scrollTop=130" }, { type: 'wait', ms: 150 }],
        duration: 750,
        transition: { type: 'crossfade', duration: 220 },
      },
      {
        continue: true,
        actions: [{ type: 'evaluate', script: "document.getElementById('detail-body').scrollTop=300" }, { type: 'wait', ms: 150 }],
        duration: 750,
        transition: { type: 'crossfade', duration: 220 },
      },
      {
        continue: true,
        actions: [{ type: 'evaluate', script: "var b=document.getElementById('detail-body'); b.scrollTop=b.scrollHeight" }, { type: 'wait', ms: 150 }],
        duration: 1500,
        transition: { type: 'crossfade', duration: 220 },
      },
    ],
  },
};

/**
 * Scenario 14 (Announcer) curated reel. The announcer's transcript PIP is gated
 * on an Anthropic key / on-device provider and is fed by an AI summarization
 * pass — neither is reproducible in a headless capture (no key in the temp
 * keychain, no Ollama/Apple helper guaranteed on the runner). So this demo
 * mocks the announcer read endpoints client-side (the same hermetic recipe
 * `e2e/announcer.spec.ts` uses) with a hand-authored reel: marketing-quality
 * entries, tier-1 `emphasis` phrases, and a tier-2 code-diff `visuals` pane on
 * the lead entry so the screenshot shows the richest PIP content. The board
 * behind it is the real seeded hero data (`SCENARIO_1`).
 */
const ANNOUNCER_ENTRIES = [
  {
    id: 301,
    created_at: '2026-06-20T09:14:00.000Z',
    covers_from: null,
    covers_to: null,
    title: 'Shipped the dark-mode toggle',
    script: 'While you were away, Claude finished the dark-mode toggle in the settings dialog — added the theme switch, wired the CSS custom properties, and the tests are green.',
    emphasis: ['dark-mode toggle', 'tests are green'],
    visuals: [{
      type: 'diff',
      oldStr: 'const theme = "light";',
      newStr: 'const theme = prefersDark() ? "dark" : "light";',
      filePath: 'src/client/settingsDialog.tsx',
      replaceAll: false,
    }],
    position: 0,
    dismissed: false,
  },
  {
    id: 302,
    created_at: '2026-06-20T09:21:00.000Z',
    covers_from: null,
    covers_to: null,
    title: 'Fixed the checkout shipping bug',
    script: 'Claude tracked down the mixed-shipping checkout failure to ShippingCalculator.consolidate and is now grouping items by method before merging the rates.',
    emphasis: ['mixed-shipping checkout failure'],
    visuals: [],
    position: 1,
    dismissed: false,
  },
  {
    id: 303,
    created_at: '2026-06-20T09:33:00.000Z',
    covers_from: null,
    covers_to: null,
    title: 'Database backups landed',
    script: 'Automated S3 database backups are configured with a 30-day retention policy, running nightly at 3 a.m. UTC.',
    emphasis: ['30-day retention policy'],
    visuals: [],
    position: 2,
    dismissed: false,
  },
];

/**
 * Per-scenario route mocks + init scripts that must be registered BEFORE
 * `page.goto` (so the announcer Listen button's visibility check sees the
 * mocked overview at init, and the TTS stub is installed before any playback).
 * Only scenario 14 uses this today.
 */
async function setupRoutesForScenario(page: Page, id: number): Promise<void> {
  if (id !== 14) return;
  const secret = 'demo-announcer';
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

  // Stub the Web Speech API so playback parks on the lead (diff-carrying) entry
  // instead of auto-advancing before the screenshot. The utterance is recorded
  // but `onend` never fires, so the player stays put.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: { speak: () => { /* noop */ }, cancel: () => { /* noop */ }, pause: () => { /* noop */ }, resume: () => { /* noop */ }, getVoices: () => [] },
    });
    if (typeof (window as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance === 'undefined') {
      (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class { constructor(public text: string) {} };
    }
  });

  await page.route('**/api/announcer/overview**', (route) => route.fulfill(json({
    activeSecret: secret,
    projects: [{ secret, name: 'Hot Sheet Web App', enabled: true, hasKey: true, entryCount: ANNOUNCER_ENTRIES.length }],
    appleAvailable: false,
    localAvailable: false,
  })));
  await page.route('**/api/announcer/status**', (route) => route.fulfill(json({
    enabled: true, hasKey: true, selectedKeyId: null, entryCount: ANNOUNCER_ENTRIES.length, lastListenedAt: null,
  })));
  // Generation is a no-op success — the reel comes from /entries.
  await page.route('**/api/announcer/generate**', (route) => route.fulfill(json({ entries: [], generated: 0 })));
  await page.route('**/api/announcer/entries**', (route) => route.fulfill(json({ entries: ANNOUNCER_ENTRIES })));
  await page.route('**/api/announcer/cursor**', (route) => route.fulfill(json({ ok: true })));
  await page.route('**/api/announcer/listened**', (route) => route.fulfill(json({ ok: true })));
  await page.route('**/api/announcer/dismiss/**', (route) => route.fulfill(json({ ok: true })));
}

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
  // HS-9003 — `force` bypasses actionability (interception) checks: a transient
  // `#network-error-popup` (see the init script) is a fixed overlay that can win
  // the 30 s click race even after we remove it, and the ticket row is a known,
  // visible target. Belt-and-braces with the MutationObserver popup-remover.
  await first.click({ force: true });
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
      await page.click('#sidebar-dashboard-widget', { force: true }); // HS-9003 — bypass a transient popup interceptor
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
      await page.click('#terminal-dashboard-toggle', { force: true }); // HS-9003 — bypass a transient popup interceptor
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
      // HS-9003 — `force` bypasses interception: a transient `#network-error-popup`
      // (a cross-project fetch aborting during load) intercepted this toggle click,
      // so navigation never happened and `.cross-project-stats-page` timed out.
      await page.click('#cross-project-stats-toggle', { force: true });
      // The page wrapper (`.cross-project-stats-page`) only appears after the
      // async `fetchAndRender` succeeds; on a fetch failure the container shows
      // `.telemetry-dashboard-error` instead. Wait for whichever lands, then
      // surface an error so a regression in the telemetry path doesn't ship a
      // broken (error-state) marketing shot silently.
      // HS-9003 — bumped 20s → 40s: the cross-project telemetry aggregation over
      // the seeded multi-project data is slow + variable and was landing right at
      // the old 20s edge (flaky). The page wrapper only mounts once fetchAndRender
      // resolves, so this waits for real data, not a spinner.
      await page.waitForSelector('.cross-project-stats-page, .telemetry-dashboard-error', { timeout: 40_000 });
      const errBox = await page.$('.telemetry-dashboard-error');
      if (errBox) {
        const detail = await page.locator('.telemetry-dashboard-error-detail').textContent().catch(() => '');
        throw new Error(`Cross-project stats rendered the error state: ${detail ?? '(no detail)'}`);
      }
      // Sections render asynchronously via fetchAndRender — let them paint.
      await page.waitForTimeout(1500);
      break;
    }
    case 14: {
      // Announcer demo. Pre-select a ticket so the board behind the PIP has a
      // populated detail panel, then click the header Listen button to open the
      // transcript PIP over the work. The announcer endpoints are mocked in
      // `setupRoutesForScenario` (the Listen button's visibility check reads the
      // mocked overview → `hasKey: true` → button shown). Clicking generates
      // (mocked no-op) then loads + plays the curated reel; the TTS stub parks
      // playback on the lead entry so the code-diff visual pane is on screen.
      await selectFirstTicket(page);
      await page.waitForSelector('#announcer-listen-btn', { state: 'visible', timeout: 10_000 });
      await page.click('#announcer-listen-btn');
      await page.waitForSelector('.announcer-pip', { state: 'visible', timeout: 5000 });
      // Let the reel load, the emphasis render, and the diff pane paint.
      await page.waitForTimeout(1200);
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

/** Run a `domotion` CLI verb, resolving on a clean exit. Async spawn (no sync
 *  child-process wedge risk — CLAUDE.md §"Synchronous child processes"); stderr
 *  is captured so a non-zero exit reports the domotion error. */
function runBin(bin: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const p = spawn(bin, args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr?.on('data', (c: Buffer) => { err += c.toString(); });
    p.stdout?.on('data', () => { /* drain */ });
    p.on('error', reject);
    p.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${bin} ${args[0] ?? ''} exited ${String(code)}: ${err.slice(-600)}`));
    });
  });
}
const runDomotion = (args: string[]): Promise<void> => runBin(DOMOTION_BIN, args);

/** A hero element's center as a fraction (0..1) of the app viewport, or null for
 *  a whole-window dolly. Computed in `captureScenario` from the resolved hero
 *  element's bounding box. */
interface Focus { fx: number; fy: number }

/**
 * HS-9003 — compose the captured app screen into a short DYNAMIC animated SVG at
 * `docs/demo-<id>.svg`. No title card: the clip opens directly on the UI. The
 * app is framed in a LIGHT macOS-window bezel (`wrapInDeviceChrome`), placed on
 * a transparent padded canvas, then a per-demo camera move plays while an
 * in-context lower-third `caption` fades in as the move settles:
 *   - 'dolly'  — a gentle whole-window push (origin = center).
 *   - 'focus'  — a stronger push toward the hero element (origin = its center),
 *                so the highlighted feature enlarges and leads the eye.
 * The window scales into the transparent margin, so nothing internal is clipped
 * (the fix for the orphaned-sidebar-numbers artifact an in-screen crop caused).
 * Everything is driven through the `domotion` CLI verbs (`template` / `composite`);
 * the pre-rendered app SVG rides through as an `svg` layer so its glyph paths
 * stay byte-identical. Renders both `docs/demo-<id>.svg` (README) and, when
 * `DEMO_MP4` is set, `docs/demo-<id>.mp4` (review).
 */
/** HS-9664 — the loop duration (ms) of a domotion-animated SVG, read from its
 *  root `animation: … Xs infinite` declaration. typeResample expands a frame past
 *  its declared `duration`, so the rendered SVG is the authority on total length. */
function readAnimatedDurationMs(svg: string): number {
  const m = /animation:\s*[\w-]+\s+([\d.]+)s/.exec(svg);
  return m !== null ? Math.round(parseFloat(m[1]) * 1000) : 6000;
}

/** HS-9664 — drive the live demo server through an interaction and frame the
 *  resulting ANIMATED app SVG in the same window chrome + caption as the camera
 *  demos, so a typing/clicking demo sits cohesively beside the zoom demos.
 *  `wrapInDeviceChrome` preserves the input SVG's `@keyframes` (verified), so the
 *  interaction plays inside a static bezel — no camera push (the interaction IS
 *  the motion). Renders `docs/demo-<id>.svg` + a PNG poster from the payoff frame. */
async function captureInteractionDemo(id: number, port: number, secret: string, spec: InteractionSpec): Promise<void> {
  const meta = DEMO_META[id];
  if (meta === undefined) throw new Error(`no DEMO_META for scenario ${String(id)}`);
  const tmp = mkdtempSync(join(tmpdir(), `hs-demo-int-${String(id)}-`));
  try {
    // 1. Drive the live app → animated app SVG. Prepend nudge-suppression to
    //    frame 0's actions so no modal intercepts the interaction.
    const frames = spec.frames(`http://localhost:${String(port)}/`, secret);
    const f0 = frames[0];
    const existing = Array.isArray(f0.actions) ? (f0.actions as AnimateFrame[]) : [];
    f0.actions = [{ type: 'evaluate', script: NUDGE_SUPPRESS }, ...existing];
    const interPath = join(tmp, 'interaction.svg');
    writeFileSync(join(tmp, 'animate.json'), JSON.stringify({
      width: VIEWPORT.width, height: VIEWPORT.height, output: interPath, cursor: 'auto', frames,
    }));
    await runDomotion(['animate', join(tmp, 'animate.json')]);
    const animatedApp = readFileSync(interPath, 'utf8');
    const totalMs = readAnimatedDurationMs(animatedApp);

    // 2. Window chrome around the animated capture (keyframes preserved).
    const framed = wrapInDeviceChrome(animatedApp, 'window', VIEWPORT.width, VIEWPORT.height, { theme: 'light', label: 'Hot Sheet Demo' });
    const { width: FW, height: FH } = framed;
    const windowPath = join(tmp, 'window.svg');
    writeFileSync(windowPath, framed.svg);
    const W = FW + PAD_X * 2;
    const H = FH + PAD_TOP + PAD_BOTTOM;

    // 3. Caption: fades in early, holds through the interaction, exits before the
    //    loop restarts (in + hold + out + start ≈ totalMs).
    const captionPath = join(tmp, 'caption.svg');
    const holdMs = Math.max(1200, totalMs - 1650);
    await runDomotion(['template', 'caption', '--text', meta.caption,
      '--position', meta.captionPosition ?? 'bottom-center', '--motion', 'slide',
      '--width', String(W), '--height', String(H), '--textColor', '#ffffff', '--bgOpacity', '0.82',
      '--inMs', '500', '--outMs', '450', '--holdMs', String(holdMs), '-o', captionPath]);

    // 4. Composite the animated window under the caption on a transparent canvas.
    const outPath = join(DOCS_DIR, `demo-${String(id)}.svg`);
    writeFileSync(join(tmp, 'composite.json'), JSON.stringify({
      width: W, height: H, background: 'transparent', output: outPath, duration: totalMs,
      layers: [
        { svg: windowPath, x: PAD_X, y: PAD_TOP, width: FW, height: FH },
        { svg: captionPath, x: 0, y: 0, width: W, height: H, start: 700 },
      ],
    }));
    await runDomotion(['composite', join(tmp, 'composite.json')]);

    // 5. PNG poster from the payoff frame (the interaction demos skip the static
    //    Playwright still, so rasterize the composited SVG instead).
    await runBin(SVG_TO_IMAGE_BIN, [outPath, '-o', join(DOCS_DIR, `demo-${String(id)}.png`), '--width', '1200', '--at', String(spec.posterAtMs)]);

    if (process.env.DEMO_MP4 !== undefined && process.env.DEMO_MP4 !== '') {
      await runBin(SVG_TO_VIDEO_BIN, [outPath, '-o', join(DOCS_DIR, `demo-${String(id)}.mp4`), '--width', '1200']);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** HS-9664 — a purple rounded-rect emphasis ring around `box`, injected into the
 *  app SVG just before `</svg>` (app-space coords, viewBox 0 0 W H). A soft wide
 *  translucent halo behind a crisp inner stroke reads as emphasis, not a border. */
function injectHighlightRect(appSvg: string, box: { x: number; y: number; width: number; height: number }): string {
  const P = 7;
  const x = (box.x - P).toFixed(1);
  const y = (box.y - P).toFixed(1);
  const w = (box.width + P * 2).toFixed(1);
  const h = (box.height + P * 2).toFixed(1);
  const ring =
    `<g>` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="13" ry="13" fill="none" stroke="#a855f7" stroke-opacity="0.28" stroke-width="12"/>` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="13" ry="13" fill="none" stroke="#8b5cf6" stroke-width="4"/>` +
    `</g>`;
  const i = appSvg.lastIndexOf('</svg>');
  return i === -1 ? appSvg : appSvg.slice(0, i) + ring + appSvg.slice(i);
}

async function buildDynamicDemo(id: number, appSvg: string, screenW: number, screenH: number, focus: Focus | null): Promise<void> {
  const meta = DEMO_META[id];
  if (meta === undefined) throw new Error(`no DEMO_META for scenario ${String(id)}`);
  const tmp = mkdtempSync(join(tmpdir(), `hs-demo-dyn-${String(id)}-`));
  try {
    // 1. Light window chrome around the app capture.
    const framed = wrapInDeviceChrome(appSvg, 'window', screenW, screenH, { theme: 'light', label: 'Hot Sheet Demo' });
    const { width: FW, height: FH } = framed;
    const windowPath = join(tmp, 'window.svg');
    writeFileSync(windowPath, framed.svg);

    // Padded transparent canvas the window grows into during the push.
    const W = FW + PAD_X * 2;
    const H = FH + PAD_TOP + PAD_BOTTOM;

    // 2. Camera move: a 'focus' push maps the hero's app-space center into the
    //    FRAMED layer's own box (the bezel adds a title bar above the screen, so
    //    y is offset by the chrome height); a 'dolly' pushes about the center.
    const useFocus = meta.verb === 'focus' && focus !== null;
    const chromeTop = FH - screenH; // title-bar / bezel height above the screen
    const originX = useFocus ? focus.fx * FW : FW / 2;
    const originY = useFocus ? chromeTop + focus.fy * screenH : FH / 2;
    const transformOrigin = useFocus ? `${((originX / FW) * 100).toFixed(1)}% ${((originY / FH) * 100).toFixed(1)}%` : 'center';
    const scaleTo = useFocus ? (meta.focusScale ?? FOCUS_SCALE) : DOLLY_SCALE;

    // 3. Lower-third caption, sized to the full canvas, fading in as the push
    //    settles (start = most of the way through the move).
    const captionPath = join(tmp, 'caption.svg');
    await runDomotion(['template', 'caption', '--text', meta.caption,
      '--position', meta.captionPosition ?? 'bottom-center',
      '--motion', 'slide', '--width', String(W), '--height', String(H),
      '--textColor', '#ffffff', '--bgOpacity', '0.82',
      '--inMs', '500', '--outMs', '450', '--holdMs', String(CAPTION_HOLD_MS),
      '-o', captionPath]);

    // 4. Composite: the framed window (with its camera-move animation) under the
    //    caption, on a transparent canvas.
    const outPath = join(DOCS_DIR, `demo-${String(id)}.svg`);
    const captionStart = MOVE_START_MS + MOVE_DUR_MS - 400;
    writeFileSync(join(tmp, 'composite.json'), JSON.stringify({
      width: W, height: H, background: 'transparent', output: outPath, duration: TOTAL_MS,
      layers: [
        { svg: windowPath, x: PAD_X, y: PAD_TOP, width: FW, height: FH,
          animations: [{ property: 'scale', from: 1, to: scaleTo, start: MOVE_START_MS, duration: MOVE_DUR_MS, easing: MOVE_EASE, transformOrigin }] },
        { svg: captionPath, x: 0, y: 0, width: W, height: H, start: captionStart },
      ],
    }));
    await runDomotion(['composite', join(tmp, 'composite.json')]);

    // Optional MP4 for review (DEMO_MP4=1).
    if (process.env.DEMO_MP4 !== undefined && process.env.DEMO_MP4 !== '') {
      await runBin(SVG_TO_VIDEO_BIN, [outPath, '-o', join(DOCS_DIR, `demo-${String(id)}.mp4`), '--width', '1200']);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

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
    // HS-9662 — force the in-process PTY factory for demo captures: the broker now
    // defaults ON, but a demo server never inits the broker (demo path), so its
    // terminals would fall back to in-process AND the broker-mode shutdown path
    // wouldn't kill them → leaked demo terminal processes per capture. `=0` keeps
    // captures on the plain in-process lifecycle (killed cleanly on server exit).
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, PLUGINS_ENABLED: 'false', HOTSHEET_PTY_BROKER: '0' },
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

    // HS-9664 — interaction demos drive the live server via domotion `animate`
    // (its own browser), so they skip the static Playwright capture + camera path.
    const interaction = INTERACTIONS[scenario.id];
    if (interaction !== undefined) {
      console.log(`  server ready, driving interaction...`);
      // The demo project's API secret (for demos that drive a mutation via fetch).
      let secret = '';
      try {
        const raw: unknown = JSON.parse(readFileSync(join(dataDir, 'secret.json'), 'utf8'));
        if (typeof raw === 'object' && raw !== null && 'secret' in raw && typeof raw.secret === 'string') secret = raw.secret;
      } catch { /* no secret file — non-mutating demos don't need it */ }
      await captureInteractionDemo(scenario.id, port, secret, interaction);
      console.log(`  ✓ SVG (interaction): ${join(DOCS_DIR, `demo-${scenario.id}.svg`)}`);
      return;
    }

    console.log(`  server ready, launching browser...`);

    const browser = await chromium.launch();
    const harPath = join(DOCS_DIR, `demo-${scenario.id}.har`);
    try {
      // HS-8688-follow-up — record every HTTP request + response (including
      // WebSocket upgrades) into a HAR file alongside the PNG + SVG. Useful
      // for debugging the demo replay (which long-polls fired, which API
      // routes timed out, what the cost-by-project payload actually looked
      // like). HAR files are written when the context closes, so the
      // explicit `context.close()` in the finally block below is load-bearing
      // — `browser.close()` alone would flush too, but being explicit avoids
      // a race if the close path changes. `content: 'embed'` (the default)
      // inlines response bodies as base64 so the HAR is replay-complete; OK
      // for the demo data sizes we work with (~MB per scenario). HAR files
      // are gitignored (see `.gitignore`) since they're large and easily
      // regeneratable.
      const context = await browser.newContext({
        viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
        recordHar: { path: harPath, content: 'embed' },
      });
      const page = await context.newPage();

      // HS-8367 — suppress the §50 upgrade-nudge overlay (otherwise it
      // covers the chrome on a fresh browser context).
      await page.addInitScript(() => {
        try {
          window.localStorage.setItem('hotsheet_upgrade_nudge_last_shown', String(Number.MAX_SAFE_INTEGER));
        } catch { /* private mode */ }
        // HS-9003 — suppress the §86 "Set Up Your AI Assistant" nudge dialog; it's
        // a modal that dims + covers the board mid-capture. The nudge exposes a
        // purpose-built pre-boot flag for exactly this (aiInstructionsNudge.tsx).
        (window as unknown as { __HOTSHEET_DISABLE_AI_NUDGE__?: boolean }).__HOTSHEET_DISABLE_AI_NUDGE__ = true;
      });
      // HS-9003 — a transient in-flight fetch aborting mid-capture pops the
      // HS-9455 "unable to reach the server" popup (`#network-error-popup`),
      // which is a fixed overlay that then intercepts every navigation click for
      // the rest of the capture (30 s click timeout → the whole scenario fails
      // intermittently). It's a capture artifact, not demo content, so remove
      // the node on sight for the duration of the shoot (a stylesheet rule alone
      // didn't stop Playwright from treating it as an interceptor).
      await page.addInitScript(() => {
        const kill = (): void => {
          document.getElementById('network-error-popup')?.remove();
          document.querySelectorAll('.ai-instructions-nudge-overlay').forEach((el) => el.remove());
        };
        const start = (): void => {
          kill();
          // Both overlays are appended DIRECTLY to <body> (api.tsx /
          // aiInstructionsNudge.tsx), so watch body's direct children only — NOT
          // `subtree`. A whole-document subtree observer fires `querySelectorAll`
          // on every deep mutation, which is O(n²) on the chart-heavy telemetry
          // page (demo 13) and made its render never settle within the timeout.
          new MutationObserver(kill).observe(document.body, { childList: true });
        };
        if (document.body) start();
        else document.addEventListener('DOMContentLoaded', start);
      });

      // Per-scenario route mocks / init scripts (announcer demo) must be wired
      // before the first navigation so the app sees them at init.
      await setupRoutesForScenario(page, scenario.id);

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

      // HS-9003 — for a 'focus' demo, resolve the hero element's center (as a
      // fraction of the viewport) so the camera pushes toward it. A missed
      // selector logs + falls back to a whole-window dolly (focus === null).
      const meta = DEMO_META[scenario.id];
      let focus: Focus | null = null;
      let heroBox: { x: number; y: number; width: number; height: number } | null = null;
      if (meta?.verb === 'focus' && meta.heroSelector !== undefined) {
        const box = await page.locator(meta.heroSelector).first().boundingBox().catch(() => null);
        if (box) {
          heroBox = box;
          focus = { fx: (box.x + box.width / 2) / VIEWPORT.width, fy: (box.y + box.height / 2) / VIEWPORT.height };
        } else {
          console.log(`  ⚠ hero selector "${meta.heroSelector}" did not resolve — falling back to dolly`);
        }
      }

      const tree = await captureElementTree(page, 'body', { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height });
      await embedRemoteImages(tree);
      // HS-8687 / domotion-svg 0.6.0: `elementTreeToSvg` returns a complete,
      // self-contained SVG document (outer `<svg xmlns viewBox …>` included).
      let appSvg = elementTreeToSvg(tree, VIEWPORT.width, VIEWPORT.height, { idPrefix: `demo-${scenario.id}-` });
      // HS-9664 — bake a purple emphasis ring around the hero (in app-space coords,
      // so it rides the camera push) when the demo asks for one.
      if (meta?.highlight === true && heroBox !== null) {
        appSvg = injectHighlightRect(appSvg, heroBox);
      }
      // HS-9003 — compose the bare app capture into a short DYNAMIC animated SVG
      // (no title card): opens on the UI, plays a per-demo camera move toward the
      // hero element (or a whole-window dolly), and fades in an in-context
      // caption. See `buildDynamicDemo`.
      await buildDynamicDemo(scenario.id, appSvg, VIEWPORT.width, VIEWPORT.height, focus);
      const svgPath = join(DOCS_DIR, `demo-${scenario.id}.svg`);
      console.log(`  ✓ SVG (dynamic): ${svgPath}`);
      // Explicitly close the context first so the HAR is flushed to disk
      // before `browser.close()` tears everything down — see comment on the
      // newContext call above.
      await context.close();
      console.log(`  ✓ HAR: ${harPath}`);
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
