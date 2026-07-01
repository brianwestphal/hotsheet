// HS-9246 — the drawer defaults to the Claude tab on a new project AND on the
// first open of any project since launch (only when the project has a Claude
// tab); otherwise it restores the saved tab. These tests walk the decision
// matrix, not just each branch from a clean state.

import { describe, expect, it } from 'vitest';

import {
  chooseDrawerActiveTab,
  CLAUDE_COMMAND_SENTINEL,
  claudeTabIdFromConfigs,
} from './drawerActiveTab.js';

describe('claudeTabIdFromConfigs', () => {
  it('finds the Claude terminal among configured tabs by its command sentinel', () => {
    const configs = {
      configured: [
        { id: 'shell', command: 'zsh' },
        { id: 'claude', command: CLAUDE_COMMAND_SENTINEL },
      ],
      dynamic: [],
    };
    expect(claudeTabIdFromConfigs(configs)).toBe('terminal:claude');
  });

  it('finds a Claude terminal that lives in the dynamic list', () => {
    const configs = {
      configured: [{ id: 'shell', command: 'zsh' }],
      dynamic: [{ id: 'dyn-1', command: CLAUDE_COMMAND_SENTINEL }],
    };
    expect(claudeTabIdFromConfigs(configs)).toBe('terminal:dyn-1');
  });

  it('ignores the user-facing name — identity is the command sentinel', () => {
    // A terminal renamed away from "Claude" is still the Claude terminal.
    const configs = {
      configured: [{ id: 'main', command: CLAUDE_COMMAND_SENTINEL }],
      dynamic: [],
    };
    expect(claudeTabIdFromConfigs(configs)).toBe('terminal:main');
  });

  it('returns null when no terminal runs the Claude command', () => {
    const configs = { configured: [{ id: 'shell', command: 'zsh' }], dynamic: [] };
    expect(claudeTabIdFromConfigs(configs)).toBeNull();
  });

  it('returns null for null / empty configs', () => {
    expect(claudeTabIdFromConfigs(null)).toBeNull();
    expect(claudeTabIdFromConfigs({ configured: [], dynamic: [] })).toBeNull();
  });
});

describe('chooseDrawerActiveTab', () => {
  const CLAUDE = 'terminal:claude';

  it('new project WITH a Claude tab → selects the Claude tab', () => {
    expect(chooseDrawerActiveTab({
      savedTab: null, savedTabExists: false, claudeTabId: CLAUDE, firstOpenSinceLaunch: true,
    })).toBe(CLAUDE);
  });

  it('new project WITHOUT a Claude tab → falls back to the commands log', () => {
    expect(chooseDrawerActiveTab({
      savedTab: null, savedTabExists: false, claudeTabId: null, firstOpenSinceLaunch: true,
    })).toBe('commands-log');
  });

  it('first open since launch overrides an existing saved tab to Claude', () => {
    // The user previously left the commands-log tab selected, but on the first
    // open after relaunch we still surface Claude.
    expect(chooseDrawerActiveTab({
      savedTab: 'commands-log', savedTabExists: true, claudeTabId: CLAUDE, firstOpenSinceLaunch: true,
    })).toBe(CLAUDE);
  });

  it('subsequent open (same launch) restores the saved tab, NOT Claude', () => {
    // Second open of the project this launch: honor whatever the user last chose.
    expect(chooseDrawerActiveTab({
      savedTab: 'terminal:shell', savedTabExists: true, claudeTabId: CLAUDE, firstOpenSinceLaunch: false,
    })).toBe('terminal:shell');
  });

  it('first open since launch but NO Claude tab → restores the saved tab', () => {
    expect(chooseDrawerActiveTab({
      savedTab: 'terminal:shell', savedTabExists: true, claudeTabId: null, firstOpenSinceLaunch: true,
    })).toBe('terminal:shell');
  });

  it('a saved terminal tab that no longer exists falls back to the commands log', () => {
    // Not first-open + no Claude tab: the stale `terminal:<id>` is dropped.
    expect(chooseDrawerActiveTab({
      savedTab: 'terminal:gone', savedTabExists: false, claudeTabId: null, firstOpenSinceLaunch: false,
    })).toBe('commands-log');
  });

  it('a stale saved tab on first-open-since-launch still prefers Claude', () => {
    expect(chooseDrawerActiveTab({
      savedTab: 'terminal:gone', savedTabExists: false, claudeTabId: CLAUDE, firstOpenSinceLaunch: true,
    })).toBe(CLAUDE);
  });

  // Multi-step sequence: relaunch → first open picks Claude → user switches to
  // shell (saved) → reopen same launch restores shell → relaunch → Claude again.
  it('sequence: first-open→Claude, reopen→saved restore, relaunch→Claude again', () => {
    const claudeArgs = { claudeTabId: CLAUDE } as const;
    // Relaunch, first open, no saved tab yet:
    expect(chooseDrawerActiveTab({ savedTab: null, savedTabExists: false, firstOpenSinceLaunch: true, ...claudeArgs })).toBe(CLAUDE);
    // User switched to the shell tab (now saved); reopen later THIS launch:
    expect(chooseDrawerActiveTab({ savedTab: 'terminal:shell', savedTabExists: true, firstOpenSinceLaunch: false, ...claudeArgs })).toBe('terminal:shell');
    // After a relaunch, first open again → Claude, overriding the saved shell tab:
    expect(chooseDrawerActiveTab({ savedTab: 'terminal:shell', savedTabExists: true, firstOpenSinceLaunch: true, ...claudeArgs })).toBe(CLAUDE);
  });
});
