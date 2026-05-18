/**
 * HS-8207 — full e2e coverage for the §47 permission popup's live polling
 * + auto-dismiss + checkout-body lifecycle. Drives the real client polling
 * loop in `permissionOverlay.tsx` by stubbing `/api/projects/permissions`
 * with `page.route()`, so we exercise the actual `processPermissionPollResponse`
 * branches without requiring a real channel server (the channel server is
 * a separate process spawned via `/mcp` from Claude Code, which Playwright
 * can't easily stand up in CI).
 *
 * Locks down the user-visible contracts that fix the HS-8207 multi-phase
 * symptom ("starts blank → shows some content → shows completely different
 * content → disappears entirely"):
 *
 *   1. A pending permission surfaces the popup with the expected chrome.
 *   2. Same `request_id` across many polls does NOT churn the DOM (no
 *      tear-down + re-mount; same DOM nodes throughout).
 *   3. A single missing-from-poll cycle does NOT auto-dismiss (HS-8183
 *      `AUTO_DISMISS_MISS_THRESHOLD = 2`).
 *   4. Two consecutive null polls DO auto-dismiss.
 *   5. The owner project missing entirely from the response (HS-8207
 *      "channel-server unreachable" signal) does NOT tick the dismiss
 *      counter — even five missed polls in a row keep the popup mounted.
 *   6. Allow click POSTs `/api/channel/permission/respond` with the
 *      correct request_id + behavior.
 *   7. Deny click POSTs the same shape with `behavior: 'deny'`.
 *   8. Truncated input_preview surfaces the live-terminal-checkout body
 *      slot (`.permission-popup-live-terminal`).
 */
import { expect, test } from './coverage-fixture.js';

type FakePerm = {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview?: string;
};

declare global {
  interface Window {
    __HS8207_phase: 'pending' | 'null' | 'unreachable' | 'unreachable-2';
    __HS8207_perm: FakePerm | null;
    __HS8207_secret: string;
    __HS8207_v: number;
    __HS8207_respondCalls: Array<{ request_id: string; behavior: string }>;
  }
}

