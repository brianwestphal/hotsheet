import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';

// HS-9352 — repo root, for spawning the per-worker Hot Sheet server (src/cli.ts).
const E2E_REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// HS-9352 — the load-bearing startup banner (`src/server.ts`, pinned by
// launchReadinessContract.test.ts) prints the ACTUAL listening port. Parsing it
// lets each worker spawn on an OS-assigned ephemeral port (`--port 0`) instead of
// a fixed one — so there is NO possibility of a port collision (stale server from
// a prior run, a restarted worker, or two workers), which was the entire class of
// flakiness a fixed `4190+idx` scheme reintroduced.
const SERVER_BANNER = /Hot Sheet running at https?:\/\/localhost:(\d+)/;

/** HS-9352 — poll a spawned server's `/` until it answers 2xx (or reject). */
async function confirmServerReachable(baseURL: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseURL}/`);
      if (res.ok) return;
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`HS-9352 — e2e server at ${baseURL} not reachable in ${timeoutMs}ms (last error: ${String(lastErr)})`);
}

// HS-8367 — suppress the §50 / HS-7962 upgrade-nudge overlay in every
// e2e test by default. The nudge is a near-full-viewport modal that
// appears on app boot for npm-launched (non-Tauri) users, throttled via
// `localStorage['hotsheet_upgrade_nudge_last_shown']`. Without
// suppression it covers the `.draft-input`, `.ticket-row`, and detail
// panel — any test that drives the create-ticket / row-click flow on a
// fresh Playwright context (every test gets a fresh localStorage) hits
// the overlay and fails to interact with the underlying chrome. Pre-fix
// half the `tickets.spec.ts` suite (`click a ticket row`, `edit ticket
// title`, `toggle the up-next star`, etc.) was failing intermittently
// for this exact reason; the test that initially worked was the FIRST
// one after a context creation that happened to not trigger the boot
// nudge path. `Number.MAX_SAFE_INTEGER` is the "don't show again"
// sentinel per HS-7962's design — writing it pre-page-load suppresses
// the boot-time nudge without touching production code. Tests that
// specifically want to exercise the nudge UI can override by clearing
// the key in their own `beforeEach`.
const SUPPRESS_UPGRADE_NUDGE_SCRIPT = `
  try {
    window.localStorage.setItem('hotsheet_upgrade_nudge_last_shown', String(Number.MAX_SAFE_INTEGER));
  } catch { /* private mode etc. */ }
`;

// HS-8488 — force the DOM renderer for terminals in e2e. Headless Chromium
// ships SwiftShader WebGL2, so without this the WebGL renderer addon would
// load (HS-8488 makes it the default) and leave `.xterm-rows` unpopulated —
// breaking every terminal spec that scrapes that DOM (terminal text, OSC 8
// link hrefs, decoration glyphs — the last two have no buffer-read
// equivalent). `terminalWebgl.ts::shouldUseWebglRenderer` checks this flag
// first. Set via addInitScript so it lands before the app bundle runs.
const FORCE_DOM_TERMINAL_SCRIPT = `
  try { window.__HOTSHEET_DISABLE_WEBGL__ = true; } catch { /* noop */ }
`;

// HS-9066 — suppress the HS-8086 AI-instructions setup nudge (docs/86) in every
// e2e spec, the same way the upgrade nudge above is suppressed. On a fresh
// Playwright project the nudge's `decideNudgeAction` returns 'prompt' (the repo
// is a Claude project so `state.detected` is true, the temp project's CLAUDE.md
// has no managed sections, and it isn't dismissed), so `.ai-instructions-nudge-
// overlay` — a modal — mounts ASYNCHRONOUSLY after a status fetch and intercepts
// clicks on the underlying chrome. Because the timing varies it fails specs
// non-deterministically (it blocked `#settings-btn` / drawer deletes / the
// worklist-preamble fill in HS-9066's CI run). The dismissal is a server file-
// setting, not localStorage, so the upgrade-nudge trick doesn't transfer — gate
// it on a window flag read by `aiNudgeDisabledForTesting()`. Set via
// addInitScript so it lands before the app bundle runs. A nudge-specific spec
// can clear `window.__HOTSHEET_DISABLE_AI_NUDGE__` in its own beforeEach.
const SUPPRESS_AI_NUDGE_SCRIPT = `
  try { window.__HOTSHEET_DISABLE_AI_NUDGE__ = true; } catch { /* noop */ }
`;

