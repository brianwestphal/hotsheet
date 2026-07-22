import { describe, expect, it } from 'vitest';

import {
  _resetGlassboxInstructionsCacheForTests,
  getGlassboxNoteInstructions,
} from './reviewNotesInducement.js';
import { isExecutableOnPath } from './utils/isExecutableOnPath.js';

// HS-9371 — LIVE integration guard (no mocks). The unit tests in
// `reviewNotesInducement.test.ts` mock both the PATH probe and the exec, so
// they kept passing while the real `glassbox note instructions` invocation was
// broken by the desktop-launcher shim (it swallowed the `note` subcommand and
// tried to boot the whole app). This test runs the REAL probe: on any machine
// with a `glassbox` CLI installed, the probe must succeed via SOME invocation
// form and yield the canonical instruction text — if a Glassbox update ever
// re-breaks subcommand routing, this fails on the maintainer's machine instead
// of silently degrading the worklist to the fallback nudge.
//
// Skipped (not failed) when glassbox isn't installed — CI stays green.

const glassboxInstalled = isExecutableOnPath('glassbox');

describe('getGlassboxNoteInstructions — live glassbox CLI (HS-9371)', () => {
  it.skipIf(!glassboxInstalled)(
    'fetches the canonical instruction text from the installed glassbox',
    // Two sequential exec attempts × 5s exec timeout, plus slack.
    { timeout: 15000 },
    () => {
      _resetGlassboxInstructionsCacheForTests();
      const probe = getGlassboxNoteInstructions();
      // Any failure kind here means the installed Glassbox can't serve the
      // inducement contract — surface it loudly rather than shipping the
      // fallback nudge (the exact HS-9371 regression).
      expect(probe.kind).toBe('ok');
      if (probe.kind === 'ok') {
        // Sanity: it's the review-notes instruction text, not an error dump.
        expect(probe.text).toContain('.pr-notes');
      }
      _resetGlassboxInstructionsCacheForTests();
    },
  );
});
