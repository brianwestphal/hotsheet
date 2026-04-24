/**
 * Tests for the HS-7272 native-notification helpers in tauriIntegration.tsx.
 *
 * The module reaches `window` / `document` lazily (only inside its exported
 * functions, never at import time), so we can run these tests in the default
 * Node environment by stubbing the globals before each case — no jsdom needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetNotificationPermissionForTests,
  fireNativeNotification,
  isAppBackgrounded,
  requestNativeNotificationPermission,
} from './tauriIntegration.js';

interface WindowStub {
  __TAURI__?: {
    core?: { invoke: ReturnType<typeof vi.fn> };
    notification?: {
      isPermissionGranted?: ReturnType<typeof vi.fn>;
      requestPermission?: ReturnType<typeof vi.fn>;
    };
  };
}

interface DocumentStub {
  hidden: boolean;
  hasFocus: () => boolean;
}

function installGlobals(windowStub: WindowStub, documentStub: DocumentStub): void {
  (globalThis as unknown as { window: WindowStub }).window = windowStub;
  (globalThis as unknown as { document: DocumentStub }).document = documentStub;
}

function clearGlobals(): void {
  delete (globalThis as unknown as { window?: unknown }).window;
  delete (globalThis as unknown as { document?: unknown }).document;
}

beforeEach(() => {
  _resetNotificationPermissionForTests();
});

afterEach(() => {
  clearGlobals();
});

describe('requestNativeNotificationPermission (HS-7272)', () => {
  it('short-circuits in a browser context (no __TAURI__ global)', async () => {
    installGlobals({}, { hidden: false, hasFocus: () => true });
    await expect(requestNativeNotificationPermission()).resolves.toBeUndefined();
  });

  it('calls requestPermission only when isPermissionGranted returns false', async () => {
    const isPermissionGranted = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const requestPermission = vi.fn<() => Promise<string>>().mockResolvedValue('granted');
    installGlobals(
      { __TAURI__: { notification: { isPermissionGranted, requestPermission } } },
      { hidden: false, hasFocus: () => true },
    );

    await requestNativeNotificationPermission();

    expect(isPermissionGranted).toHaveBeenCalledOnce();
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it('does not call requestPermission when already granted', async () => {
    const isPermissionGranted = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const requestPermission = vi.fn<() => Promise<string>>().mockResolvedValue('granted');
    installGlobals(
      { __TAURI__: { notification: { isPermissionGranted, requestPermission } } },
      { hidden: false, hasFocus: () => true },
    );

    await requestNativeNotificationPermission();

    expect(isPermissionGranted).toHaveBeenCalledOnce();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('is idempotent — a second call does not re-prompt', async () => {
    const isPermissionGranted = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const requestPermission = vi.fn<() => Promise<string>>().mockResolvedValue('granted');
    installGlobals(
      { __TAURI__: { notification: { isPermissionGranted, requestPermission } } },
      { hidden: false, hasFocus: () => true },
    );

    await requestNativeNotificationPermission();
    await requestNativeNotificationPermission();

    expect(isPermissionGranted).toHaveBeenCalledOnce();
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it('swallows errors from the permission API so boot keeps going', async () => {
    const isPermissionGranted = vi.fn<() => Promise<boolean>>().mockRejectedValue(new Error('denied'));
    installGlobals(
      { __TAURI__: { notification: { isPermissionGranted, requestPermission: vi.fn() } } },
      { hidden: false, hasFocus: () => true },
    );

    await expect(requestNativeNotificationPermission()).resolves.toBeUndefined();
  });
});

describe('fireNativeNotification (HS-7272)', () => {
  it('returns false in a browser context (no Tauri invoke)', async () => {
    installGlobals({}, { hidden: false, hasFocus: () => true });
    await expect(fireNativeNotification('My Project', 'Build done')).resolves.toBe(false);
  });

  it('invokes show_native_notification with title and body when running in Tauri', async () => {
    const invoke = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    installGlobals(
      { __TAURI__: { core: { invoke } } },
      { hidden: true, hasFocus: () => false },
    );

    const ok = await fireNativeNotification('My Project', 'Build done');

    expect(ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith('show_native_notification', {
      title: 'My Project',
      body: 'Build done',
    });
  });

  it('returns false when the invoke rejects (permission denied, plugin missing, …)', async () => {
    const invoke = vi.fn<(cmd: string) => Promise<unknown>>().mockRejectedValue(new Error('denied'));
    installGlobals(
      { __TAURI__: { core: { invoke } } },
      { hidden: true, hasFocus: () => false },
    );

    await expect(fireNativeNotification('X', 'y')).resolves.toBe(false);
  });
});

describe('isAppBackgrounded (HS-7272)', () => {
  it('returns true when document.hidden is set', () => {
    installGlobals({}, { hidden: true, hasFocus: () => true });
    expect(isAppBackgrounded()).toBe(true);
  });

  it('returns true when the window is not focused (hidden=false, hasFocus=false)', () => {
    installGlobals({}, { hidden: false, hasFocus: () => false });
    expect(isAppBackgrounded()).toBe(true);
  });

  it('returns false only when visible AND focused', () => {
    installGlobals({}, { hidden: false, hasFocus: () => true });
    expect(isAppBackgrounded()).toBe(false);
  });
});
