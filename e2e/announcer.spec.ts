/**
 * §78 Announcer (HS-8747) — end-to-end check of the Phase 1b client UX: the
 * header Listen button's visibility gate, the generate→play flow, the
 * transcript PIP, and its playback controls (next/prev/skip/close).
 *
 * The announcer routes are intercepted so the test is hermetic — it never
 * calls the real Anthropic API (generation) or the OS keychain (key storage),
 * and `window.speechSynthesis` is stubbed so playback is driven by the
 * controls deterministically rather than by real audio timing. The server
 * endpoints themselves are covered by the Phase 1a route/unit tests
 * (`src/routes/announcer.test.ts`); this spec is the only thing exercising the
 * real client wiring (button gate → PIP → controls → cursor advance).
 */
import { expect, test } from './coverage-fixture.js';

const ENTRIES = [
  { id: 101, created_at: '2026-06-05T00:00:00.000Z', covers_from: null, covers_to: null, title: 'Shipped the export feature', script: 'You finished the CSV export and wrote its tests.', emphasis: ['CSV export'], position: 0, dismissed: false },
  { id: 102, created_at: '2026-06-05T00:05:00.000Z', covers_from: null, covers_to: null, title: 'Fixed the tag leak', script: 'Cross-project tag bleed is now resolved.', position: 1, dismissed: false },
];

// HS-8803 — as the PIP advances, it marks each entry listened
// (`markAnnouncementListened`, best-effort, with the entry's project secret).
// Every test here mocks the announcer reads with a fake 'proj-a' secret, so an
// unmocked `/listened` POST hits the real temp server with that fake secret →
// 403 → a "Failed to load resource" console.error that trips the HS-8435
// strict-error gate (the cause of the v0.20.0-beta.1 e2e failures). Mock it
// once for every test; per-test routes registered later still take precedence
// for the endpoints they handle.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/announcer/listened**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }),
  }));
});