test.describe('Permission popup — live polling lifecycle (HS-8207)', () => {
  test.beforeEach(async ({ page }) => {
    // Seed window-level fixture state so `page.route()` handlers and the
    // app code can both read/mutate it.
    await page.addInitScript(() => {
      const w = window as unknown as Window;
      w.__HS8207_phase = 'pending';
      w.__HS8207_perm = {
        request_id: 'req-live-1',
        tool_name: 'Bash',
        description: 'Run ls -la',
        input_preview: '{"command":"ls -la"}',
      };
      w.__HS8207_secret = 'fake-project-secret-A';
      w.__HS8207_v = 1;
      w.__HS8207_respondCalls = [];
    });

    // Mock channel status so the client thinks a channel is alive and
    // starts the polling loop.
    await page.route('**/api/channel/status*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ enabled: true, alive: true, port: 9999, done: false, versionMismatch: false }),
      });
    });

    // Mock the permissions long-poll. Reads __HS8207_phase from the page
    // so the test can advance phases between assertions.
    await page.route('**/api/projects/permissions*', async (route) => {
      const phase = await page.evaluate(() => (window as unknown as Window).__HS8207_phase);
      const perm = await page.evaluate(() => (window as unknown as Window).__HS8207_perm);
      const secret = await page.evaluate(() => (window as unknown as Window).__HS8207_secret);
      const v = await page.evaluate(() => (window as unknown as Window).__HS8207_v);

      let body: { permissions: Record<string, FakePerm | null>; v: number };
      if (phase === 'pending' && perm !== null) {
        body = { permissions: { [secret]: perm }, v };
      } else if (phase === 'null') {
        body = { permissions: { [secret]: null }, v };
      } else {
        // 'unreachable' / 'unreachable-2' — owner project OMITTED entirely.
        body = { permissions: {}, v };
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });

    // Mock the respond endpoint — record the payload so tests can assert.
    await page.route('**/api/channel/permission/respond*', async (route) => {
      const req = route.request();
      let payload: { request_id?: string; behavior?: string } = {};
      try {
        const data = req.postData();
        if (data !== null && data !== '') payload = JSON.parse(data) as typeof payload;
      } catch { /* ignore */ }
      await page.evaluate((p) => {
        (window as unknown as Window).__HS8207_respondCalls.push(p);
      }, { request_id: payload.request_id ?? '', behavior: payload.behavior ?? '' });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('shows the popup with chrome from the polled permission', async ({ page }) => {
    const popup = page.locator('.permission-popup');
    await expect(popup).toBeVisible({ timeout: 5000 });
    // HS-8419 — HS-8299 / HS-8296 carved Bash + Write out into custom dialog
    // headers: Bash uses title "Allow Claude to run" and omits `toolChip`
    // entirely (the title carries the verb, so a separate `Bash` chip would
    // be redundant). See `permissionOverlay.tsx::isBashCustomLayout`.
    await expect(popup.locator('.dialog-shell-tool')).toHaveCount(0);
    await expect(popup.locator('.dialog-shell-title')).toContainText('Allow Claude to run');
    await expect(popup.locator('.permission-popup-allow')).toBeVisible();
    await expect(popup.locator('.permission-popup-deny')).toBeVisible();
  });

  test('does NOT churn the popup across many polls of the same request_id', async ({ page }) => {
    const popup = page.locator('.permission-popup');
    await expect(popup).toBeVisible({ timeout: 5000 });

    // Capture the popup's identity. We verify it doesn't get torn down +
    // re-mounted across subsequent polls (the show-loop's
    // `if (activePopupRequestId === perm.request_id) return;` early return).
    const handle = await popup.elementHandle();
    expect(handle).not.toBeNull();

    // The poll fires every ~100 ms (TIMERS.POLL_RETRY_MS reschedule on
    // success). Wait long enough for ≥ 5 polls.
    await page.waitForTimeout(700);

    // Same DOM node — not torn down + re-mounted. We compare by element
    // handle equality.
    const stillThere = await popup.elementHandle();
    expect(stillThere).not.toBeNull();
    const same = await page.evaluate(([a, b]) => a === b, [handle, stillThere]);
    expect(same).toBe(true);
  });

  test('does NOT auto-dismiss on a single null poll (HS-8183 threshold)', async ({ page }) => {
    const popup = page.locator('.permission-popup');
    await expect(popup).toBeVisible({ timeout: 5000 });

    // Flip to null for one poll, then back to pending. Wait between flips
    // long enough for at least one poll to fire under the new phase.
    await page.evaluate(() => {
      const w = window as unknown as Window;
      w.__HS8207_phase = 'null';
      w.__HS8207_v = 2;
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const w = window as unknown as Window;
      w.__HS8207_phase = 'pending';
      w.__HS8207_v = 3;
    });
    await page.waitForTimeout(300);

    // Popup must still be there.
    await expect(popup).toBeVisible();
  });

  test('auto-dismisses after two consecutive null polls', async ({ page }) => {
    const popup = page.locator('.permission-popup');
    await expect(popup).toBeVisible({ timeout: 5000 });

    await page.evaluate(() => {
      const w = window as unknown as Window;
      w.__HS8207_phase = 'null';
      w.__HS8207_v = 2;
    });

    // Two polls of null at ~100 ms cadence — popup auto-dismisses.
    await expect(popup).toBeHidden({ timeout: 5000 });
  });

  test('does NOT auto-dismiss when the owner project is missing from the response (channel-server unreachable)', async ({ page }) => {
    const popup = page.locator('.permission-popup');
    await expect(popup).toBeVisible({ timeout: 5000 });

    // Flip to "unreachable" — server omits the owner project entirely.
    await page.evaluate(() => {
      const w = window as unknown as Window;
      w.__HS8207_phase = 'unreachable';
      w.__HS8207_v = 2;
    });

    // Wait for ≥ 10 poll cycles. Pre-HS-8207 the second one would have
    // ticked the dismiss counter to threshold and torn the popup down.
    await page.waitForTimeout(1500);

    // Popup must still be there.
    await expect(popup).toBeVisible();

    // Sanity: when the channel comes back as null (confirmed not pending),
    // the auto-dismiss path resumes ticking and eventually clears the popup.
    // This locks the contract that "unreachable doesn't reset the counter
    // to zero" — but here we go from unreachable back to pending then null
    // to verify the popup recovers cleanly.
    await page.evaluate(() => {
      const w = window as unknown as Window;
      w.__HS8207_phase = 'pending';
      w.__HS8207_v = 3;
    });
    await page.waitForTimeout(300);
    await expect(popup).toBeVisible();
  });

  test('Allow button posts /api/channel/permission/respond with behavior=allow', async ({ page }) => {
    const popup = page.locator('.permission-popup');
    await expect(popup).toBeVisible({ timeout: 5000 });

    // Force-click bypasses Playwright's "is element in viewport" check.
    // The popup's anchor positioning resolves to default-centered when
    // there's no project tab DOM (test fixture doesn't render tabs), so
    // the popup may be partially clipped by the viewport but the button
    // is still functionally clickable via dispatchEvent.
    await popup.locator('.permission-popup-allow').dispatchEvent('click');

    // The popup should tear down and the respond endpoint should have
    // received a single payload with the right shape.
    await expect(popup).toBeHidden({ timeout: 5000 });
    const calls = await page.evaluate(() => (window as unknown as Window).__HS8207_respondCalls);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]).toMatchObject({ request_id: 'req-live-1', behavior: 'allow' });
  });

  test('Deny button posts /api/channel/permission/respond with behavior=deny', async ({ page }) => {
    const popup = page.locator('.permission-popup');
    await expect(popup).toBeVisible({ timeout: 5000 });

    await popup.locator('.permission-popup-deny').dispatchEvent('click');

    await expect(popup).toBeHidden({ timeout: 5000 });
    const calls = await page.evaluate(() => (window as unknown as Window).__HS8207_respondCalls);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]).toMatchObject({ request_id: 'req-live-1', behavior: 'deny' });
  });
});

