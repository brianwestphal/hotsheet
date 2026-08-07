/**
 * HS-9586 — the CLIENT half of the codex-approval round trip: an option-driven
 * permission (ACP / codex) must render the agent's own options as buttons and send
 * the chosen `option_id` back.
 *
 * ## Why this spec exists
 *
 * The bug the user hit twice was not in the wire vocabulary — it was that the
 * browser never saw the options at all. `api/projects.ts::PermissionEntrySchema`
 * (the client's view of the `/projects/permissions` long-poll) didn't name
 * `options`, and zod strips what it doesn't name. The overlay therefore fell back
 * to the legacy two-icon Allow/Deny layout and responded WITHOUT an `option_id`,
 * which the respond route read as a dismissal. Clicking Allow told codex no.
 *
 * Every existing test sat on one side of that seam:
 *
 *  - `permission-popup.spec.ts` fabricates popup markup, so it can't observe what
 *    the real overlay would build from a real poll response.
 *  - `permission-popup-live.spec.ts` drives the real poll, but only with a legacy
 *    Claude/Bash permission that has no options — the exact case that still worked.
 *  - the server-side unit tests call `resolveAcpPermission({optionId})` directly,
 *    starting *after* the field went missing.
 *
 * So this spec stubs the poll with a genuine codex approval — options included, as
 * `routes/projects.ts` really sends it — and asserts on the POST body the real
 * client produces. It goes through the real typed caller (`pollProjectPermissions`
 * → zod → `showPermissionPopup`), which is the component that was dropping the
 * field, so a regression there fails here.
 *
 * The other half — that `{optionId:'allow'}` makes real codex actually run the
 * command — is `src/codexApprovalLive.test.ts`.
 */
import { expect, test } from './coverage-fixture.js';

type PermOption = { optionId: string; name: string; kind: string };
type FakePerm = {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview?: string;
  options?: PermOption[];
};
type RespondCall = { request_id: string; behavior: string; option_id: string | null };

declare global {
  interface Window {
    __HS9586_perm: FakePerm | null;
    __HS9586_secret: string;
    __HS9586_respondCalls: RespondCall[];
  }
}

/** A codex shell-command approval exactly as the server raises one (docs/121 §121.13):
 *  Hot Sheet's own choice ids, which `approvalResponseFromReply` translates to codex's
 *  wire tokens. `npm install motion` is the command from the bug report. */
// The preview is deliberately SHORT and single-line: a longer/multi-line one trips
// `shouldUseLiveCheckout`, which swaps the static `<pre>` for a borrowed live
// terminal. That path is HS-8171's and is covered by `permission-popup-live.spec.ts`;
// here it would only add an unrelated WebSocket dependency to a test about buttons.
const CODEX_APPROVAL: FakePerm = {
  request_id: 'acp-perm-9586',
  tool_name: 'Codex: Shell command',
  description: 'Codex wants to run a command that needs approval',
  input_preview: 'npm install motion',
  options: [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'allow_session', name: 'Allow for session', kind: 'allow_always' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
  ],
};