// HS-8367 follow-up — server-persisted settings leak across specs because
// the Playwright `webServer` runs ONE Hot Sheet instance for the whole
// 375-test suite. If `columns.spec.ts` or `column-arrow-nav.spec.ts`
// leaves `layout: 'columns'` saved (the layout button click PATCHes
// /api/settings) and the next spec does `page.goto('/')` expecting list
// view, every `.ticket-row[data-id] .ticket-title-input[value="..."]`
// locator misses because column-view cards render `.column-card-title`
// instead. Same shape for `drawer_open: 'true'` — a terminal spec that
// opens the drawer can hide ticket rows behind the drawer for any
// subsequent spec that doesn't explicitly reset it. Reset both keys per-
// test so specs that need a non-default value PATCH it inside their own
// `beforeEach` / test body AFTER this fixture has run.
const RESET_SETTINGS_HEADERS = { 'Content-Type': 'application/json' };
async function resetCrossSpecSettings(request: import('@playwright/test').APIRequestContext): Promise<void> {
  let projects: { secret?: string }[] = [];
  try {
    projects = await (await request.get('/api/projects')).json() as { secret?: string }[];
  } catch { return; }
  const secret = projects[0]?.secret;
  if (secret === undefined || secret === '') return;
  const authHeaders = { ...RESET_SETTINGS_HEADERS, 'X-Hotsheet-Secret': secret };
  await Promise.allSettled([
    // `sortBy` + `sortDir` are server-persisted alongside layout/view, so a
    // prior spec that flipped to "Oldest First" parks newly-created tickets
    // off-viewport (with 350+ pre-existing rows accumulated across the
    // sweep) and `bindListVirtualized` doesn't mount them. The locator
    // resolves to nothing for the just-created ticket and the test times
    // out at the `.click()` call. Reset to the implicit defaults.
    // Settings stored as strings via /api/settings — booleans are read back
    // via `settings.detail_visible !== 'false'` in `settingsLoader.tsx`.
    // `detail_visible: 'false'` leaks from ui-gaps.spec.ts:144 (the
    // "toggle off" test) into every spec that opens the detail panel
    // (detail.spec.ts, ticket-lifecycle.spec.ts, unread-indicators.spec.ts).
    // `detail_position: 'bottom'` leaks from ui-gaps.spec.ts:115.
    request.patch('/api/settings', { headers: authHeaders, data: { layout: 'list', view: 'all', sortBy: 'created', sortDir: 'desc', detail_visible: 'true', detail_position: 'side' } }),
    // HS-8419 — `drawer_expanded: 'true'` leaks from drawer-expand.spec.ts:78
    // ("expanded state persists across reload"). When set, `.app.drawer-expanded`
    // applies `display: none` to `.app-body`, hiding the draft input + ticket
    // list for any later spec that does `page.goto('/')`.
    // HS-9349 — `auto_context: []` leaks from auto-context-defaults.spec.ts:19 (its
    // "clean slate" write to the SHARED layer, never reset), so any later spec that
    // asserts the shared auto-context state (settings-sharing.spec.ts) sees a stray `[]`
    // instead of a pristine one. Reset it here (shared-scope key → routed to settings.json).
    request.patch('/api/file-settings', { headers: authHeaders, data: { drawer_open: 'false', drawer_active_tab: 'commands-log', drawer_expanded: 'false', auto_context: [] } }),
    // HS-8419 — `dashboard.layoutMode` moved from per-project file-settings
    // to global config in HS-8290. `terminal-dashboard-flow-layout.spec.ts`
    // test 42 toggles flow mode and persists via the UI (which writes to
    // global-config), but its `afterEach` only resets via the dead
    // `dashboard_layout_mode` file-settings key. Result: flow mode leaks
    // across to terminal-dashboard.spec.ts:92 / :114, where the dashboard
    // renders `.terminal-dashboard-grid-flow` instead of the per-project
    // `.terminal-dashboard-section`s the tests expect to find. The
    // /global-config endpoint is cross-project; the mutation-without-Origin
    // CSRF gate in `server.ts` rejects with 403 unless we send the
    // project's `X-Hotsheet-Secret`, so reuse `authHeaders` even though the
    // request is logically project-agnostic.
    request.patch('/api/global-config', { headers: authHeaders, data: { dashboard: { layoutMode: 'sectioned' } } }),
  ]);

  // Wipe accumulated tickets so the per-test workload starts from an empty
  // DB. The single Playwright `webServer` persists ticket rows across all
  // 375 tests in a sweep, and once the count crosses
  // `bindListVirtualized`'s 100-row threshold, the viewport math drops
  // tickets that aren't in the rendered window — a `[value="..."]`
  // locator for a row past the window resolves to nothing and the test
  // times out. Specs that need a non-empty DB POST tickets in their own
  // `beforeAll` / test body AFTER this fixture runs.
  try {
    const allRes = await request.get('/api/tickets?status=active', { headers: authHeaders });
    if (allRes.ok()) {
      const active = await allRes.json() as { id: number }[];
      const trashRes = await request.get('/api/tickets?status=deleted', { headers: authHeaders });
      const trashed = trashRes.ok() ? await trashRes.json() as { id: number }[] : [];
      const ids = [...active.map(t => t.id), ...trashed.map(t => t.id)];
      if (ids.length > 0) {
        // batch action 'delete' moves to trash; then empty-trash hard-deletes.
        await request.post('/api/tickets/batch', { headers: authHeaders, data: { ids, action: 'delete' } });
        await request.post('/api/trash/empty', { headers: authHeaders });
      }
    }
  } catch { /* swallow — best-effort */ }

  // HS-8419 — destroy every DYNAMIC terminal config so dyn-* terminals
  // from `terminal.spec.ts` / drawer-terminal-grid.spec.ts don't
  // accumulate. Configured terminals from earlier specs' file-settings
  // PATCHes are NOT killed here — see HS-8419 comment in this file's
  // commit history; killing them during the fixture aborts xterm
  // WebSocket connections that the immediately-following test's
  // page.goto / drawer-open sequence races against, leaving the
  // drawer-expand button in a zero-height parent and timing out the
  // visibility check. Specs that need a clean configured-terminal slate
  // patch `terminals: [...]` in their own `beforeEach`.
  try {
    const listRes = await request.get('/api/terminal/list', { headers: authHeaders });
    if (listRes.ok()) {
      const list = await listRes.json() as { dynamic?: { id: string }[] };
      for (const d of (list.dynamic ?? [])) {
        await request.post('/api/terminal/destroy', { headers: authHeaders, data: { terminalId: d.id } }).catch(() => {});
      }
    }
  } catch { /* swallow — best-effort */ }
}