test('announcer Listen button → PIP playback controls (HS-8747)', async ({ page }) => {
  let cursorAdvanced = false;
  const dismissed: number[] = [];

  // Stub TTS so playback is control-driven, not audio-timed: utterances are
  // recorded but never auto-fire `onend`, so the player parks on the current
  // entry until a control moves it.
  await page.addInitScript(() => {
    const utterances: unknown[] = [];
    (window as unknown as { __ttsUtterances: unknown[] }).__ttsUtterances = utterances;
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: { speak: (u: unknown) => { utterances.push(u); }, cancel: () => { /* noop */ }, pause: () => { /* noop */ }, resume: () => { /* noop */ } },
    });
    if (typeof (window as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance === 'undefined') {
      (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class { constructor(public text: string) {} };
    }
  });

  // Opted-in + key configured so the Listen button shows. HS-8762 — the button
  // gate + default context come from the cross-project overview.
  await page.route('**/api/announcer/overview**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ activeSecret: 'proj-a', projects: [{ secret: 'proj-a', name: 'My Project', enabled: true, hasKey: true, entryCount: ENTRIES.length }] }),
  }));
  await page.route('**/api/announcer/status**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ enabled: true, hasKey: true, selectedKeyId: null, entryCount: ENTRIES.length, lastListenedAt: null }),
  }));
  // Generation is a no-op success — the reel comes from /entries.
  await page.route('**/api/announcer/generate**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ entries: [], generated: 0 }),
  }));
  await page.route('**/api/announcer/entries**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ entries: ENTRIES }),
  }));
  await page.route('**/api/announcer/cursor**', (route) => { cursorAdvanced = true; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }); });
  await page.route('**/api/announcer/dismiss/**', (route) => {
    const m = /dismiss\/(\d+)/.exec(route.request().url());
    if (m) dismissed.push(Number(m[1]));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.goto('/');
  await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

  // The button is hidden by default and revealed once the opted-in + has-key
  // status resolves.
  const listen = page.locator('#announcer-listen-btn');
  await expect(listen).toBeVisible({ timeout: 8000 });
  await listen.click();

  // HS-8753 — clicking gives immediate feedback (a toast) that the click
  // registered, even before generation resolves.
  await expect(page.locator('.hs-toast')).toContainText('Preparing your narration');

  // PIP mounts and plays the first entry.
  const pip = page.locator('.announcer-pip');
  await expect(pip).toBeVisible({ timeout: 8000 });
  await expect(pip.locator('.announcer-pip-title')).toHaveText('Shipped the export feature');
  await expect(pip.locator('.announcer-pip-script')).toContainText('CSV export');
  await expect(pip.locator('.announcer-pip-position')).toHaveText('1 / 2');

  // HS-8749 — tier-1 emphasis: the key phrase is wrapped in .announcer-em, and
  // the full script text is still intact.
  await expect(pip.locator('.announcer-pip-script .announcer-em')).toHaveText('CSV export');
  await expect(pip.locator('.announcer-pip-script')).toHaveText('You finished the CSV export and wrote its tests.');

  // HS-8749 — the expand (resize) toggle widens the panel and is remembered.
  const expandBtn = pip.locator('.announcer-pip-expand');
  await expect(expandBtn).toHaveAttribute('aria-pressed', 'false');
  await expandBtn.click();
  await expect(pip).toHaveClass(/is-expanded/);
  await expect(expandBtn).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.localStorage.getItem('hotsheet:announcer-pip-expanded'))).not.toBeNull();
  await expandBtn.click();
  await expect(pip).not.toHaveClass(/is-expanded/);
  expect(await page.evaluate(() => window.localStorage.getItem('hotsheet:announcer-pip-expanded'))).toBeNull();

  // Next → second entry.
  await pip.locator('.announcer-pip-next').click();
  await expect(pip.locator('.announcer-pip-title')).toHaveText('Fixed the tag leak');
  await expect(pip.locator('.announcer-pip-position')).toHaveText('2 / 2');

  // Prev → back to the first.
  await pip.locator('.announcer-pip-prev').click();
  await expect(pip.locator('.announcer-pip-title')).toHaveText('Shipped the export feature');

  // Skip → dismisses the current entry (id 101) and advances to what follows.
  await pip.locator('.announcer-pip-skip').click();
  await expect(pip.locator('.announcer-pip-title')).toHaveText('Fixed the tag leak');
  await expect(pip.locator('.announcer-pip-position')).toHaveText('1 / 1');
  await expect.poll(() => dismissed).toContain(101);

  // HS-8757 / HS-8827 — the X now HIDES the panel back into the button (which
  // glows) while playback continues; the PIP element stays mounted (just
  // display:none), and clicking the button again restores it (no regeneration).
  await pip.locator('.announcer-pip-close').click();
  await expect(pip).toBeHidden();
  await expect(listen).toHaveClass(/is-active/);
  await listen.click();
  await expect(pip).toBeVisible();
  await expect(listen).not.toHaveClass(/is-active/);

  // HS-8788 — clicking the button while the panel is VISIBLE minimizes it
  // (the button toggles the panel; playback continues either way).
  await listen.click();
  await expect(pip).toBeHidden();
  await expect(listen).toHaveClass(/is-active/);
  await listen.click(); // restore for the stop step below
  await expect(pip).toBeVisible();

  // HS-8827 — Stop (the explicit end-session button) tears the PIP down and
  // advances the listened cursor.
  await pip.locator('.announcer-pip-stop').click();
  await expect(pip).toHaveCount(0);
  await expect.poll(() => cursorAdvanced).toBe(true);
});

