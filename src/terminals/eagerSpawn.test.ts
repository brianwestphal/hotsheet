import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { eagerSpawnTerminals } from './eagerSpawn.js';
import {
  destroyAllTerminals,
  getTerminalStatus,
  type PtyFactory,
  type PtyLike,
  setPtyFactory,
  type SpawnArgs,
} from './registry.js';

class FakePty implements PtyLike {
  static spawned: FakePty[] = [];
  pid = 0; cols: number; rows: number;
  command: string;
  killed = false;
  private dataListeners = new Set<(s: string) => void>();
  private exitListeners = new Set<(e: { exitCode: number }) => void>();
  constructor(args: SpawnArgs) {
    this.cols = args.cols; this.rows = args.rows; this.command = args.command;
    this.pid = FakePty.spawned.length + 1;
    FakePty.spawned.push(this);
  }
  onData(listener: (s: string) => void) { this.dataListeners.add(listener); return { dispose: () => { this.dataListeners.delete(listener); } }; }
  onExit(listener: (e: { exitCode: number }) => void) { this.exitListeners.add(listener); return { dispose: () => { this.exitListeners.delete(listener); } }; }
  write(): void { /* ignore */ }
  resize(): void { /* ignore */ }
  kill(): void { this.killed = true; }
}

const factory: PtyFactory = (args) => new FakePty(args);

describe('eagerSpawnTerminals', () => {
  const cleanup: string[] = [];
  let restore: PtyFactory | undefined;

  beforeEach(() => {
    restore = setPtyFactory(factory);
    FakePty.spawned = [];
    cleanup.length = 0;
  });
  afterEach(() => {
    destroyAllTerminals();
    if (restore !== undefined) setPtyFactory(restore);
    for (const d of cleanup) rmSync(d, { recursive: true, force: true });
  });

  function dir(settings: Record<string, unknown>): string {
    const root = mkdtempSync(join(tmpdir(), 'hs-eager-'));
    const dataDir = join(root, '.hotsheet');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(settings));
    cleanup.push(root);
    return dataDir;
  }

  it('spawns only the terminals with lazy:false', () => {
    const d = dir({
      terminals: [
        { id: 'lazy-one', name: 'Lazy', command: '/bin/sh' },               // lazy by default
        { id: 'eager-one', name: 'Eager', command: '/bin/sh', lazy: false },
        { id: 'explicit-lazy', name: 'Also lazy', command: '/bin/sh', lazy: true },
      ],
    });
    eagerSpawnTerminals('s1', d);
    expect(FakePty.spawned).toHaveLength(1);
    expect(getTerminalStatus('s1', d, 'eager-one').state).toBe('alive');
    expect(getTerminalStatus('s1', d, 'lazy-one').state).toBe('not_spawned');
    expect(getTerminalStatus('s1', d, 'explicit-lazy').state).toBe('not_spawned');
  });

  it('is idempotent across repeated calls', () => {
    const d = dir({
      terminals: [{ id: 'eager-1', command: '/bin/sh', lazy: false }],
    });
    eagerSpawnTerminals('s1', d);
    eagerSpawnTerminals('s1', d);
    eagerSpawnTerminals('s1', d);
    expect(FakePty.spawned).toHaveLength(1);
  });

  it('does nothing when no terminals are configured as eager', () => {
    const d = dir({ terminals: [{ id: 'default', command: '/bin/sh' }] });
    eagerSpawnTerminals('s1', d);
    expect(FakePty.spawned).toHaveLength(0);
  });

  it('skips missing config (no terminals key) without crashing', () => {
    const d = dir({});
    expect(() => { eagerSpawnTerminals('s1', d); }).not.toThrow();
    expect(FakePty.spawned).toHaveLength(0);
  });

  // HS-6337: projects now default to empty `terminals` (no implicit default).
  // Without configured entries, eager-spawn must be a no-op.
  it('spawns nothing when terminals list is absent (HS-6337)', () => {
    const d = dir({});
    eagerSpawnTerminals('s1', d);
    expect(FakePty.spawned).toHaveLength(0);
  });
});
