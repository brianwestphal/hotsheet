// HS-9397 (docs/123 §123.7) — reattach detection against hand-crafted registry
// sessions (no PTY spawns; `pty` only needs to be non-null).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { codexReattachAvailable } from './codexReattach.js';
import { sessionKey, sessions } from './registry/sessionStore.js';
import type { SessionState } from './registry/types.js';

const SECRET = 'reattach-test-secret';
const ATTACH = "codex resume th-new --remote 'unix:///s.sock'";

let dir: string;
let dataDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hs-reattach-'));
  dataDir = join(dir, '.hotsheet');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ ai_tool: 'codex' }), 'utf-8');
});

afterEach(() => {
  for (const key of [...sessions.keys()]) if (key.startsWith(`${SECRET}::`)) sessions.delete(key);
  rmSync(dir, { recursive: true, force: true });
});

function putSession(terminalId: string, overrides: Partial<SessionState>): void {
  // Only the fields the detector reads; the rest of SessionState is irrelevant here.
  sessions.set(sessionKey(SECRET, terminalId), {
    pty: {} as SessionState['pty'],
    resolvedCommand: 'codex',
    configOverride: null,
    ...overrides,
  } as SessionState);
}

/** Fresh resolution stand-in: what `resolveTerminalCommand` would produce now. */
const resolveTo = (command: string) => () => ({ command, cwd: dir });

describe('codexReattachAvailable', () => {
  it('true for a live plain-codex terminal whose project now resolves to the attach form', () => {
    putSession('t1', { resolvedCommand: 'codex' });
    expect(codexReattachAvailable(SECRET, dataDir, 't1', { attachCommand: () => ATTACH, resolve: resolveTo(ATTACH) })).toBe(true);
  });

  it('true for a terminal attached to an OLD thread after a reset (fresh attach differs)', () => {
    putSession('t1', { resolvedCommand: "codex resume th-old --remote 'unix:///s.sock'" });
    expect(codexReattachAvailable(SECRET, dataDir, 't1', { attachCommand: () => ATTACH, resolve: resolveTo(ATTACH) })).toBe(true);
  });

  it('true inside a template expansion (env prefix around the attach command)', () => {
    putSession('t1', { resolvedCommand: 'env X=1 codex' });
    expect(codexReattachAvailable(SECRET, dataDir, 't1', { attachCommand: () => ATTACH, resolve: resolveTo(`env X=1 ${ATTACH}`) })).toBe(true);
  });

  it('false when the terminal already launched with the current attach form', () => {
    putSession('t1', { resolvedCommand: ATTACH });
    expect(codexReattachAvailable(SECRET, dataDir, 't1', { attachCommand: () => ATTACH, resolve: resolveTo(ATTACH) })).toBe(false);
  });

  it('false when no attach command is currently emittable', () => {
    putSession('t1', { resolvedCommand: 'codex' });
    expect(codexReattachAvailable(SECRET, dataDir, 't1', { attachCommand: () => null, resolve: resolveTo('codex') })).toBe(false);
  });

  it('false when the fresh resolution differs but is NOT the attach form (unrelated config edit)', () => {
    putSession('t1', { resolvedCommand: 'htop' });
    expect(codexReattachAvailable(SECRET, dataDir, 't1', { attachCommand: () => ATTACH, resolve: resolveTo('btop') })).toBe(false);
  });

  it('false with no session, a dead pty, or no recorded launch resolution', () => {
    expect(codexReattachAvailable(SECRET, dataDir, 'missing', { attachCommand: () => ATTACH, resolve: resolveTo(ATTACH) })).toBe(false);
    putSession('dead', { pty: null, resolvedCommand: 'codex' });
    expect(codexReattachAvailable(SECRET, dataDir, 'dead', { attachCommand: () => ATTACH, resolve: resolveTo(ATTACH) })).toBe(false);
    putSession('unrecorded', { resolvedCommand: null });
    expect(codexReattachAvailable(SECRET, dataDir, 'unrecorded', { attachCommand: () => ATTACH, resolve: resolveTo(ATTACH) })).toBe(false);
  });
});