// HS-8756 — the PIP anchors near the Listen button on open and is draggable by
// its header, with the dragged position remembered across sessions.
test('announcer PIP is draggable and remembers its position (HS-8756)', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: { speak: () => { /* noop */ }, cancel: () => { /* noop */ }, pause: () => { /* noop */ }, resume: () => { /* noop */ } },
    });
    (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class { constructor(public text: string) {} };
  });
  await page.route('**/api/announcer/overview**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ activeSecret: 'proj-a', projects: [{ secret: 'proj-a', name: 'My Project', enabled: true, hasKey: true, entryCount: ENTRIES.length }] }),
  }));
  await page.route('**/api/announcer/generate**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries: [], generated: 0 }) }));
  await page.route('**/api/announcer/entries**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries: ENTRIES }) }));
  await page.route('**/api/announcer/cursor**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }));

  await page.goto('/');
  await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  await page.locator('#announcer-listen-btn').click();
  const pip = page.locator('.announcer-pip');
  await expect(pip).toBeVisible({ timeout: 8000 });

  // Drag the header to a known spot.
  const header = pip.locator('.announcer-pip-header');
  const box = await header.boundingBox();
  if (box === null) throw new Error('no header box');
  await page.mouse.move(box.x + 30, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 30 + 120, box.y + 10 + 90, { steps: 6 });
  await page.mouse.up();

  // Position is now driven by left/top (not the bottom-right default) and is
  // persisted to localStorage.
  const movedLeft = await pip.evaluate((el) => el.style.left);
  expect(movedLeft).not.toBe('');
  const stored = await page.evaluate(() => window.localStorage.getItem('hotsheet:announcer-pip-pos'));
  expect(stored).not.toBeNull();
});

// HS-8762 — the context dropdown: switching to "All Projects" aggregates every
// enabled project's entries, interleaved chronologically, each tagged with a
// project chip; dismiss targets the entry's own project.
test('announcer "All Projects" interleaves entries with project chips (HS-8762)', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: { speak: () => { /* noop */ }, cancel: () => { /* noop */ }, pause: () => { /* noop */ }, resume: () => { /* noop */ } },
    });
    (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class { constructor(public text: string) {} };
  });

  // Two enabled projects; Alpha is active.
  await page.route('**/api/announcer/overview**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ activeSecret: 'sec-a', projects: [
      { secret: 'sec-a', name: 'Alpha', enabled: true, hasKey: true, entryCount: 1 },
      { secret: 'sec-b', name: 'Beta', enabled: true, hasKey: true, entryCount: 1 },
    ] }),
  }));
  await page.route('**/api/announcer/generate**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries: [], generated: 0 }) }));
  // Entries differ per project — keyed off the X-Hotsheet-Secret header the
  // per-project caller sets. Beta's entry is older so it sorts first in "All".
  await page.route('**/api/announcer/entries**', (route) => {
    const secret = route.request().headers()['x-hotsheet-secret'];
    const entries = secret === 'sec-b'
      ? [{ id: 1, created_at: '2026-06-05T00:00:00.000Z', covers_from: null, covers_to: null, title: 'Beta work', script: 'Beta did things.', position: 0, dismissed: false }]
      : [{ id: 1, created_at: '2026-06-05T01:00:00.000Z', covers_from: null, covers_to: null, title: 'Alpha work', script: 'Alpha did things.', position: 0, dismissed: false }];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries }) });
  });
  await page.route('**/api/announcer/cursor**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }));

  await page.goto('/');
  await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  await page.locator('#announcer-listen-btn').click();
  const pip = page.locator('.announcer-pip');
  await expect(pip).toBeVisible({ timeout: 8000 });

  // Default context = the active project (Alpha): single entry, no chip.
  await expect(pip.locator('.announcer-pip-title')).toHaveText('Alpha work');
  await expect(pip.locator('.announcer-pip-position')).toHaveText('1 / 1');
  await expect(pip.locator('.announcer-pip-project-chip')).toBeHidden();

  // Switch to "All Projects": both entries, interleaved by time (Beta first),
  // each with its project chip.
  await pip.locator('.announcer-pip-context-select').selectOption('all');
  await expect(pip.locator('.announcer-pip-position')).toHaveText('1 / 2');
  await expect(pip.locator('.announcer-pip-title')).toHaveText('Beta work');
  await expect(pip.locator('.announcer-pip-project-chip')).toHaveText('Beta');
  await pip.locator('.announcer-pip-next').click();
  await expect(pip.locator('.announcer-pip-title')).toHaveText('Alpha work');
  await expect(pip.locator('.announcer-pip-project-chip')).toHaveText('Alpha');
});

