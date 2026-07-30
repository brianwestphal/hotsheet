// HS-9384 — the pure hide-the-codex-drive-surface decision (docs/121 §121.7).
// HS-9513 — the `codexAppServerEnabled` half is gone; a FAILED handshake is the only
// thing that hides the surface now, and it is the only one of the two a user did not
// choose. The Retry button that replaced the toggle is what brings it back.
import { describe, expect, it } from 'vitest';

import { shouldHideCodexDriveSurface } from './codexDriveGate.js';

describe('shouldHideCodexDriveSurface', () => {
  it('hides for a codex project when the handshake failed', () => {
    expect(shouldHideCodexDriveSurface({ codexAppServerFailed: true }, 'codex')).toBe(true);
    expect(shouldHideCodexDriveSurface({ codexAppServerFailed: true }, 'Codex')).toBe(true); // case-insensitive
  });

  it('shows for a healthy codex project — and fails OPEN on an absent field (older server)', () => {
    expect(shouldHideCodexDriveSurface({ codexAppServerFailed: false }, 'codex')).toBe(false);
    // An upgrade window where the server predates the field must not black out the
    // play button; the surface staying visible is the safe direction.
    expect(shouldHideCodexDriveSurface({}, 'codex')).toBe(false);
  });

  it('never gates non-codex tools — the handshake state is meaningless for other drives', () => {
    for (const tool of ['claude', 'auto', '', undefined, 'antigravity', 'opencode']) {
      expect(shouldHideCodexDriveSurface({ codexAppServerFailed: true }, tool)).toBe(false);
    }
  });

  it('ignores a leftover codexAppServerEnabled field rather than honouring it', () => {
    // An older server (or a stale cached status) can still send the removed field.
    // Reading it again would resurrect a toggle the UI no longer offers any way to flip,
    // leaving the drive surface hidden with no control that explains why.
    const stale = { codexAppServerEnabled: false } as Record<string, unknown>;
    expect(shouldHideCodexDriveSurface(stale, 'codex')).toBe(false);
  });
});