// HS-8435 — error-capture fixture. Prior to this, the entire e2e suite
// was blind to silent client-side failures: `playwright.config.ts` had
// no global error hook, this fixture had none either, and exactly ONE
// spec out of ~50 (`project-tab-reorder.spec.ts:331-332`) wired
// `page.on('console')` + `page.on('pageerror')` and even that one only
// appended to a debug array without asserting. The HS-8424 schema-drift
// bug was therefore invisible to every spec that ever ran against it —
// `persistedHiddenTerminals.ts::writeNow` swallowed the 400 in a
// `try { ... } catch { /* best-effort */ }` and Playwright never saw it.
//
// **Two-phase rollout (see HS-8435 details, completed in HS-8436).**
//
// - **Phase A (HS-8435, log-only):** captured findings without failing
//   the suite. Validated on a 31-test sample.
// - **Phase B (HS-8436, default = strict):** completed audit pass across
//   the full 281-test `npm run test:e2e:fast` suite, categorised every
//   finding (real bug → HS-8437 + per-test allowlist; legit per-test
//   scenarios → per-test allowlist with comments; ambient noise →
//   `GLOBAL_ERROR_ALLOWLIST`). Default is now FAIL-on-unexpected-event.
//   Set `STRICT_E2E_ERRORS=0` to opt out (local debugging only — CI
//   should always run with the default).
//
// **Global allowlist.** Ambient noise the entire suite should ignore
// regardless of spec. Add comments explaining each entry — otherwise
// future maintainers can't tell which entries are still load-bearing.
const GLOBAL_ERROR_ALLOWLIST: readonly (string | RegExp)[] = [
  // `/api/poll` long-poll requests get aborted on page unload / nav, which
  // surfaces in Playwright as a `response` event with status 0 in some
  // edge cases AND a `console.error` from the `fetch` rejection. The poll
  // helper already handles this — not a real failure.
  /\/api\/poll/,
  // Plugin sync 404s for projects that never had GitHub credentials
  // configured. Real installations gate the call; tests don't bother.
  /\/api\/plugins\/.+\/sync.*404/,
  // Playwright Chromium doesn't auto-grant clipboard permissions, so the
  // `navigator.clipboard.writeText(...)` fallback in `clipboard.ts`'s
  // copy path rejects in test envs. The production code path is correct
  // (the OS clipboard write succeeds when permission is granted, and
  // pasting in the test goes through the in-memory clipboard ring, not
  // the OS clipboard). Specs touching clipboard could request the
  // `clipboard-write` permission, but global-allowlisting is simpler and
  // matches the existing prior-art in `clipboard.spec.ts` where no test
  // ever asserts against the OS clipboard contents.
  /Failed to execute 'writeText' on 'Clipboard'/,
  // `longTaskObserver.tsx` deliberately uses `console.error` (see
  // HS-8054 comment at `src/client/longTaskObserver.tsx:237-245`) so the
  // developer can grep the `[hotsheet longtask]` prefix in the console
  // for slow-main-thread events. These are an observability signal, not
  // bugs — and e2e tests routinely trigger them (heavy mount paints,
  // dashboard scrolls, etc.). Allowing globally so the gate doesn't
  // surface them as failures; the developer console still shows them in
  // local runs.
  /\[hotsheet longtask\]/,
];