// HS-8767 — live mode: the Live toggle registers a lease, shows the presence
// line, and tails newly-generated entries into the player.
test('announcer live mode tails new entries (HS-8767)', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: { speak: () => { /* noop */ }, cancel: () => { /* noop */ }, pause: () => { /* noop */ }, resume: () => { /* noop */ } },
    });
    (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class { constructor(public text: string) {} };
  });

  const liveCalls: boolean[] = [];
  // The generator's output grows over time; the live poll picks up the new one.
  let liveEntries = [
    { id: 1, created_at: '2026-06-05T00:00:00.000Z', covers_from: null, covers_to: null, title: 'First thing', script: 'a', position: 0, dismissed: false },
  ];

  await page.route('**/api/announcer/overview**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ activeSecret: 'proj-a', projects: [{ secret: 'proj-a', name: 'My Project', enabled: true, hasKey: true, entryCount: 1 }] }),
  }));
  await page.route('**/api/announcer/generate**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries: [], generated: 0 }) }));
  await page.route('**/api/announcer/entries**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries: liveEntries }) }));
  await page.route('**/api/announcer/live**', (route) => {
    liveCalls.push((route.request().postDataJSON() as { enabled: boolean }).enabled);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.route('**/api/announcer/cursor**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }));

  await page.goto('/');
  await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  await page.locator('#announcer-listen-btn').click();
  const pip = page.locator('.announcer-pip');
  await expect(pip).toBeVisible({ timeout: 8000 });
  await expect(pip.locator('.announcer-pip-position')).toHaveText('1 / 1');

  // Go live → accept the one-time spend/privacy disclosure (HS-8770) → registers
  // a lease, skip-to-live shows. (HS-8827 removed the idle/working presence line.)
  await pip.locator('.announcer-pip-live').click();
  await page.locator('.confirm-dialog-confirm').click();
  await expect(pip.locator('.announcer-pip-live')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => liveCalls).toContain(true);
  await expect(pip.locator('.announcer-pip-skip-live')).toBeVisible();

  // The generator produces a second entry → the live poll appends it.
  liveEntries = [
    ...liveEntries,
    { id: 2, created_at: '2026-06-05T00:01:00.000Z', covers_from: null, covers_to: null, title: 'Second thing', script: 'b', position: 1, dismissed: false },
  ];
  await expect(pip.locator('.announcer-pip-position')).toHaveText('1 / 2', { timeout: 8000 });

  // Stop live → drops the lease.
  await pip.locator('.announcer-pip-live').click();
  await expect(pip.locator('.announcer-pip-live')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => liveCalls).toContain(false);
});

// HS-8772 — tier-2 code-diff visual: an entry carrying a `visuals` diff renders
// the §47 diff preview inside the PIP body; an entry without one shows none.
test('announcer PIP renders a code-diff visual when the entry carries one (HS-8772)', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: { speak: () => { /* noop */ }, cancel: () => { /* noop */ }, pause: () => { /* noop */ }, resume: () => { /* noop */ } },
    });
    (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class { constructor(public text: string) {} };
  });
  await page.route('**/api/announcer/overview**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ activeSecret: 'proj-a', projects: [{ secret: 'proj-a', name: 'My Project', enabled: true, hasKey: true, entryCount: 2 }] }),
  }));
  await page.route('**/api/announcer/generate**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries: [], generated: 0 }) }));
  await page.route('**/api/announcer/entries**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ entries: [
      { id: 1, created_at: '2026-06-05T00:00:00.000Z', covers_from: null, covers_to: null, title: 'Refactored the parser', script: 'Tidied the token loop.', position: 0, dismissed: false,
        visuals: [{ type: 'diff', oldStr: 'let x = 1', newStr: 'const x = 1', filePath: 'src/a.ts', replaceAll: false }] },
      { id: 2, created_at: '2026-06-05T00:05:00.000Z', covers_from: null, covers_to: null, title: 'No visual here', script: 'Just a note.', position: 1, dismissed: false, visuals: [] },
    ] }),
  }));
  await page.route('**/api/announcer/cursor**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }));

  await page.goto('/');
  await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  await page.locator('#announcer-listen-btn').click();
  const pip = page.locator('.announcer-pip');
  await expect(pip).toBeVisible({ timeout: 8000 });

  // First entry has a diff → the visual pane shows the reused §47 diff preview
  // with the file-path header and the added line.
  const visual = pip.locator('.announcer-pip-visual');
  await expect(visual.locator('.edit-diff-preview')).toBeVisible();
  await expect(visual.locator('.edit-diff-path')).toContainText('src/a.ts');
  await expect(visual.locator('.edit-diff-line.edit-diff-add')).toContainText('const x = 1');

  // Next entry has no visual → the pane is hidden.
  await pip.locator('.announcer-pip-next').click();
  await expect(pip.locator('.announcer-pip-title')).toHaveText('No visual here');
  await expect(visual).toBeHidden();
});

