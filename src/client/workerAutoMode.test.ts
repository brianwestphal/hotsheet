// @vitest-environment happy-dom
/**
 * HS-9039 — the "Auto worker pool" switch logic: per-project persistence, the
 * slow-resize cadence, the toggle handler, UI sync, and the control loop's first
 * tick (which sizes the pool from the suggestion, clamped to MAX_TARGET) plus its
 * channel-visibility gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _stopAutoModeForTesting, applyAutoModeForActiveProject, bindWorkerAutoToggle,
  isAutoModeEnabled, setAutoModeEnabledPersisted, shouldResizeOnTick, syncWorkerAutoModeUI,
} from './workerAutoMode.js';

const mocks = vi.hoisted(() => ({
  getSuggestedWorkerCount: vi.fn(),
  setPoolTarget: vi.fn(),
  syncPoolHeadless: vi.fn(),
  getActiveProject: vi.fn<() => { secret: string } | null>(),
  showToast: vi.fn(),
}));

vi.mock('../api/index.js', () => ({
  getSuggestedWorkerCount: mocks.getSuggestedWorkerCount,
  setPoolTarget: mocks.setPoolTarget,
}));
vi.mock('./workerPoolPanel.js', () => ({ MAX_TARGET: 16, syncPoolHeadless: mocks.syncPoolHeadless }));
vi.mock('./state.js', () => ({ getActiveProject: mocks.getActiveProject }));
vi.mock('./toast.js', () => ({ showToast: mocks.showToast }));

function setupDom(sectionVisible: boolean): HTMLInputElement {
  document.body.innerHTML = '';
  const section = document.createElement('div');
  section.id = 'channel-play-section';
  section.style.display = sectionVisible ? '' : 'none';
  document.body.appendChild(section);
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.id = 'worker-auto-checkbox';
  document.body.appendChild(cb);
  return cb;
}

beforeEach(() => {
  localStorage.clear();
  mocks.getActiveProject.mockReturnValue({ secret: 's1' });
  mocks.getSuggestedWorkerCount.mockResolvedValue({ n: 3, rationale: 'ok', source: 'heuristic' });
  mocks.setPoolTarget.mockResolvedValue({ ok: true });
  mocks.syncPoolHeadless.mockResolvedValue({ targetN: 0, workers: [] });
});

afterEach(() => {
  _stopAutoModeForTesting();
  vi.clearAllMocks();
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('persistence', () => {
  it('round-trips per project secret and is isolated across projects', () => {
    expect(isAutoModeEnabled('s1')).toBe(false);
    setAutoModeEnabledPersisted('s1', true);
    expect(isAutoModeEnabled('s1')).toBe(true);
    expect(isAutoModeEnabled('s2')).toBe(false);
    setAutoModeEnabledPersisted('s1', false);
    expect(isAutoModeEnabled('s1')).toBe(false);
  });
});

describe('shouldResizeOnTick', () => {
  it('resizes on tick 0 and every Nth tick, not in between', () => {
    expect(shouldResizeOnTick(0, 15)).toBe(true);
    expect(shouldResizeOnTick(1, 15)).toBe(false);
    expect(shouldResizeOnTick(14, 15)).toBe(false);
    expect(shouldResizeOnTick(15, 15)).toBe(true);
    expect(shouldResizeOnTick(7, 7)).toBe(true);
  });
});

describe('toggle + UI sync', () => {
  it('persists + toasts when the checkbox is toggled', () => {
    const cb = setupDom(true);
    bindWorkerAutoToggle();
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    expect(isAutoModeEnabled('s1')).toBe(true);
    expect(mocks.showToast).toHaveBeenCalledWith(expect.stringContaining('Auto worker pool on'));

    cb.checked = false;
    cb.dispatchEvent(new Event('change'));
    expect(isAutoModeEnabled('s1')).toBe(false);
  });

  it('reflects the persisted flag onto the checkbox', () => {
    const cb = setupDom(true);
    setAutoModeEnabledPersisted('s1', true);
    syncWorkerAutoModeUI();
    expect(cb.checked).toBe(true);
    _stopAutoModeForTesting();

    setAutoModeEnabledPersisted('s1', false);
    syncWorkerAutoModeUI();
    expect(cb.checked).toBe(false);
  });
});

describe('control loop', () => {
  it('sizes the pool from the suggestion (clamped) on the first tick when enabled + visible', async () => {
    setupDom(true);
    setAutoModeEnabledPersisted('s1', true);
    applyAutoModeForActiveProject();
    await vi.waitFor(() => expect(mocks.setPoolTarget).toHaveBeenCalledWith({ targetN: 3 }));
  });

  it('clamps an over-large suggestion to MAX_TARGET', async () => {
    mocks.getSuggestedWorkerCount.mockResolvedValue({ n: 99, rationale: 'lots', source: 'ai' });
    setupDom(true);
    setAutoModeEnabledPersisted('s1', true);
    applyAutoModeForActiveProject();
    await vi.waitFor(() => expect(mocks.setPoolTarget).toHaveBeenCalledWith({ targetN: 16 }));
  });

  it('does NOT run when the channel play section is hidden', async () => {
    setupDom(false);
    setAutoModeEnabledPersisted('s1', true);
    applyAutoModeForActiveProject();
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.setPoolTarget).not.toHaveBeenCalled();
  });

  it('does NOT run when Auto is off for the active project', async () => {
    setupDom(true);
    applyAutoModeForActiveProject();
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.setPoolTarget).not.toHaveBeenCalled();
  });
});
