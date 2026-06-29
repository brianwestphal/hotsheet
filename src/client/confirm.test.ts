// @vitest-environment happy-dom
/**
 * HS-9180 — `choiceDialog` is the three-way sibling of `confirmDialog`: a
 * primary action, a secondary (often destructive) action, and a SAFE cancel
 * path (Escape / backdrop / cancel button all resolve `'cancel'`). Used by the
 * feedback-form close-guard (Save Draft / Discard / Keep Editing).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { choiceDialog } from './confirm.js';

function opts() {
  return {
    title: 'Unsaved feedback',
    message: 'Save them as a draft?',
    primaryLabel: 'Save Draft',
    secondaryLabel: 'Discard',
    cancelLabel: 'Keep Editing',
    secondaryDanger: true,
  };
}

describe('choiceDialog (HS-9180)', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('renders the three labeled buttons', async () => {
    const p = choiceDialog(opts());
    const footer = document.querySelector('.confirm-dialog-footer')!;
    expect(footer.querySelector('.confirm-dialog-confirm')!.textContent).toBe('Save Draft');
    expect(footer.querySelector('.confirm-dialog-secondary')!.textContent).toBe('Discard');
    expect(footer.querySelector('.confirm-dialog-cancel')!.textContent).toBe('Keep Editing');
    // The destructive secondary is styled as danger.
    expect(footer.querySelector('.confirm-dialog-secondary')!.classList.contains('btn-danger')).toBe(true);
    // Resolve so the promise doesn't dangle.
    document.querySelector<HTMLButtonElement>('.confirm-dialog-cancel')!.click();
    await p;
  });

  it('the primary button resolves "primary"', async () => {
    const p = choiceDialog(opts());
    document.querySelector<HTMLButtonElement>('.confirm-dialog-confirm')!.click();
    expect(await p).toBe('primary');
    expect(document.querySelector('.confirm-dialog-overlay')).toBeNull(); // closes
  });

  it('the secondary button resolves "secondary"', async () => {
    const p = choiceDialog(opts());
    document.querySelector<HTMLButtonElement>('.confirm-dialog-secondary')!.click();
    expect(await p).toBe('secondary');
  });

  it('the cancel button resolves "cancel"', async () => {
    const p = choiceDialog(opts());
    document.querySelector<HTMLButtonElement>('.confirm-dialog-cancel')!.click();
    expect(await p).toBe('cancel');
  });

  it('Escape resolves the SAFE "cancel" (never destroys data)', async () => {
    const p = choiceDialog(opts());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(await p).toBe('cancel');
  });

  it('Enter resolves the primary action', async () => {
    const p = choiceDialog(opts());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(await p).toBe('primary');
  });

  it('a backdrop click resolves the safe "cancel"', async () => {
    const p = choiceDialog(opts());
    const overlay = document.querySelector<HTMLElement>('.confirm-dialog-overlay')!;
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(await p).toBe('cancel');
  });
});