// HS-8805 — a summarization failure (e.g. the on-device Apple FM helper exiting
// code 4) comes back as a soft `error` on a 200, NOT a 5xx. It must NOT trip the
// global "Connection Error" overlay (`#network-error-popup`) on dialog open; the
// existing reel still plays and a gentle toast explains the hiccup.
test('soft summarization error shows a gentle toast, not the Connection Error overlay (HS-8805)', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: { speak: () => { /* noop */ }, cancel: () => { /* noop */ }, pause: () => { /* noop */ }, resume: () => { /* noop */ } },
    });
    if (typeof (window as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance === 'undefined') {
      (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class { constructor(public text: string) {} };
    }
  });

  await page.route('**/api/announcer/overview**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ activeSecret: 'proj-a', projects: [{ secret: 'proj-a', name: 'My Project', enabled: true, hasKey: true, entryCount: 1 }] }),
  }));
  await page.route('**/api/announcer/status**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ enabled: true, hasKey: true, selectedKeyId: null, entryCount: 1, lastListenedAt: null }),
  }));
  // The generate call hiccupped: 200 with a soft `error` and no new entries.
  await page.route('**/api/announcer/generate**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ entries: [], generated: 0, error: 'Summarization failed: Apple Foundation Models helper exited with code 4' }),
  }));
  // The existing reel still loads and plays.
  await page.route('**/api/announcer/entries**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ entries: [
      { id: 1, created_at: '2026-06-05T00:00:00.000Z', covers_from: null, covers_to: null, title: 'Earlier work', script: 'Already here.', position: 0, dismissed: false, visuals: [] },
    ] }),
  }));
  await page.route('**/api/announcer/cursor**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }));

  await page.goto('/');
  await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  await page.locator('#announcer-listen-btn').click();

  // The gentle soft-error toast appears…
  await expect(page.locator('.hs-toast')).toContainText('generate new narration', { timeout: 8000 });
  // …and the existing reel still opens.
  await expect(page.locator('.announcer-pip')).toBeVisible({ timeout: 8000 });
  // The alarming global overlay must NOT appear.
  await expect(page.locator('#network-error-popup')).toHaveCount(0);
});

