// HS-9340 — the project-confined fs adapter for delegated ACP fs ops.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isInsideDir, makeProjectFsHandlers } from './acpFs.js';

describe('isInsideDir (HS-9340)', () => {
  it('accepts the root itself + descendants, rejects escapes', () => {
    expect(isInsideDir('/a/b', '/a/b')).toBe(true);
    expect(isInsideDir('/a/b', '/a/b/c.txt')).toBe(true);
    expect(isInsideDir('/a/b', '/a/b/nested/deep.txt')).toBe(true);
    expect(isInsideDir('/a/b', '/a/c.txt')).toBe(false);      // sibling
    expect(isInsideDir('/a/b', '/a/b/../c.txt')).toBe(false); // traversal out
    expect(isInsideDir('/a/b', '/etc/passwd')).toBe(false);   // absolute elsewhere
  });
});

describe('makeProjectFsHandlers (HS-9340)', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'acpfs-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('writes a file inside the project (creating parent dirs) and reads it back', async () => {
    const fs = makeProjectFsHandlers(root);
    const target = join(root, 'sub', 'dir', 'hello.txt');
    await fs.writeTextFile(target, 'hi from acp');
    expect(readFileSync(target, 'utf-8')).toBe('hi from acp');
    await expect(fs.readTextFile(target)).resolves.toBe('hi from acp');
  });

  it('rejects a write OUTSIDE the project directory', async () => {
    const fs = makeProjectFsHandlers(root);
    const outside = join(tmpdir(), 'acpfs-escape-should-not-exist.txt');
    await expect(fs.writeTextFile(outside, 'nope')).rejects.toThrow(/outside project/);
  });

  it('rejects a read OUTSIDE the project directory', async () => {
    const fs = makeProjectFsHandlers(root);
    // A real file that exists but is outside the project → still refused.
    const outside = join(tmpdir(), `acpfs-outside-${String(Date.now())}.txt`);
    writeFileSync(outside, 'secret');
    try {
      await expect(fs.readTextFile(outside)).rejects.toThrow(/outside project/);
    } finally {
      rmSync(outside, { force: true });
    }
  });
});