test.describe('Permission popup — option-driven approvals (HS-9586)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((perm) => {
      const w = window as unknown as Window;
      w.__HS9586_perm = perm;
      w.__HS9586_secret = 'fake-project-secret-codex';
      w.__HS9586_respondCalls = [];
    }, CODEX_APPROVAL);

    await page.route('**/api/channel/status*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ enabled: true, alive: true, port: 9999, done: false, versionMismatch: false, serverName: 'hotsheet-channel-test', aliveCount: 1 }),
      });
    });

    await page.route('**/api/projects/permissions*', async (route) => {
      const perm = await page.evaluate(() => (window as unknown as Window).__HS9586_perm);
      const secret = await page.evaluate(() => (window as unknown as Window).__HS9586_secret);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ permissions: { [secret]: perm }, v: 1 }),
      });
    });

    // Record the FULL respond payload — `option_id` is the field under test, and
    // recording it as `null` when absent distinguishes "sent nothing" (the bug)
    // from "sent the wrong id".
    await page.route('**/api/channel/permission/respond*', async (route) => {
      let payload: { request_id?: string; behavior?: string; option_id?: string } = {};
      try {
        const data = route.request().postData();
        if (data !== null && data !== '') {
          const parsed: unknown = JSON.parse(data);
          if (typeof parsed === 'object' && parsed !== null) payload = parsed;
        }
      } catch { /* ignore */ }
      await page.evaluate((p) => {
        (window as unknown as Window).__HS9586_respondCalls.push(p);
      }, {
        request_id: payload.request_id ?? '',
        behavior: payload.behavior ?? '',
        option_id: payload.option_id ?? null,
      });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('renders one button per agent-supplied option, not the legacy two icons', async ({ page }) => {
    const popup = page.locator('.permission-popup');
    await expect(popup).toBeVisible({ timeout: 5000 });

    // The presence of `.permission-popup-option` buttons IS the evidence that
    // `options` survived the client's schema parse — the legacy layout renders
    // `.permission-popup-allow` / `-deny` instead, which is what the bug produced.
    const options = popup.locator('.permission-popup-option');
    await expect(options).toHaveCount(3);
    await expect(options.nth(0)).toHaveText('Allow');
    await expect(options.nth(1)).toHaveText('Allow for session');
    await expect(options.nth(2)).toHaveText('Deny');
    await expect(popup.locator('.permission-popup-allow')).toHaveCount(0);

    await expect(popup.locator('.dialog-shell-tool')).toContainText('Codex');
    await expect(popup.locator('.permission-popup-preview')).toContainText('npm install motion');
  });

  // `dispatchEvent('click')` rather than `.click()` throughout, for the reason
  // `permission-popup-live.spec.ts` documents: with no project tabs in the fixture
  // DOM the popup's anchor positioning falls back to centered and can be clipped by
  // the viewport, which trips Playwright's actionability check on a button that is
  // functionally clickable.
  test('clicking Allow sends option_id "allow" — the regression', async ({ page }) => {
    const popup = page.locator('.permission-popup');
    await expect(popup).toBeVisible({ timeout: 5000 });
    await popup.locator('.permission-popup-option', { hasText: 'Allow' }).first().dispatchEvent('click');

    await expect.poll(
      async () => page.evaluate(() => (window as unknown as Window).__HS9586_respondCalls),
      { timeout: 5000 },
    ).toEqual([{ request_id: 'acp-perm-9586', behavior: 'allow', option_id: 'allow' }]);
  });

  test('clicking Allow for session sends its own id, not the plain allow', async ({ page }) => {
    const popup = page.locator('.permission-popup');
    await expect(popup).toBeVisible({ timeout: 5000 });
    await popup.locator('.permission-popup-option', { hasText: 'Allow for session' }).dispatchEvent('click');

    await expect.poll(
      async () => page.evaluate(() => (window as unknown as Window).__HS9586_respondCalls),
      { timeout: 5000 },
    ).toEqual([{ request_id: 'acp-perm-9586', behavior: 'allow', option_id: 'allow_session' }]);
  });

  test('clicking Deny sends option_id "deny" with behavior deny', async ({ page }) => {
    const popup = page.locator('.permission-popup');
    await expect(popup).toBeVisible({ timeout: 5000 });
    await popup.locator('.permission-popup-option', { hasText: 'Deny' }).dispatchEvent('click');

    await expect.poll(
      async () => page.evaluate(() => (window as unknown as Window).__HS9586_respondCalls),
      { timeout: 5000 },
    ).toEqual([{ request_id: 'acp-perm-9586', behavior: 'deny', option_id: 'deny' }]);
  });

  test('an agent with its own vocabulary round-trips ITS ids verbatim', async ({ page }) => {
    // ACP agents supply their own option ids (docs/114). The overlay must echo
    // whatever it was given rather than normalizing to codex's names.
    // Swap the fixture and RELOAD: mutating it under a mounted popup would queue
    // the new request behind the old one rather than replacing it (HS-8219), which
    // is correct product behavior but not what this test is about.
    await page.addInitScript(() => {
      const w = window as unknown as Window;
      w.__HS9586_perm = {
        request_id: 'acp-perm-opencode',
        tool_name: 'OpenCode: write',
        description: 'Write to a file',
        input_preview: 'src/foo.ts',
        options: [
          { optionId: 'proceed-once', name: 'Yes, once', kind: 'allow_once' },
          { optionId: 'refuse', name: 'No', kind: 'reject_once' },
        ],
      };
      w.__HS9586_respondCalls = [];
    });
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    const popup = page.locator('.permission-popup');
    await expect(popup.locator('.permission-popup-option', { hasText: 'Yes, once' })).toBeVisible({ timeout: 8000 });
    await popup.locator('.permission-popup-option', { hasText: 'Yes, once' }).dispatchEvent('click');

    await expect.poll(
      async () => page.evaluate(() => (window as unknown as Window).__HS9586_respondCalls),
      { timeout: 5000 },
    ).toEqual([{ request_id: 'acp-perm-opencode', behavior: 'allow', option_id: 'proceed-once' }]);
  });
});
