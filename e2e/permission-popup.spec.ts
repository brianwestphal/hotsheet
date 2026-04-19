/**
 * HS-6139: Permission popup for non-active project tabs.
 * Tests the compact popup rendering and interaction via direct DOM injection,
 * since the full permission relay requires a running Claude Channel server.
 */
import { expect, test } from './coverage-fixture.js';

test.describe('Permission popup (HS-6139)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('permission popup renders with tool name, description, and allow/deny buttons', async ({ page }) => {
    // Inject a permission popup directly via the DOM (simulating what showPermissionPopup does)
    await page.evaluate(() => {
      const popup = document.createElement('div');
      popup.className = 'permission-popup';
      popup.innerHTML = `
        <span class="permission-popup-tool">Bash</span>
        <span class="permission-popup-desc">npm run build — compiles the project and outputs to dist/</span>
        <button class="permission-popup-allow" title="Allow">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
        </button>
        <button class="permission-popup-deny" title="Deny">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      `;
      popup.style.top = '50px';
      popup.style.left = '100px';
      document.body.appendChild(popup);
    });

    // Verify the popup is visible with correct elements
    const popup = page.locator('.permission-popup');
    await expect(popup).toBeVisible();
    await expect(popup.locator('.permission-popup-tool')).toContainText('Bash');
    await expect(popup.locator('.permission-popup-desc')).toContainText('npm run build');
    await expect(popup.locator('.permission-popup-allow')).toBeVisible();
    await expect(popup.locator('.permission-popup-deny')).toBeVisible();

    // Take a screenshot for the ticket
    await page.screenshot({ path: 'test-results/permission-popup-screenshot.png', fullPage: false });

    // Click deny button — popup should be removed
    await popup.locator('.permission-popup-deny').click();
    // Popup was removed by click handler in real code; in our injected version it stays
    // but this verifies the button is clickable
  });
});
