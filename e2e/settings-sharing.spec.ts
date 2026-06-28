import { expect, test } from './coverage-fixture.js';

// HS-9004 — dialog-wide Shared | Local overrides | Resolved scope control. A
// persistent toolbar under the Settings tab strip decorates each file-settings
// field in place (no dedicated "Sharing" tab).
test.describe('Settings scope control (Shared | Local | Resolved)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    // First-launch AI-instructions nudge (HS-8913) overlay intercepts clicks.
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      document.querySelectorAll('.ai-instructions-nudge-overlay').forEach(el => el.remove());
    });
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#settings-scope-bar')).toBeVisible();
  });

  test('renders the dialog-wide toolbar; defaults to Resolved with origin tags', async ({ page }) => {
    await expect(page.locator('.scope-seg-btn')).toHaveCount(3);
    await expect(page.locator('.scope-seg-btn.scope-seg-resolved.active')).toBeVisible();
    // Settings stay in their own tabs — the General tab is shown, not a Sharing tab.
    await expect(page.locator('.settings-tab[data-tab="sharing"]')).toHaveCount(0);
    // A scalar field carries an origin tag in Resolved mode.
    const field = page.locator('.settings-field:has(#settings-app-name)');
    await expect(field.locator('.scope-tag')).toBeVisible({ timeout: 5000 });
  });

  test('Shared mode is editable and notes the file being edited', async ({ page }) => {
    await page.locator('.scope-seg-btn.scope-seg-shared').click();
    await expect(page.locator('.scope-seg-btn.scope-seg-shared.active')).toBeVisible();
    await expect(page.locator('#settings-scope-note')).toContainText('settings.json');
    await expect(page.locator('#settings-app-name')).toBeEnabled();
  });

  test('Local mode: override an inherited field, then reset it', async ({ page }) => {
    await page.locator('.scope-seg-btn.scope-seg-local').click();
    await expect(page.locator('#settings-scope-note')).toContainText('settings.local.json');

    // Worklist preamble is a standard scoped field (shared-default, local override
    // allowed) — appName is now shared-only (HS-9009), so it has no "+ Override".
    const field = page.locator('.settings-field:has(#settings-worklist-preamble)');
    const overrideBtn = field.locator('[data-scope-action="override"]');
    await expect(overrideBtn).toBeVisible();
    await expect(page.locator('#settings-worklist-preamble')).toBeDisabled();
    await overrideBtn.click();

    // Now an editable local override with a Reset action.
    await expect(page.locator('#settings-worklist-preamble')).toBeEnabled({ timeout: 3000 });
    await page.locator('#settings-worklist-preamble').fill('Local-only preamble');
    await page.waitForTimeout(900); // debounced write

    // Reset to shared → in-app confirm overlay (Tauri-safe, NOT window.confirm).
    await field.locator('[data-scope-action="reset"]').click();
    const confirmBtn = page.locator('.confirm-dialog-confirm');
    await expect(confirmBtn).toBeVisible({ timeout: 3000 });
    await confirmBtn.click();

    // Back to inherited (the +Override affordance returns, control re-disabled).
    await expect(field.locator('[data-scope-action="override"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#settings-worklist-preamble')).toBeDisabled();
  });

  test('HS-9009: shared-only fields have no local override; local-only fields are read-only in Shared', async ({ page }) => {
    // appName is shared-only: editable in Shared, read-only "shared only" in Local (no + Override).
    await page.locator('.scope-seg-btn.scope-seg-shared').click();
    await expect(page.locator('#settings-app-name')).toBeEnabled();
    await page.locator('.scope-seg-btn.scope-seg-local').click();
    const appNameField = page.locator('.settings-field:has(#settings-app-name)');
    await expect(appNameField.locator('[data-scope-action="override"]')).toHaveCount(0);
    await expect(appNameField.locator('.scope-tag')).toContainText('shared only');
    await expect(page.locator('#settings-app-name')).toBeDisabled();
    // Categories is a shared-only complex editor: locked in Local, NOT in Shared.
    await expect(page.locator('.settings-tab-panel[data-panel="categories"].scope-locked')).toHaveCount(1);
    await page.locator('.scope-seg-btn.scope-seg-shared').click();
    await expect(page.locator('.settings-tab-panel[data-panel="categories"].scope-locked')).toHaveCount(0);

    // Permissions is a local-only complex editor: locked in Shared, NOT in Local.
    await expect(page.locator('#settings-permissions-panel.scope-locked')).toHaveCount(1);
    await page.locator('.scope-seg-btn.scope-seg-local').click();
    await expect(page.locator('#settings-permissions-panel.scope-locked')).toHaveCount(0);
  });

  test('complex / non-overridable surfaces lock in Shared/Local mode', async ({ page }) => {
    // Categories is a complex list editor — read-only outside Resolved.
    await page.locator('.scope-seg-btn.scope-seg-local').click();
    await expect(page.locator('.settings-tab-panel[data-panel="categories"].scope-locked')).toHaveCount(1);
    await page.locator('.scope-seg-btn.scope-seg-resolved').click();
    await expect(page.locator('.settings-tab-panel[data-panel="categories"].scope-locked')).toHaveCount(0);
  });

  // HS-9021 — a default `data-scope-complex` surface (e.g. the terminal default-
  // appearance block) is a SHARED setting: editable only in Shared, read-only in
  // Resolved + Local (Resolved is the read-only effective view; you edit in
  // Shared). The lock chip points to Shared, not Resolved. (The custom-commands
  // list is NO LONGER such a surface — HS-9014 made it element-level scope-aware;
  // see the dedicated test below.)
  test('HS-9021: default complex panels edit in Shared, read-only in Resolved + Local', async ({ page }) => {
    const panel = page.locator('.settings-terminal-default-appearance');
    // Default open mode is Resolved → read-only.
    await expect(panel).toHaveClass(/scope-locked/);
    // Shared → editable.
    await page.locator('.scope-seg-btn.scope-seg-shared').click();
    await expect(panel).not.toHaveClass(/scope-locked/);
    // Local → read-only again.
    await page.locator('.scope-seg-btn.scope-seg-local').click();
    await expect(panel).toHaveClass(/scope-locked/);
  });

  // HS-9014 — the custom-commands editor is now element-level scope-aware (the
  // group TREE variant of docs/95 §95.3): Local mode hides a shared command + adds
  // a local-only one, persisted as a tree delta in `settings.local.json` while
  // `settings.json` stays untouched.
  test('HS-9014: custom_commands is scope-aware — Local hides a shared command + adds a local one, saved as a tree delta', async ({ page }) => {
    // Seed two SHARED commands via the shared layer, then reopen the dialog.
    await page.request.patch('/api/file-settings/layer', {
      data: { layer: 'shared', settings: { custom_commands: [
        { id: 'shared-a', name: 'Shared A', prompt: 'pa', target: 'shell' },
        { id: 'shared-b', name: 'Shared B', prompt: 'pb', target: 'shell' },
      ] } },
      headers: { Origin: page.url().replace(/\/[^/]*$/, '') },
    });
    // Reopen settings so the editor reloads the seeded shared tree.
    await page.locator('#settings-close').click();
    await page.locator('#settings-btn').click();
    await page.locator('.settings-tab[data-tab="experimental"]').click();

    // Switch to Local mode → the commands list is NOT wholesale-locked and shows
    // the local hint + origin tags.
    await page.locator('.scope-seg-btn.scope-seg-local').click();
    const list = page.locator('#settings-commands-list');
    await expect(list).not.toHaveClass(/scope-locked/);
    await expect(list.locator('.scope-list-hint-local')).toBeVisible({ timeout: 5000 });
    await expect(list.locator('.cmd-outline-row .cmd-scope-tag.scope-tag-shared').first()).toBeVisible();

    // Hide the first shared command (its delete button = "Hide" in Local mode).
    await list.locator('.cmd-outline-row').filter({ hasText: 'Shared A' }).locator('.cmd-outline-delete-btn').click();
    await page.waitForTimeout(400);

    // Add a LOCAL-only command (top level) and give it a name so the save fires.
    await list.locator('.cmd-outline-add-btn').click();
    const modal = page.locator('.cmd-editor-overlay');
    await expect(modal).toBeVisible({ timeout: 3000 });
    await modal.locator('.settings-command-row-header input[type="text"]').fill('My Local Cmd');
    await page.waitForTimeout(300); // input-driven save
    await modal.locator('.cmd-editor-done-btn').click();
    await page.waitForTimeout(300);

    // The local layer holds a tree delta: hides shared-a AND adds the local command;
    // the shared (committed) tree is untouched.
    const layered = await (await page.request.get('/api/file-settings/layered')).json() as {
      shared: Record<string, unknown>; local: Record<string, unknown>;
    };
    const localCmd = layered.local.custom_commands as { hidden?: string[]; added?: { name: string }[] } | undefined;
    expect(localCmd?.hidden).toContain('shared-a');
    expect(localCmd?.added?.some(c => c.name === 'My Local Cmd')).toBe(true);
    const sharedCmd = layered.shared.custom_commands as { id: string }[];
    expect(sharedCmd.map(c => c.id)).toEqual(['shared-a', 'shared-b']); // shared unchanged — local-only add
  });

  // HS-9094 — a shared CHILD command moves into the local layer: it physically
  // leaves its shared group in settings.json and becomes a `childAdded` child in
  // settings.local.json (so it's machine-only but still appears in the group).
  test('HS-9094: a shared child command moves to the local layer (childAdded), leaving the shared group', async ({ page }) => {
    await page.request.patch('/api/file-settings/layer', {
      data: { layer: 'shared', settings: { custom_commands: [
        { type: 'group', id: 'grp-1', name: 'Group One', children: [
          { id: 'child-a', name: 'Child A', prompt: 'pa', target: 'shell' },
          { id: 'child-b', name: 'Child B', prompt: 'pb', target: 'shell' },
        ] },
      ] } },
      headers: { Origin: page.url().replace(/\/[^/]*$/, '') },
    });
    await page.locator('#settings-close').click();
    await page.locator('#settings-btn').click();
    await page.locator('.settings-tab[data-tab="experimental"]').click();
    await page.locator('.scope-seg-btn.scope-seg-local').click();

    const list = page.locator('#settings-commands-list');
    await expect(list.locator('.scope-list-hint-local')).toBeVisible({ timeout: 5000 });
    // The child row carries a "shared" tag + a "Move to Local" (↓) button.
    const childRow = list.locator('.cmd-outline-row.cmd-outline-indented').filter({ hasText: 'Child A' });
    await expect(childRow.locator('.cmd-scope-tag.scope-tag-shared')).toBeVisible();
    await childRow.locator('.cmd-outline-move-btn[data-move="to-local"]').click();
    await page.waitForTimeout(500);

    const layered = await (await page.request.get('/api/file-settings/layered')).json() as {
      shared: Record<string, unknown>; local: Record<string, unknown>;
    };
    // Shared group no longer holds child-a (it physically left settings.json).
    const sharedGroup = (layered.shared.custom_commands as { id: string; children: { id: string }[] }[])[0];
    expect(sharedGroup.children.map(c => c.id)).toEqual(['child-b']);
    // The local delta re-adds it into the same group as a childAdded child.
    const localCmd = layered.local.custom_commands as { childAdded?: Record<string, { children: { id: string }[] }> } | undefined;
    expect(localCmd?.childAdded?.['grp-1']?.children.map(c => c.id)).toEqual(['child-a']);
  });

  test('HS-9016: auto-context is editable per-layer in Local mode and saves a local delta', async ({ page }) => {
    // Context panel is no longer wholesale-locked (it's now scope-aware).
    await page.locator('.scope-seg-btn.scope-seg-local').click();
    await expect(page.locator('.settings-tab-panel[data-panel="context"].scope-locked')).toHaveCount(0);
    await page.locator('.settings-tab[data-tab="context"]').click();
    // Local-mode hint banner is shown.
    await expect(page.locator('#auto-context-list .scope-list-hint-local')).toBeVisible({ timeout: 5000 });

    // Add a local-only auto-context entry (pick the first category option).
    await page.locator('#auto-context-add-btn').click();
    await page.locator('.ac-option-item').first().click();
    const textarea = page.locator('#auto-context-list .auto-context-text').first();
    await expect(textarea).toBeVisible({ timeout: 3000 });
    await textarea.fill('Machine-local context note');
    await page.waitForTimeout(700); // debounced save

    // The entry persisted to the LOCAL layer as an element-level delta (added), not the shared array.
    const res = await page.request.get('/api/file-settings/layered');
    const layered = await res.json() as { shared: Record<string, unknown>; local: Record<string, unknown> };
    const localAc = layered.local.auto_context as { added?: unknown[] } | undefined;
    expect(localAc).toBeTruthy();
    expect(Array.isArray(localAc?.added)).toBe(true);
    expect(localAc?.added?.length).toBeGreaterThan(0);
    // Shared layer was NOT written.
    expect(layered.shared.auto_context).toBeUndefined();
  });

  test('HS-9120: a locally-edited shared auto-context shows "overridden" + Reset to shared', async ({ page }) => {
    // Seed a SHARED auto-context entry, then reopen the dialog in Local mode.
    await page.request.patch('/api/file-settings/layer', {
      data: { layer: 'shared', settings: { auto_context: [
        { type: 'tag', key: 'urgent', text: 'Shared urgent note' },
      ] } },
      headers: { Origin: page.url().replace(/\/[^/]*$/, '') },
    });
    await page.locator('#settings-close').click();
    await page.locator('#settings-btn').click();
    await page.locator('.scope-seg-btn.scope-seg-local').click();
    await page.locator('.settings-tab[data-tab="context"]').click();

    const entry = page.locator('#auto-context-list .auto-context-entry').filter({ hasText: 'Urgent' }).first();
    // Inherited shared entry starts tagged "shared", no Reset.
    await expect(entry.locator('.scope-tag')).toContainText('shared', { timeout: 5000 });
    await expect(entry.locator('[data-scope-action="reset"]')).toHaveCount(0);

    // Edit the text locally → becomes "overridden" with a Reset-to-shared button.
    await entry.locator('.auto-context-text').fill('Locally tweaked note');
    await page.waitForTimeout(700); // debounced save + in-place tag repaint
    await expect(entry.locator('.scope-tag')).toContainText('overridden');
    const resetBtn = entry.locator('[data-scope-action="reset"]');
    await expect(resetBtn).toBeVisible();

    // Reset returns it to the shared value + "shared" tag.
    await resetBtn.click();
    const resetEntry = page.locator('#auto-context-list .auto-context-entry').filter({ hasText: 'Urgent' }).first();
    await expect(resetEntry.locator('.auto-context-text')).toHaveValue('Shared urgent note', { timeout: 3000 });
    await expect(resetEntry.locator('.scope-tag')).toContainText('shared');
  });

  test('HS-9121: deleting a shared auto-context in Local mode disables it with a Re-enable', async ({ page }) => {
    await page.request.patch('/api/file-settings/layer', {
      data: { layer: 'shared', settings: { auto_context: [
        { type: 'tag', key: 'urgent', text: 'Shared urgent note' },
      ] } },
      headers: { Origin: page.url().replace(/\/[^/]*$/, '') },
    });
    await page.locator('#settings-close').click();
    await page.locator('#settings-btn').click();
    await page.locator('.scope-seg-btn.scope-seg-local').click();
    await page.locator('.settings-tab[data-tab="context"]').click();

    const entry = page.locator('#auto-context-list .auto-context-entry').filter({ hasText: 'Urgent' }).first();
    await expect(entry.locator('.auto-context-text')).toBeVisible({ timeout: 5000 });

    // Delete it → becomes a dimmed "Locally disabled" row with Re-enable (not gone).
    await entry.locator('.category-delete-btn').click();
    await page.waitForTimeout(500);
    const disabled = page.locator('#auto-context-list .auto-context-entry.locally-disabled').filter({ hasText: 'Urgent' });
    await expect(disabled).toBeVisible();
    await expect(disabled.locator('.scope-tag')).toContainText('Locally disabled');

    // The local layer recorded it as hidden.
    let layered = await (await page.request.get('/api/file-settings/layered')).json() as { local: Record<string, unknown> };
    expect((layered.local.auto_context as { hidden?: string[] }).hidden).toContain('tag:urgent');

    // Re-enable restores the editable entry + clears the hidden delta.
    await disabled.locator('[data-scope-action="reenable"]').click();
    await page.waitForTimeout(500);
    await expect(page.locator('#auto-context-list .auto-context-entry.locally-disabled')).toHaveCount(0);
    await expect(page.locator('#auto-context-list .auto-context-entry').filter({ hasText: 'Urgent' }).locator('.auto-context-text')).toBeVisible();
    layered = await (await page.request.get('/api/file-settings/layered')).json() as { local: Record<string, unknown> };
    const localAc = layered.local.auto_context as { hidden?: string[] } | undefined;
    expect(localAc?.hidden ?? []).not.toContain('tag:urgent');
  });

  test('HS-9015: terminals editor is scope-aware (editable + hint in Local, not locked)', async ({ page }) => {
    await page.locator('.scope-seg-btn.scope-seg-local').click();
    await page.locator('.settings-tab[data-tab="terminal"]').click();
    // The terminals list re-renders for Local mode with the per-mode hint, and
    // its containing field is no longer wholesale-locked.
    await expect(page.locator('#settings-terminals-list .scope-list-hint-local')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.settings-field:has(#settings-terminals-list).scope-locked')).toHaveCount(0);
  });

  test('HS-9128: a shared terminal shows a "shared" origin tag in Local mode', async ({ page }) => {
    await page.request.patch('/api/file-settings/layer', {
      data: { layer: 'shared', settings: { terminals: [
        { id: 'shared-term', name: 'Shared Term', command: 'zsh' },
      ] } },
      headers: { Origin: page.url().replace(/\/[^/]*$/, '') },
    });
    await page.locator('#settings-close').click();
    await page.locator('#settings-btn').click();
    await page.locator('.scope-seg-btn.scope-seg-local').click();
    await page.locator('.settings-tab[data-tab="terminal"]').click();

    const row = page.locator('.settings-terminal-row', { hasText: 'Shared Term' }).first();
    await expect(row.locator('.scope-tag')).toContainText('shared', { timeout: 5000 });
  });

  test('HS-9125: hide a shared terminal locally → disabled row + Re-enable', async ({ page }) => {
    await page.request.patch('/api/file-settings/layer', {
      data: { layer: 'shared', settings: { terminals: [
        { id: 'shared-term', name: 'Shared Term', command: 'zsh' },
      ] } },
      headers: { Origin: page.url().replace(/\/[^/]*$/, '') },
    });
    await page.locator('#settings-close').click();
    await page.locator('#settings-btn').click();
    await page.locator('.scope-seg-btn.scope-seg-local').click();
    await page.locator('.settings-tab[data-tab="terminal"]').click();

    const row = page.locator('.settings-terminal-row', { hasText: 'Shared Term' }).first();
    await expect(row).toBeVisible({ timeout: 5000 });
    // Delete it (= hide locally in Local mode) → confirm in the in-app dialog.
    await row.locator('.cmd-outline-delete-btn').click();
    const confirmBtn = page.locator('.confirm-dialog-confirm');
    await expect(confirmBtn).toBeVisible({ timeout: 3000 });
    await confirmBtn.click();

    const hidden = page.locator('.settings-terminal-row-hidden', { hasText: 'Shared Term' });
    await expect(hidden).toBeVisible({ timeout: 5000 });
    await expect(hidden.locator('.scope-tag')).toContainText('Locally hidden');

    // The local layer recorded the hide.
    let layered = await (await page.request.get('/api/file-settings/layered')).json() as { local: Record<string, unknown> };
    expect((layered.local.terminals as { hidden?: string[] }).hidden).toContain('shared-term');

    // Re-enable restores the editable row + clears the hidden delta.
    await hidden.locator('.term-reenable-btn').click();
    await page.waitForTimeout(600);
    await expect(page.locator('.settings-terminal-row-hidden')).toHaveCount(0);
    layered = await (await page.request.get('/api/file-settings/layered')).json() as { local: Record<string, unknown> };
    const localTerms = layered.local.terminals as { hidden?: string[] } | undefined;
    expect(localTerms?.hidden ?? []).not.toContain('shared-term');
  });

  test('HS-9006/9009: Announcer is local-only — enable toggle editable in Local, read-only in Shared; panel not wholesale-locked', async ({ page }) => {
    await page.locator('.scope-seg-btn.scope-seg-local').click();
    await page.locator('.settings-tab[data-tab="announcer"]').click();
    // The whole Announcer panel is NOT locked (global fields stay editable).
    await expect(page.locator('.settings-tab-panel[data-panel="announcer"].scope-locked')).toHaveCount(0);
    // local-only: the enable toggle is editable in Local (its home, no + Override),
    // and the local-only key sub-field is NOT locked in Local.
    await expect(page.locator('#settings-announcer-enabled')).toBeEnabled();
    await expect(page.locator('#settings-announcer-key-field.scope-locked')).toHaveCount(0);

    // In Shared, local-only surfaces go read-only ("local only").
    await page.locator('.scope-seg-btn.scope-seg-shared').click();
    await expect(page.locator('#settings-announcer-enabled')).toBeDisabled();
    const enableField = page.locator('.settings-field:has(#settings-announcer-enabled)');
    await expect(enableField.locator('.scope-tag')).toContainText('local only');
    await expect(page.locator('#settings-announcer-key-field.scope-locked')).toHaveCount(1);
  });
});
