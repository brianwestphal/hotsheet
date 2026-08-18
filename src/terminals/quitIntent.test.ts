/**
 * HS-9692 (docs/136) — the quit-intent gate that decides whether a shutdown tears the
 * detached PTY broker down. The bug this pins: under the Tauri supervisor a bare
 * external SIGTERM (which the supervisor respawns from) must NOT tear the broker down,
 * or the fresh server re-adopts nothing and every terminal comes back blank.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearQuitIntent,
  isQuitIntended,
  isTerminalSupervised,
  markQuitIntended,
  quitIntentPath,
  shouldTearDownBroker,
} from './quitIntent.js';

describe('quitIntent (HS-9692)', () => {
  let dir: string;
  let marker: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hs-quitintent-'));
    marker = join(dir, 'terminal-quit-intent');
    // Clean baseline: no supervisor, marker pinned at a temp path so nothing touches
    // the real ~/.hotsheet. Individual tests override via vi.stubEnv.
    vi.stubEnv('HOTSHEET_TERMINAL_SUPERVISOR', '');
    vi.stubEnv('HOTSHEET_QUIT_INTENT_FILE', marker);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('quitIntentPath', () => {
    it('honors HOTSHEET_QUIT_INTENT_FILE verbatim', () => {
      expect(quitIntentPath()).toBe(marker);
    });

    it('falls back to <HOTSHEET_HOME>/terminal-quit-intent when the file env is blank/unset', () => {
      vi.stubEnv('HOTSHEET_QUIT_INTENT_FILE', '   '); // blank → treated as unset
      vi.stubEnv('HOTSHEET_HOME', dir);
      expect(quitIntentPath()).toBe(marker);
    });
  });

  describe('mark / is / clear', () => {
    it('round-trips a marker and clears it', () => {
      expect(isQuitIntended()).toBe(false);
      markQuitIntended();
      expect(existsSync(marker)).toBe(true);
      expect(isQuitIntended()).toBe(true);
      clearQuitIntent();
      expect(existsSync(marker)).toBe(false);
      expect(isQuitIntended()).toBe(false);
    });

    it('clearQuitIntent is a no-op when no marker exists', () => {
      expect(() => clearQuitIntent()).not.toThrow();
      expect(isQuitIntended()).toBe(false);
    });
  });

  describe('isTerminalSupervised', () => {
    it('true only when HOTSHEET_TERMINAL_SUPERVISOR=1', () => {
      expect(isTerminalSupervised()).toBe(false);
      vi.stubEnv('HOTSHEET_TERMINAL_SUPERVISOR', '1');
      expect(isTerminalSupervised()).toBe(true);
      vi.stubEnv('HOTSHEET_TERMINAL_SUPERVISOR', '0');
      expect(isTerminalSupervised()).toBe(false);
    });
  });

  describe('shouldTearDownBroker — the decision matrix', () => {
    it('SUPERVISED + no marker + SIGTERM → SURVIVE (the HS-9692 bug: external kill, respawnable)', () => {
      vi.stubEnv('HOTSHEET_TERMINAL_SUPERVISOR', '1');
      expect(shouldTearDownBroker('SIGTERM')).toBe(false);
      expect(shouldTearDownBroker('SIGINT')).toBe(false);
    });

    it('SUPERVISED + marker present + SIGTERM → TEAR DOWN (a genuine ⌘Q)', () => {
      vi.stubEnv('HOTSHEET_TERMINAL_SUPERVISOR', '1');
      markQuitIntended();
      expect(shouldTearDownBroker('SIGTERM')).toBe(true);
    });

    it('STANDALONE + no marker + SIGTERM/SIGINT → TEAR DOWN (real quit, nothing re-adopts)', () => {
      expect(isTerminalSupervised()).toBe(false);
      expect(shouldTearDownBroker('SIGTERM')).toBe(true);
      expect(shouldTearDownBroker('SIGINT')).toBe(true);
    });

    it('a non-signal reason (e.g. --replace "http") never tears down, supervised or not', () => {
      expect(shouldTearDownBroker('http')).toBe(false);
      vi.stubEnv('HOTSHEET_TERMINAL_SUPERVISOR', '1');
      expect(shouldTearDownBroker('http')).toBe(false);
    });

    it('a marker forces teardown even for a non-signal reason', () => {
      vi.stubEnv('HOTSHEET_TERMINAL_SUPERVISOR', '1');
      markQuitIntended();
      expect(shouldTearDownBroker('http')).toBe(true);
    });
  });

  describe('adversarial: a stale marker cleared at startup must not tear down an accidental kill', () => {
    it('supervised: leftover marker → clear (startup) → external SIGTERM survives', () => {
      vi.stubEnv('HOTSHEET_TERMINAL_SUPERVISOR', '1');
      // A prior real quit left a marker behind (real quit → no respawn, so it persists).
      writeFileSync(marker, 'quit\n', 'utf-8');
      // Fresh run clears it at startup (cli.ts) …
      clearQuitIntent();
      // … so a subsequent accidental SIGTERM is correctly treated as respawnable.
      expect(shouldTearDownBroker('SIGTERM')).toBe(false);
    });
  });
});
