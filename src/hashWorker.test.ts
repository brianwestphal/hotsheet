/**
 * HS-8728 — unit coverage for the off-thread attachment hasher + its in-process
 * fallback.
 */
import { createHash } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _resetHashWorkerForTests, hashFileInProcess, hashFileOffThread, terminateHashWorker } from './hashWorker.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hs-hashworker-')); });
afterEach(async () => {
  await terminateHashWorker();
  _resetHashWorkerForTests();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
});

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('hashFileInProcess (fallback)', () => {
  it('computes the correct sha + size', async () => {
    const p = join(dir, 'a.bin');
    const data = Buffer.from('hello hotsheet attachment');
    writeFileSync(p, data);
    const r = await hashFileInProcess(p);
    expect(r.sha).toBe(sha256(data));
    expect(r.size).toBe(data.length);
  });

  it('handles a large multi-chunk file', async () => {
    const p = join(dir, 'big.bin');
    const data = Buffer.alloc(5 * 1024 * 1024, 7); // 5 MB → multiple stream chunks
    writeFileSync(p, data);
    const r = await hashFileInProcess(p);
    expect(r.sha).toBe(sha256(data));
    expect(r.size).toBe(data.length);
  });
});

describe('hashFileOffThread (worker)', () => {
  it('matches the in-process hash for the same file', async () => {
    const p = join(dir, 'b.bin');
    const data = Buffer.from('worker-thread hashing path');
    writeFileSync(p, data);
    const r = await hashFileOffThread(p);
    expect(r.sha).toBe(sha256(data));
    expect(r.size).toBe(data.length);
  });

  it('hashes several files correctly (reuses the long-lived worker)', async () => {
    const inputs = ['one', 'two', 'three', 'four'];
    const results = await Promise.all(inputs.map((s, i) => {
      const p = join(dir, `f${i.toString()}.bin`);
      writeFileSync(p, s);
      return hashFileOffThread(p);
    }));
    results.forEach((r, i) => {
      expect(r.sha).toBe(sha256(inputs[i]));
      expect(r.size).toBe(inputs[i].length);
    });
  });

  it('rejects on a missing file (per-file error propagates)', async () => {
    await expect(hashFileOffThread(join(dir, 'does-not-exist.bin'))).rejects.toThrow();
  });

  it('an empty file hashes to the empty-input sha', async () => {
    const p = join(dir, 'empty.bin');
    writeFileSync(p, '');
    const r = await hashFileOffThread(p);
    expect(r.sha).toBe(sha256(Buffer.alloc(0)));
    expect(r.size).toBe(0);
  });
});
