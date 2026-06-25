// @vitest-environment happy-dom
/**
 * HS-8911 — the desktop "Shutting Down" overlay rendering + step updates.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { showErrorPopup } from './api.js';
import { _resetShutdownOverlayForTesting, showShutdownOverlay } from './shutdownOverlay.js';
import { SHUTDOWN_DEFAULT_PHRASE } from './shutdownProgress.js';
import { _resetShutdownStateForTesting, isShuttingDown } from './shutdownState.js';

afterEach(() => {
  _resetShutdownOverlayForTesting();
  _resetShutdownStateForTesting();
  document.getElementById('network-error-popup')?.remove();
});

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

  // HS-9029 — opening the overlay flips the shutting-down flag (so subsequent
  // network failures don't pop the "Connection Error" dialog) and clears any
  // popup that slipped in just before quit.
  it('marks the app as shutting down', () => {
    expect(isShuttingDown()).toBe(false);
    showShutdownOverlay();
    expect(isShuttingDown()).toBe(true);
  });

  it('removes a "Connection Error" popup that was already on screen at quit time', () => {
    showErrorPopup('Unable to reach the server.');
    expect(document.getElementById('network-error-popup')).not.toBeNull();
    showShutdownOverlay();
    expect(document.getElementById('network-error-popup')).toBeNull();
  });
});