// HS-8804 — a PIP session that was open when the app last quit is restored on
// the next launch: same context, playback position, play/paused, and
// open/minimized state. Here a persisted session (visible, paused, on the 2nd
// entry) is seeded in localStorage and must come back on load without a click.
test('restores the playback session on launch (HS-8804)', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: { speak: () => { /* noop */ }, cancel: () => { /* noop */ }, pause: () => { /* noop */ }, resume: () => { /* noop */ } },
    });
    if (typeof (window as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance === 'undefined') {
      (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class { constructor(public text: string) {} };
    }
    // Seed a saved session: visible, paused, positioned on the 2nd entry (id 102).
    window.localStorage.setItem('hotsheet:announcer-session', JSON.stringify({
      context: 'proj-a', entryId: 102, entryProjectSecret: 'proj-a', playing: false, minimized: false,
    }));
  });

  await page.route('**/api/announcer/overview**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ activeSecret: 'proj-a', projects: [{ secret: 'proj-a', name: 'My Project', enabled: true, hasKey: true, entryCount: ENTRIES.length }] }),
  }));
  await page.route('**/api/announcer/status**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ enabled: true, hasKey: true, selectedKeyId: null, entryCount: ENTRIES.length, lastListenedAt: null }),
  }));
  await page.route('**/api/announcer/entries**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ entries: ENTRIES }),
  }));
  // Restore must NOT generate a fresh batch.
  let generateCalled = false;
  await page.route('**/api/announcer/generate**', (route) => { generateCalled = true; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries: [], generated: 0 }) }); });
  await page.route('**/api/announcer/cursor**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }));

  await page.goto('/');
  await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

  // The PIP comes back on its own, restored to the 2nd entry and paused.
  const pip = page.locator('.announcer-pip');
  await expect(pip).toBeVisible({ timeout: 8000 });
  await expect(pip.locator('.announcer-pip-title')).toHaveText('Fixed the tag leak');
  await expect(pip.locator('.announcer-pip-position')).toHaveText('2 / 2');
  await expect(pip).not.toHaveClass(/is-playing/);
  expect(generateCalled).toBe(false);
});

// HS-8798 — Settings → Announcer local-provider (§81) UI flow, fully
// network-mocked (no real Ollama). When the machine reports a reachable local
// OpenAI-compatible endpoint (`localAvailable: true` + a `localModels` list):
//   - the "Local model" option is selectable in `#settings-announcer-model`;
//   - selecting it reveals the local field (endpoint + model dropdown populated
//     from `localModels`) and hides the Anthropic-key field;
//   - the header Listen button shows for an enabled project with NO Anthropic key
//     (the on-device provider needs none).
// The real-server pass lives in docs/manual-test-plan.md §15.
const LOCAL_MODELS = ['llama3.1:8b', 'qwen2.5:7b'];

function stubAnnouncerTts(page: import('@playwright/test').Page): Promise<void> {
  return page.addInitScript(() => {
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: { speak: () => { /* noop */ }, cancel: () => { /* noop */ }, pause: () => { /* noop */ }, resume: () => { /* noop */ } },
    });
    if (typeof (window as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance === 'undefined') {
      (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class { constructor(public text: string) {} };
    }
  });
}

// HS-8854 — make the model-dropdown settings tests hermetic. They read
// `getGlobalConfig()` and the model `<select>`'s change handler writes
// `PATCH /global-config`. Left to hit the real (temp) server, selecting "Local
// model" persists `announcerModel: 'local'`, which leaks into later tests / the
// 2nd `--repeat-each` run (the dropdown then shows 'local' instead of the
// expected default haiku). Mock GET to a fixed empty config (all fields optional
// → the panel renders with defaults) and swallow PATCH so nothing persists. The
// regex matches `/api/global-config` exactly (with or without `?project=…`) and
// not the unrelated `/plugins/<id>/global-config` endpoints.
function hermeticGlobalConfig(page: import('@playwright/test').Page): Promise<void> {
  return page.route(/\/api\/global-config(\?|$)/, (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({}),
  }));
}

