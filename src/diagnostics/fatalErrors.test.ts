// HS-9557 — the report a post-mortem reader will find in `startup.log`, and the
// exit contract that keeps these handlers from changing what the process does.
//
// The bug this guards is not "the format is wrong" — it is "there is no record
// at all", which is what the 2026-08-03 death left behind (HS-9561). So the
// tests assert the two things that make the record useful: that a fatal is
// WRITTEN, and that installing the handler still lets the process DIE.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetFatalErrorHandlersForTests,
  type FatalErrorHooks,
  type FatalKind,
  formatFatalReport,
  installFatalErrorHandlers,
} from './fatalErrors.js';

const MEM: NodeJS.MemoryUsage = {
  rss: 800 * 1024 * 1024,
  heapTotal: 200 * 1024 * 1024,
  heapUsed: 150 * 1024 * 1024,
  external: 2100 * 1024 * 1024,
  arrayBuffers: 120 * 1024 * 1024,
};

const CTX = { phase: 'post-startup: done', elapsedMs: 51_000, memory: MEM };

function joined(kind: FatalKind, value: unknown): string {
  return formatFatalReport(kind, value, CTX).join('\n');
}

describe('formatFatalReport', () => {
  it('records the message, the stack, the phase and the uptime', () => {
    const err = new Error('cluster handle used after close');
    err.stack = 'Error: cluster handle used after close\n    at getDbForDir (connection.ts:694)';
    const out = joined('uncaughtException', err);

    expect(out).toContain('uncaughtException');
    expect(out).toContain('Error: cluster handle used after close');
    expect(out).toContain('at getDbForDir (connection.ts:694)');
    // The phase is what turns "it died" into "it died doing X" — the startup log's
    // whole value proposition (HS-8704).
    expect(out).toContain('phase="post-startup: done"');
    expect(out).toContain('uptime=51000ms');
  });

  it('reports external memory, not just rss', () => {
    // docs/128: PGLite WASM heaps live in `external` and do NOT appear in rss, so
    // an rss-only report reads as healthy during exactly the deaths that matter.
    const out = joined('uncaughtException', new Error('boom'));
    expect(out).toContain('external=2100MB');
    expect(out).toContain('rss=800MB');
  });

  it('handles a thrown string without assuming .stack exists', () => {
    const out = joined('unhandledRejection', 'ECONNRESET');
    expect(out).toContain('non-Error value thrown: ECONNRESET');
  });

  it('serializes a thrown plain object', () => {
    const out = joined('unhandledRejection', { code: 'ENOSPC', path: '/tmp' });
    expect(out).toContain('"code":"ENOSPC"');
  });

  it('survives a value JSON.stringify cannot handle', () => {
    // A circular object must not turn the fatal handler into a second fatal.
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    expect(() => joined('unhandledRejection', circular)).not.toThrow();
    expect(joined('unhandledRejection', circular)).toContain('[object Object]');
  });

  it('surfaces an error cause, where a rethrow hides the real culprit', () => {
    const err = new Error('failed to open project', { cause: new Error('WASM trap') });
    expect(joined('uncaughtException', err)).toContain('caused by: Error: WASM trap');
  });

  it('names the rejection case distinctly from the exception case', () => {
    expect(joined('unhandledRejection', new Error('x'))).toContain('unhandledRejection');
    expect(joined('uncaughtException', new Error('x'))).toContain('uncaughtException');
  });
});

describe('installFatalErrorHandlers', () => {
  let handlers: Map<FatalKind, (value: unknown) => void>;
  let logged: string[];
  let exits: number[];

  function install(over: Partial<FatalErrorHooks> = {}): void {
    installFatalErrorHandlers({
      log: (m) => { logged.push(m); },
      exit: (c) => { exits.push(c); },
      on: (event, handler) => { handlers.set(event, handler); },
      memory: () => MEM,
      phase: () => 'serving',
      elapsedMs: () => 1234,
      ...over,
    });
  }

  beforeEach(() => {
    _resetFatalErrorHandlersForTests();
    handlers = new Map();
    logged = [];
    exits = [];
  });

  it('subscribes to both fatal events', () => {
    install();
    expect([...handlers.keys()].sort()).toEqual(['uncaughtException', 'unhandledRejection']);
  });

  it('writes the report and then exits 1 on an uncaught exception', () => {
    install();
    handlers.get('uncaughtException')?.(new Error('kaboom'));

    expect(logged.join('\n')).toContain('kaboom');
    // Installing a listener SUPPRESSES Node's default print-and-exit, so failing
    // to exit here would silently convert a crash into a process limping on in an
    // unknown state — strictly worse than the blackout this replaces.
    expect(exits).toEqual([1]);
  });

  it('exits on an unhandled rejection too, matching Node’s default `throw` mode', () => {
    install();
    handlers.get('unhandledRejection')?.(new Error('nope'));
    expect(exits).toEqual([1]);
  });

  it('still exits when writing the report itself fails', () => {
    // A full disk must not leave the process alive holding the port and the
    // project locks — the exact state the watchdog exists to prevent.
    install({ log: () => { throw new Error('ENOSPC'); } });
    handlers.get('uncaughtException')?.(new Error('kaboom'));
    expect(exits).toEqual([1]);
  });

  it('still exits when collecting the diagnostics context throws', () => {
    install({ memory: () => { throw new Error('no'); } });
    handlers.get('uncaughtException')?.(new Error('kaboom'));
    expect(exits).toEqual([1]);
  });

  it('is idempotent — a second install does not double-register', () => {
    const on = vi.fn();
    install({ on });
    install({ on });
    expect(on).toHaveBeenCalledTimes(2); // two events, from the FIRST install only
  });
});
