// @vitest-environment happy-dom
/**
 * HS-8911 — the desktop "Shutting Down" overlay rendering + step updates.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { _resetShutdownOverlayForTesting, showShutdownOverlay } from './shutdownOverlay.js';
import { SHUTDOWN_DEFAULT_PHRASE } from './shutdownProgress.js';

afterEach(() => { _resetShutdownOverlayForTesting(); });

describe('showShutdownOverlay (HS-8911)', () => {
  it('appends a full-screen overlay with the title + default step phrase', () => {
    showShutdownOverlay();
    expect(document.querySelector('.shutdown-overlay')).not.toBeNull();
    expect(document.querySelector('.shutdown-overlay-title')?.textContent).toBe('Shutting Down');
    expect(document.querySelector('.shutdown-overlay-step')?.textContent).toBe(SHUTDOWN_DEFAULT_PHRASE);
  });

  it('updates the current-step line via the returned setter', () => {
    const setStep = showShutdownOverlay();
    setStep('Saving a snapshot of your data…');
    expect(document.querySelector('.shutdown-overlay-step')?.textContent).toBe('Saving a snapshot of your data…');
  });

  it('is idempotent — a second call reuses the single overlay', () => {
    showShutdownOverlay();
    const setStep = showShutdownOverlay();
    expect(document.querySelectorAll('.shutdown-overlay').length).toBe(1);
    setStep('Closing databases…');
    expect(document.querySelector('.shutdown-overlay-step')?.textContent).toBe('Closing databases…');
  });
});