test('local-provider settings: model option + field toggle + Listen gate (HS-8798)', async ({ page }) => {
  await stubAnnouncerTts(page);
  await hermeticGlobalConfig(page);

  // Enabled project, NO Anthropic key, but a reachable local endpoint with models.
  await page.route('**/api/announcer/overview**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      activeSecret: 'proj-a',
      projects: [{ secret: 'proj-a', name: 'My Project', enabled: true, hasKey: false, entryCount: 0 }],
      appleAvailable: false, localAvailable: true,
    }),
  }));
  await page.route('**/api/announcer/status**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      enabled: true, hasKey: false, selectedKeyId: null, entryCount: 0, lastListenedAt: null,
      appleAvailable: false, localAvailable: true, localModels: LOCAL_MODELS,
    }),
  }));
  await page.route('**/api/announcer/entries**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ entries: [] }),
  }));

  await page.goto('/');
  await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

  // (3) Listen button shows for the enabled, keyless project because a local
  // provider is available.
  await expect(page.locator('#announcer-listen-btn')).toBeVisible({ timeout: 8000 });

  // Open Settings → Announcer tab.
  await page.locator('#settings-btn').click();
  await page.locator('.settings-tab[data-tab="announcer"]').click();
  await expect(page.locator('#settings-announcer-panel')).toBeVisible();

  // Wait for the settings panel's async `syncModel()` (config + status fetch) to
  // settle before interacting — the static select defaults to the first option
  // (Apple), and resolves to the cheapest Anthropic model when nothing is
  // configured + Apple is unavailable. Gating here avoids a late resolution
  // clobbering the manual selection below.
  const modelSelect = page.locator('#settings-announcer-model');
  await expect(modelSelect).toHaveValue('claude-haiku-4-5');

  // (1) The "Local model" option is present + NOT hidden when localAvailable.
  const localOption = modelSelect.locator('option[value="local"]');
  await expect(localOption).toHaveCount(1);
  await expect(localOption).toHaveJSProperty('hidden', false);

  // Default selection is an Anthropic model → key field shown, local field hidden.
  await expect(page.locator('#settings-announcer-key-field')).toBeVisible();
  await expect(page.locator('#settings-announcer-local-field')).toBeHidden();

  // (2) Selecting "Local model" reveals the local field + hides the key field.
  await modelSelect.selectOption('local');
  await expect(page.locator('#settings-announcer-local-field')).toBeVisible();
  await expect(page.locator('#settings-announcer-key-field')).toBeHidden();

  // The local-model dropdown is populated from the endpoint's reported models.
  const localModelSelect = page.locator('#settings-announcer-local-model');
  await expect(localModelSelect.locator('option')).toHaveText(LOCAL_MODELS);
  // The endpoint input is present for editing.
  await expect(page.locator('#settings-announcer-local-endpoint')).toBeVisible();
});

test('local-provider settings: "Local model" option hidden when unavailable (HS-8798)', async ({ page }) => {
  await stubAnnouncerTts(page);
  await hermeticGlobalConfig(page);

  await page.route('**/api/announcer/overview**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      activeSecret: 'proj-a',
      projects: [{ secret: 'proj-a', name: 'My Project', enabled: true, hasKey: false, entryCount: 0 }],
      appleAvailable: false, localAvailable: false,
    }),
  }));
  await page.route('**/api/announcer/status**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      enabled: true, hasKey: false, selectedKeyId: null, entryCount: 0, lastListenedAt: null,
      appleAvailable: false, localAvailable: false, localModels: [],
    }),
  }));
  await page.route('**/api/announcer/entries**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ entries: [] }),
  }));

  await page.goto('/');
  await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

  // No usable provider (no key, no on-device) → Listen button stays hidden.
  await expect(page.locator('#announcer-listen-btn')).toBeHidden();

  await page.locator('#settings-btn').click();
  await page.locator('.settings-tab[data-tab="announcer"]').click();
  await expect(page.locator('#settings-announcer-panel')).toBeVisible();

  // HS-8853 — the dropdown is now rebuilt from the discovered/available providers,
  // so the "Local model" option is omitted entirely when no local endpoint is
  // reachable (previously it was rendered with `hidden`).
  await expect(page.locator('#settings-announcer-model option[value="local"]')).toHaveCount(0);
  // The local field stays hidden.
  await expect(page.locator('#settings-announcer-local-field')).toBeHidden();
});
