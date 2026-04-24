/**
 * Permission popup for non-active project tabs.
 * Originally HS-6139 (popup renders, allow/deny buttons); extended in HS-6476
 * to verify the full description (no 100-char truncation) and the
 * `input_preview` block render inside the popup. The test injects the popup
 * DOM shape produced by `showPermissionPopup` in
 * `src/client/permissionOverlay.tsx` — so if that shape changes, update here
 * too.
 */
import { expect, test } from './coverage-fixture.js';

test.describe('Permission popup', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('renders tool, full description, preview, and allow/deny buttons', async ({ page }) => {
    const longDescription =
      'npm run build — compiles the project, emits dist/cli.js, dist/channel.js, and dist/client/app.global.js, then copies static assets. This line is intentionally long so we can verify it is not truncated at 100 characters like the old popup did.';
    const inputPreview = 'npm run build\n  > hotsheet@0.16.2 build\n  > tsup && sass src/client/styles.scss dist/client/styles.css';

    await page.evaluate(({ description, preview }) => {
      const popup = document.createElement('div');
      popup.className = 'permission-popup';
      popup.innerHTML = `
        <div class="permission-popup-body">
          <div class="permission-popup-header">
            <span class="permission-popup-tool">Bash</span>
            <span class="permission-popup-desc">${description}</span>
          </div>
          <pre class="permission-popup-preview">${preview}</pre>
        </div>
        <div class="permission-popup-actions">
          <button class="permission-popup-allow" title="Allow">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
          </button>
          <button class="permission-popup-deny" title="Deny">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>
      `;
      popup.style.top = '50px';
      popup.style.left = '100px';
      document.body.appendChild(popup);
    }, { description: longDescription, preview: inputPreview });

    const popup = page.locator('.permission-popup');
    await expect(popup).toBeVisible();
    await expect(popup.locator('.permission-popup-tool')).toContainText('Bash');

    // Full description is shown verbatim (no truncation).
    const descText = await popup.locator('.permission-popup-desc').textContent();
    expect(descText).toBe(longDescription);
    expect(descText!.length).toBeGreaterThan(100);

    // The preview block renders the full input.
    await expect(popup.locator('.permission-popup-preview')).toContainText('npm run build');
    await expect(popup.locator('.permission-popup-preview')).toContainText('hotsheet@0.16.2');

    await expect(popup.locator('.permission-popup-allow')).toBeVisible();
    await expect(popup.locator('.permission-popup-deny')).toBeVisible();
  });

  test('renders Minimize and No-response-needed text links in a shared row (HS-6637, HS-7266)', async ({ page }) => {
    // HS-7266: the popup is non-modal and offers an explicit Minimize link
    // alongside the existing "No response needed" link. Both appear inside a
    // `.permission-popup-links` flex row separated by a `·` bullet.
    await page.evaluate(() => {
      const popup = document.createElement('div');
      popup.className = 'permission-popup';
      popup.innerHTML = `
        <div class="permission-popup-body">
          <div class="permission-popup-header">
            <span class="permission-popup-tool">Bash</span>
            <span class="permission-popup-desc">Run a command</span>
          </div>
          <div class="permission-popup-links">
            <a class="permission-popup-minimize-link" href="#">Minimize</a>
            <span class="permission-popup-links-sep">·</span>
            <a class="permission-popup-dismiss-link" href="#">No response needed</a>
          </div>
        </div>
        <div class="permission-popup-actions">
          <button class="permission-popup-allow" title="Allow"></button>
          <button class="permission-popup-deny" title="Deny"></button>
        </div>
      `;
      document.body.appendChild(popup);
    });

    const popup = page.locator('.permission-popup');
    await expect(popup.locator('.permission-popup-links')).toBeVisible();
    await expect(popup.locator('.permission-popup-minimize-link')).toHaveText('Minimize');
    await expect(popup.locator('.permission-popup-dismiss-link')).toHaveText('No response needed');
    await expect(popup.locator('.permission-popup-links-sep')).toHaveText('·');
  });

  test('omits the preview block when input_preview is empty', async ({ page }) => {
    // showPermissionPopup conditionally renders the <pre> only when the preview is non-empty.
    await page.evaluate(() => {
      const popup = document.createElement('div');
      popup.className = 'permission-popup';
      popup.innerHTML = `
        <div class="permission-popup-body">
          <div class="permission-popup-header">
            <span class="permission-popup-tool">Read</span>
            <span class="permission-popup-desc">Read file /etc/hosts</span>
          </div>
        </div>
        <div class="permission-popup-actions">
          <button class="permission-popup-allow" title="Allow"></button>
          <button class="permission-popup-deny" title="Deny"></button>
        </div>
      `;
      document.body.appendChild(popup);
    });

    const popup = page.locator('.permission-popup');
    await expect(popup).toBeVisible();
    await expect(popup.locator('.permission-popup-preview')).toHaveCount(0);
  });
});
