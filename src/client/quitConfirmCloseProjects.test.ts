// @vitest-environment happy-dom
//
// HS-8604 — `confirmCloseProjects` integration: fetch /quit-summary → scope to
// the closing project(s) → reuse §37's `evaluateQuitDecision` → show the
// lightweight `confirmDialog` only when there's a running process to stop.
// In its own file (separate from `quitConfirm.test.ts`) so the `./api.js` +
// `./confirm.js` module mocks don't disturb that file's real-`terminalCheckout`
// `showQuitConfirmDialog` tests.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from './api.js';
import { confirmDialog } from './confirm.js';
import { confirmCloseProjects, type QuitSummary } from './quitConfirm.js';
import { resetApiTransport, wireRealApiTransport } from './test-helpers/realApiTransport.js';

vi.mock('./api.js', () => ({ api: vi.fn(), apiWithSecret: vi.fn() }));
vi.mock('./confirm.js', () => ({ confirmDialog: vi.fn(() => Promise.resolve(true)) }));

interface Entry { terminalId: string; label: string; foregroundCommand: string; isShell: boolean; isExempt: boolean }
function proj(secret: string, confirmMode: QuitSummary['projects'][number]['confirmMode'], entries: Array<Partial<Entry> & { isExempt: boolean }>): QuitSummary['projects'][number] {
  return {
    secret,
    name: secret,
    confirmMode,
    entries: entries.map((e, i) => ({
      terminalId: e.terminalId ?? `t${String(i)}`,
      label: e.label ?? `Tab ${String(i)}`,
      foregroundCommand: e.foregroundCommand ?? 'claude',
      isShell: e.isShell ?? false,
      isExempt: e.isExempt,
    })),
  };
}

beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(confirmDialog).mockReset().mockResolvedValue(true);
  // HS-8635 — `confirmCloseProjects` now calls the typed `getQuitSummary`,
  // which routes through the injected transport. `vi.mock('./api.js')` above
  // makes the helper's `api` resolve to this file's mock, so the typed caller
  // returns whatever `vi.mocked(api).mockResolvedValue(...)` provides.
  wireRealApiTransport();
});

afterEach(() => {
  resetApiTransport();
  vi.clearAllMocks();
});

describe('confirmCloseProjects (HS-8604)', () => {
  it('prompts and returns the confirm result when the project has a running non-exempt terminal', async () => {
    vi.mocked(api).mockResolvedValue({ projects: [proj('s1', 'with-non-exempt-processes', [{ isExempt: false }])] });
    vi.mocked(confirmDialog).mockResolvedValue(true);

    const result = await confirmCloseProjects(['s1']);

    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(result).toBe(true);
  });

  it('returns false (abort) when the user cancels the confirm', async () => {
    vi.mocked(api).mockResolvedValue({ projects: [proj('s1', 'with-non-exempt-processes', [{ isExempt: false }])] });
    vi.mocked(confirmDialog).mockResolvedValue(false);

    expect(await confirmCloseProjects(['s1'])).toBe(false);
  });

  it('does NOT prompt (returns true) when the only running terminal is exempt under with-non-exempt mode', async () => {
    vi.mocked(api).mockResolvedValue({ projects: [proj('s1', 'with-non-exempt-processes', [{ isExempt: true }])] });

    const result = await confirmCloseProjects(['s1']);

    expect(confirmDialog).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('does NOT prompt for an idle tab even under the always setting (nothing to stop)', async () => {
    vi.mocked(api).mockResolvedValue({ projects: [proj('s1', 'always', [])] });

    const result = await confirmCloseProjects(['s1']);

    expect(confirmDialog).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('does NOT prompt when the project is set to never, even with a running non-exempt terminal', async () => {
    vi.mocked(api).mockResolvedValue({ projects: [proj('s1', 'never', [{ isExempt: false }])] });

    const result = await confirmCloseProjects(['s1']);

    expect(confirmDialog).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('scopes the decision to the closing secrets, ignoring other projects', async () => {
    // s2 has a running non-exempt terminal, but we're only closing s1 (idle).
    vi.mocked(api).mockResolvedValue({
      projects: [
        proj('s1', 'with-non-exempt-processes', []),
        proj('s2', 'with-non-exempt-processes', [{ isExempt: false }]),
      ],
    });

    const result = await confirmCloseProjects(['s1']);

    expect(confirmDialog).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('proceeds (returns true) without prompting when the quit-summary fetch fails', async () => {
    vi.mocked(api).mockRejectedValue(new Error('network down'));

    const result = await confirmCloseProjects(['s1']);

    expect(confirmDialog).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });
});
