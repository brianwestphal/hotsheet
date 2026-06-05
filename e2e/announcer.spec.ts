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
  { id: 101, created_at: '2026-06-05T00:00:00.000Z', covers_from: null, covers_to: null, title: 'Shipped the export feature', script: 'You finished the CSV export and wrote its tests.', position: 0, dismissed: false },
  { id: 102, created_at: '2026-06-05T00:05:00.000Z', covers_from: null, covers_to: null, title: 'Fixed the tag leak', script: 'Cross-project tag bleed is now resolved.', position: 1, dismissed: false },
];

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

  // Opted-in + key configured so the Listen button shows.
  await page.route('**/api/announcer/status**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ enabled: true, hasKey: true, entryCount: ENTRIES.length, lastListenedAt: null }),
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

  // PIP mounts and plays the first entry.
  const pip = page.locator('.announcer-pip');
  await expect(pip).toBeVisible({ timeout: 8000 });
  await expect(pip.locator('.announcer-pip-title')).toHaveText('Shipped the export feature');
  await expect(pip.locator('.announcer-pip-script')).toContainText('CSV export');
  await expect(pip.locator('.announcer-pip-position')).toHaveText('1 / 2');

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

  // Close → PIP tears down and the listened cursor advances.
  await pip.locator('.announcer-pip-close').click();
  await expect(pip).toHaveCount(0);
  await expect.poll(() => cursorAdvanced).toBe(true);
});
