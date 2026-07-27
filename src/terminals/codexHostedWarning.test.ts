// HS-9446 — the un-hosted codex terminal warning (docs/129 §129.5).
import { afterEach, describe, expect, it, vi } from 'vitest';

import { _resetCodexHostedWarningsForTesting, isUnhostedCodexLaunch, noteUnhostedCodexLaunch } from './codexHostedWarning.js';

const base = { modelB: true, driveEnabled: true, aiTool: 'codex', command: 'codex' };

afterEach(() => { _resetCodexHostedWarningsForTesting(); });

describe('isUnhostedCodexLaunch', () => {
  it('fires for a plain `codex` launch while model-B + the drive are on', () => {
    expect(isUnhostedCodexLaunch(base)).toBe(true);
  });

  it('does NOT fire for the daemon-hosted launch (the normal model-B case)', () => {
    expect(isUnhostedCodexLaunch({ ...base, command: "codex --remote 'unix:///s.sock' -C '/proj'" })).toBe(false);
  });

  it('does not fire when either toggle is off — nothing was expected to host a thread', () => {
    expect(isUnhostedCodexLaunch({ ...base, modelB: false })).toBe(false);
    expect(isUnhostedCodexLaunch({ ...base, driveEnabled: false })).toBe(false);
  });

  it('does not fire for a non-codex project, whatever the command', () => {
    expect(isUnhostedCodexLaunch({ ...base, aiTool: 'claude' })).toBe(false);
    expect(isUnhostedCodexLaunch({ ...base, aiTool: '' })).toBe(false);
    expect(isUnhostedCodexLaunch({ ...base, aiTool: '  Codex  ' })).toBe(true); // trimmed + case-insensitive
  });

  // The per-project daemon-ensure gate can't tell these apart; the command check must.
  it('does not fire for a non-codex TERMINAL inside a codex project', () => {
    expect(isUnhostedCodexLaunch({ ...base, command: 'btop' })).toBe(false);
    expect(isUnhostedCodexLaunch({ ...base, command: '/bin/zsh' })).toBe(false);
  });

  it('matches `codex` as a whole word only', () => {
    expect(isUnhostedCodexLaunch({ ...base, command: 'codex-notes' })).toBe(false);
    expect(isUnhostedCodexLaunch({ ...base, command: '/x/codexy/run' })).toBe(false);
    expect(isUnhostedCodexLaunch({ ...base, command: 'env X=1 codex' })).toBe(true); // template-expanded
  });
});

describe('noteUnhostedCodexLaunch', () => {
  it('logs once per (project, terminal), not on every respawn', () => {
    const log = vi.fn().mockResolvedValue(undefined);
    expect(noteUnhostedCodexLaunch('/p/.hotsheet', 'ai', base, { log })).toBe(true);
    expect(noteUnhostedCodexLaunch('/p/.hotsheet', 'ai', base, { log })).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    const [summary, detail] = log.mock.calls[0] as [string, string];
    expect(summary).toContain('ai');
    expect(detail).toContain('restart this terminal');
  });

  it('tracks each terminal and project separately', () => {
    const log = vi.fn().mockResolvedValue(undefined);
    expect(noteUnhostedCodexLaunch('/p/.hotsheet', 'ai', base, { log })).toBe(true);
    expect(noteUnhostedCodexLaunch('/p/.hotsheet', 'other', base, { log })).toBe(true);
    expect(noteUnhostedCodexLaunch('/q/.hotsheet', 'ai', base, { log })).toBe(true);
    expect(log).toHaveBeenCalledTimes(3);
  });

  it('writes nothing when the launch is fine', () => {
    const log = vi.fn().mockResolvedValue(undefined);
    expect(noteUnhostedCodexLaunch('/p/.hotsheet', 'ai', { ...base, command: 'codex --remote x' }, { log })).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it('never rejects out of the fire-and-forget path (a failed log must not break a spawn)', async () => {
    const log = vi.fn().mockRejectedValue(new Error('db down'));
    expect(noteUnhostedCodexLaunch('/p/.hotsheet', 'ai', base, { log })).toBe(true);
    await new Promise((r) => setImmediate(r)); // an unhandled rejection would fail the run
  });
});
