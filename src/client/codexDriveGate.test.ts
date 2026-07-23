// HS-9384 — the pure hide-the-codex-drive-surface decision (docs/121 §121.7).
import { describe, expect, it } from 'vitest';

import { shouldHideCodexDriveSurface } from './codexDriveGate.js';

describe('shouldHideCodexDriveSurface', () => {
  it('hides for a codex project when the toggle is off', () => {
    expect(shouldHideCodexDriveSurface({ codexAppServerEnabled: false }, 'codex')).toBe(true);
    expect(shouldHideCodexDriveSurface({ codexAppServerEnabled: false }, 'Codex')).toBe(true); // case-insensitive
  });

  it('hides for a codex project when the handshake failed', () => {
    expect(shouldHideCodexDriveSurface({ codexAppServerEnabled: true, codexAppServerFailed: true }, 'codex')).toBe(true);
  });

  it('shows for a codex project when enabled and healthy — and fails OPEN on absent fields (older server)', () => {
    expect(shouldHideCodexDriveSurface({ codexAppServerEnabled: true, codexAppServerFailed: false }, 'codex')).toBe(false);
    expect(shouldHideCodexDriveSurface({}, 'codex')).toBe(false);
  });

  it('never gates non-codex tools — the toggle is meaningless for other drives', () => {
    for (const tool of ['claude', 'auto', '', undefined, 'antigravity', 'opencode']) {
      expect(shouldHideCodexDriveSurface({ codexAppServerEnabled: false, codexAppServerFailed: true }, tool)).toBe(false);
    }
  });
});