interface ErrorCaptureFixture {
  /** Allow specific error patterns (substring or regex) to pass through
   *  the assertion in Phase B for this single test. Add immediately at
   *  the top of the test body. No-op in Phase A. */
  allowErrors: (patterns: readonly (string | RegExp)[]) => void;
}

function matchesAllowlist(
  message: string,
  allowlist: readonly (string | RegExp)[],
): boolean {
  for (const p of allowlist) {
    if (typeof p === 'string' ? message.includes(p) : p.test(message)) return true;
  }
  return false;
}

// Collect browser JS coverage and write V8-format JSON for c8 to process.
// Rewrites the URL from HTTP to the local file path so c8 can find the source map.
export const test = base.extend<{
  autoJSCoverage: void;
  suppressUpgradeNudge: void;
  resetSettings: void;
  errorCapture: ErrorCaptureFixture;
}, {
  // HS-9352 — each Playwright worker gets its OWN isolated Hot Sheet server
  // (fresh data-dir + HOME, distinct port) so no single server is loaded by
  // the whole ~280-spec sweep. This removes the load-induced flaky tail (specs
  // missing fixed timeouts under a shared, event-loop-starved PGLite server)
  // and all cross-WORKER contamination. `baseURL` is worker-scoped so it
  // resolves in `beforeAll` hooks (37 no-terminal specs read `request` there).
  workerServer: { baseURL: string };
}>({
  // HS-9352 — spawn (and tear down) the per-worker server. Coverage path
  // (scripts/test-all.sh) sets NO_WEB_SERVER and runs its OWN single server on
  // 4190 with NODE_V8_COVERAGE, so there we DON'T spawn — just target 4190
  // (config forces workers:1 in that mode). Otherwise spawn on 4190+parallelIndex
  // (parallelIndex is 0..workers-1, stable across worker restarts — unlike
  // workerIndex — so ports never collide).
  workerServer: [async ({}, use) => {
    if (process.env.NO_WEB_SERVER !== undefined && process.env.NO_WEB_SERVER !== '') {
      await use({ baseURL: 'http://localhost:4190' });
      return;
    }
    const home = mkdtempSync(join(tmpdir(), 'hs-e2e-home-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'hs-e2e-data-'));
    // os.homedir() reads HOME on POSIX / USERPROFILE on Windows — set both so
    // the isolated home takes effect everywhere (mirrors scripts/e2e-server.mjs).
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PLUGINS_ENABLED: process.env.PLUGINS_ENABLED ?? 'true',
    };
    // `--port 0` → OS-assigned ephemeral port (no `--strict-port` needed: an
    // ephemeral bind never collides). The real port is read from the startup banner.
    const server = spawn(
      process.execPath,
      ['--import', 'tsx', join(E2E_REPO_ROOT, 'src', 'cli.ts'),
        '--data-dir', dataDir, '--no-open', '--port', '0'],
      { cwd: E2E_REPO_ROOT, env, stdio: 'pipe' },
    );
    // Buffer output: scan for the port banner during startup, keep a bounded tail
    // for crash diagnostics over the worker's lifetime.
    let serverLog = '';
    let port = 0;
    const onChunk = (d: Buffer): void => {
      serverLog = (serverLog + d.toString()).slice(-16_000);
      if (port === 0) {
        const m = SERVER_BANNER.exec(serverLog);
        if (m) port = Number(m[1]);
      }
    };
    server.stdout?.on('data', onChunk);
    server.stderr?.on('data', onChunk);
    // Wait for the banner (→ the server is listening) or an early exit.
    const deadline = Date.now() + 80_000;
    while (port === 0 && Date.now() < deadline) {
      if (server.exitCode !== null) {
        throw new Error(`HS-9352 — e2e server exited early (code ${String(server.exitCode)}) before listening\n--- server log (tail) ---\n${serverLog}`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    if (port === 0) {
      server.kill('SIGKILL');
      throw new Error(`HS-9352 — e2e server never printed its port banner in 80s\n--- server log (tail) ---\n${serverLog}`);
    }
    const baseURL = `http://localhost:${port}`;
    try {
      await confirmServerReachable(baseURL);
    } catch (e) {
      server.kill('SIGKILL');
      throw new Error(`${String(e)}\n--- server log (tail) ---\n${serverLog}`);
    }
    await use({ baseURL });
    // Teardown: SIGKILL for guaranteed, immediate port release. These are
    // ephemeral e2e servers with no state to flush, so a graceful SIGTERM (which
    // can hang the shutdown for seconds) buys nothing and risks a leaked server.
    await new Promise<void>((resolveClose) => {
      if (server.exitCode !== null) { resolveClose(); return; }
      server.once('exit', () => resolveClose());
      server.kill('SIGKILL');
      setTimeout(resolveClose, 3000);
    });
    // HS-9352 — 100s setup budget. Workers cold-start `node --import tsx` servers
    // concurrently (TS compile + PGLite init), so the last one up can take well past
    // the 30s test timeout — but it's a ONE-TIME per-worker cost amortized over ~140
    // specs, so a generous budget is cheap and prevents a slow cold-start from
    // false-failing the worker.
  }, { scope: 'worker', timeout: 100_000 }],
  // HS-9352 — point every consumer (`page`, `request`, `page.request`, and
  // worker-level `beforeAll` `request`) at this worker's server. `baseURL` is a
  // built-in option so it stays test-scoped, but it depends only on the
  // worker-scoped `workerServer`, so Playwright resolves it at worker granularity
  // (available in `beforeAll` too).
  baseURL: async ({ workerServer }, use) => {
    await use(workerServer.baseURL);
  },
  resetSettings: [async ({ request }, use) => {
    await resetCrossSpecSettings(request);
    await use();
  }, { auto: true }],
  suppressUpgradeNudge: [async ({ page }, use) => {
    await page.addInitScript(SUPPRESS_UPGRADE_NUDGE_SCRIPT);
    // HS-8488 — keep terminals on the DOM renderer so `.xterm-rows`-scraping
    // specs keep working under headless Chromium's SwiftShader WebGL2.
    await page.addInitScript(FORCE_DOM_TERMINAL_SCRIPT);
    // HS-9066 — keep the AI-instructions setup nudge from mounting mid-spec.
    await page.addInitScript(SUPPRESS_AI_NUDGE_SCRIPT);
    await use();
  }, { auto: true }],
  errorCapture: [async ({ page }, use, testInfo) => {
    const errors: string[] = [];
    const perTestAllowlist: (string | RegExp)[] = [];
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      errors.push(`[console.error] ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
      errors.push(`[pageerror] ${err.message}`);
    });
    page.on('response', (res) => {
      const status = res.status();
      if (status < 400) return;
      errors.push(`[response ${status}] ${res.request().method()} ${res.url()}`);
    });

    const fixture: ErrorCaptureFixture = {
      allowErrors: (patterns) => { perTestAllowlist.push(...patterns); },
    };
    await use(fixture);

    const unexpected = errors.filter(e =>
      !matchesAllowlist(e, GLOBAL_ERROR_ALLOWLIST) &&
      !matchesAllowlist(e, perTestAllowlist),
    );
    if (unexpected.length === 0) return;
    // Always attach so the audit pass can see what each spec produced.
    await testInfo.attach('hs-8435-unexpected-errors', {
      body: unexpected.join('\n'),
      contentType: 'text/plain',
    });
    if (process.env.STRICT_E2E_ERRORS === '0') {
      // HS-8436 opt-out (local debugging only) — log + attach without
      // failing. CI should never set this; use the strict default.
      // eslint-disable-next-line no-console
      console.warn(
        `[hs-8435 opt-out] ${testInfo.title}: ${unexpected.length} unexpected event(s) — ` +
        `STRICT_E2E_ERRORS=0 is masking these:\n  ` +
        unexpected.slice(0, 10).join('\n  '),
      );
      return;
    }
    // HS-8436 default — fail the test. Use a plain Error rather than
    // `expect` so the message survives any custom `expect` formatter and
    // the failure isn't hidden behind a diff-of-arrays render.
    throw new Error(
      `HS-8435 — ${unexpected.length} unexpected console/pageerror/4xx-5xx event(s) during this test ` +
      `(set STRICT_E2E_ERRORS=0 to disable the gate):\n  ` +
      unexpected.slice(0, 20).join('\n  ') +
      (unexpected.length > 20 ? `\n  …and ${unexpected.length - 20} more.` : ''),
    );
  }, { auto: true }],
  autoJSCoverage: [async ({ page }, use) => {
    const coverageDir = process.env.BROWSER_V8_COVERAGE;
    if (!coverageDir) {
      await use();
      return;
    }
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await use();
    const coverage = await page.coverage.stopJSCoverage();
    // The app bundle is served as /static/app.js but lives at dist/client/app.global.js
    const appEntries = coverage.filter(e => e.url.includes('/static/app.js'));
    if (appEntries.length > 0) {
      mkdirSync(coverageDir, { recursive: true });
      // Rewrite URL to local file path so c8 can resolve the source map
      const localPath = resolve('dist/client/app.global.js');
      const rewritten = appEntries.map(entry => ({
        ...entry,
        url: `file://${localPath}`,
      }));
      const v8Data = { result: rewritten };
      const filename = `browser-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
      writeFileSync(join(coverageDir, filename), JSON.stringify(v8Data));
    }
  }, { auto: true }],
});

export { expect } from '@playwright/test';
