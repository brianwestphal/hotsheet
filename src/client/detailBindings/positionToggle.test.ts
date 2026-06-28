// @vitest-environment happy-dom
/** HS-9143 — `bindDetailPositionToggle` / `updateDetailPositionToggle` branches. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bindDetailPositionToggle, updateDetailPositionToggle } from './positionToggle.js';

const h = vi.hoisted(() => ({
  state: { settings: { detail_position: 'side', detail_visible: true } },
  updateSettings: vi.fn(() => Promise.resolve()),
  applyDetailPosition: vi.fn(),
  applyDetailSize: vi.fn(),
}));
vi.mock('../../api/index.js', () => ({ updateSettings: h.updateSettings }));
vi.mock('../detail.js', () => ({ applyDetailPosition: h.applyDetailPosition, applyDetailSize: h.applyDetailSize }));
vi.mock('../state.js', () => ({ state: h.state }));

beforeEach(() => {
  document.body.innerHTML = `
    <div id="detail-position-toggle">
      <button class="layout-btn" data-position="side"></button>
      <button class="layout-btn" data-position="bottom"></button>
    </div>
    <div id="detail-panel"></div>
    <div id="detail-resize-handle"></div>`;
  h.state.settings = { detail_position: 'side', detail_visible: true };
  for (const k of ['updateSettings', 'applyDetailPosition', 'applyDetailSize'] as const) h[k].mockReset();
  h.updateSettings.mockResolvedValue(undefined);
});
afterEach(() => { document.body.innerHTML = ''; });

const btn = (pos: string): HTMLElement => document.querySelector(`.layout-btn[data-position="${pos}"]`)!;

describe('updateDetailPositionToggle', () => {
  it('marks the active button matching the current position', () => {
    updateDetailPositionToggle();
    expect(btn('side').classList.contains('active')).toBe(true);
    expect(btn('bottom').classList.contains('active')).toBe(false);
  });
});

describe('bindDetailPositionToggle', () => {
  it('clicking the already-active position hides the panel (toggle off)', () => {
    bindDetailPositionToggle();
    btn('side').click(); // side is active + visible
    expect(h.state.settings.detail_visible).toBe(false);
    expect(document.getElementById('detail-panel')!.style.display).toBe('none');
    expect(document.getElementById('detail-resize-handle')!.style.display).toBe('none');
    expect(btn('side').classList.contains('active')).toBe(false);
    expect(h.updateSettings).toHaveBeenLastCalledWith({ detail_visible: 'false' });
  });

  it('clicking a different position switches + shows the panel', () => {
    bindDetailPositionToggle();
    btn('bottom').click();
    expect(h.state.settings.detail_visible).toBe(true);
    expect(h.state.settings.detail_position).toBe('bottom');
    expect(document.getElementById('detail-panel')!.style.display).toBe('');
    expect(h.applyDetailPosition).toHaveBeenCalledWith('bottom');
    expect(h.applyDetailSize).toHaveBeenCalled();
    expect(btn('bottom').classList.contains('active')).toBe(true);
    expect(h.updateSettings).toHaveBeenLastCalledWith({ detail_position: 'bottom', detail_visible: 'true' });
  });

  it('clicking the current position while hidden re-enables it (not the toggle-off branch)', () => {
    h.state.settings.detail_visible = false; // hidden
    bindDetailPositionToggle();
    btn('side').click(); // same position but not visible → re-enable branch
    expect(h.state.settings.detail_visible).toBe(true);
    expect(h.applyDetailPosition).toHaveBeenCalledWith('side');
  });
});