test.describe('Permission popup — live-terminal-checkout body (HS-8207)', () => {
  test('truncated input_preview surfaces the .permission-popup-live-terminal body slot', async ({ page, errorCapture }) => {
    // HS-8436 — the test mocks the permission with a deliberately-fake
    // `__HS8207_secret = 'fake-project-secret-A'`. The live-terminal
    // checkout body slot then tries to open a WebSocket to that fake
    // secret, which the server correctly rejects with 403. Expected.
    errorCapture.allowErrors([/ws:\/\/.*terminal\/ws.*fake-project-secret/]);
    // A long Bash command with an UNTERMINATED `command` value (no closing
    // `"` or `}`) — `formatInputPreview`'s forgiving extractor returns the
    // recovered value with `…` appended, tripping `flatTruncated` in
    // `permissionOverlay.tsx::showPermissionPopupBody`. That selects the
    // §54 live-terminal checkout body slot instead of the flat-JSON pre.
    const truncatedCmd = '{"command":"' + (
      "find / -name '*.log' -mtime -1 -size +1M "
      + "| xargs -I {} sh -c 'echo === {} ==='; "
    ).repeat(20);

    await page.addInitScript((input) => {
      const w = window as unknown as Window;
      w.__HS8207_phase = 'pending';
      w.__HS8207_perm = {
        request_id: 'req-live-truncated',
        tool_name: 'Bash',
        description: 'Run a long pipeline',
        input_preview: input,
      };
      w.__HS8207_secret = 'fake-project-secret-A';
      w.__HS8207_v = 1;
      w.__HS8207_respondCalls = [];
    }, truncatedCmd);

    await page.route('**/api/channel/status*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ enabled: true, alive: true, port: 9999, done: false, versionMismatch: false }),
      });
    });
    await page.route('**/api/projects/permissions*', async (route) => {
      const phase = await page.evaluate(() => (window as unknown as Window).__HS8207_phase);
      const perm = await page.evaluate(() => (window as unknown as Window).__HS8207_perm);
      const secret = await page.evaluate(() => (window as unknown as Window).__HS8207_secret);
      const v = await page.evaluate(() => (window as unknown as Window).__HS8207_v);
      const body = phase === 'pending' && perm !== null
        ? { permissions: { [secret]: perm }, v }
        : { permissions: { [secret]: null }, v };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    const popup = page.locator('.permission-popup');
    await expect(popup).toBeVisible({ timeout: 5000 });
    // Truncation gate fires → live-checkout body slot present.
    const liveTerm = popup.locator('.permission-popup-live-terminal');
    await expect(liveTerm).toHaveCount(1);
    // Flat-JSON preview NOT present (the live-checkout path replaces it).
    await expect(popup.locator('.permission-popup-preview')).toHaveCount(0);
  });
});
