import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { parseVersionHeader, SKILL_VERSION, updateFile } from './skills.js';

describe('parseVersionHeader', () => {
  it('extracts version from current format', () => {
    expect(parseVersionHeader('<!-- hotsheet-skill-version: 2 -->')).toBe(2);
  });

  it('extracts version from legacy format with port', () => {
    expect(parseVersionHeader('<!-- hotsheet-skill-version: 1 port: 4174 -->')).toBe(1);
  });

  it('returns null for content without a version header', () => {
    expect(parseVersionHeader('no version here')).toBeNull();
  });

  it('returns null for malformed header', () => {
    expect(parseVersionHeader('<!-- hotsheet-skill-version: abc -->')).toBeNull();
  });

  it('works with version header embedded in larger content', () => {
    const content = '---\nname: test\n---\n<!-- hotsheet-skill-version: 3 -->\n\nBody text';
    expect(parseVersionHeader(content)).toBe(3);
  });
});

describe('updateFile', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = join(tmpdir(), `hs-skills-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes new file if not exists', () => {
    const path = join(tempDir, 'new.md');
    const result = updateFile(path, `<!-- hotsheet-skill-version: ${SKILL_VERSION} -->\nContent`);
    expect(result).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toContain('Content');
  });

  it('overwrites file with lower version', () => {
    const path = join(tempDir, 'old.md');
    writeFileSync(path, '<!-- hotsheet-skill-version: 1 -->\nOld content');
    const result = updateFile(path, `<!-- hotsheet-skill-version: ${SKILL_VERSION} -->\nNew content`);
    expect(result).toBe(true);
    expect(readFileSync(path, 'utf-8')).toContain('New content');
  });

  it('skips file with same version', () => {
    const path = join(tempDir, 'same.md');
    writeFileSync(path, `<!-- hotsheet-skill-version: ${SKILL_VERSION} -->\nExisting`);
    const result = updateFile(path, `<!-- hotsheet-skill-version: ${SKILL_VERSION} -->\nReplacement`);
    expect(result).toBe(false);
    expect(readFileSync(path, 'utf-8')).toContain('Existing');
  });

  it('skips file with higher version', () => {
    const path = join(tempDir, 'higher.md');
    writeFileSync(path, `<!-- hotsheet-skill-version: ${SKILL_VERSION + 1} -->\nFuture`);
    const result = updateFile(path, `<!-- hotsheet-skill-version: ${SKILL_VERSION} -->\nCurrent`);
    expect(result).toBe(false);
    expect(readFileSync(path, 'utf-8')).toContain('Future');
  });

  it('overwrites file with legacy port-based format (lower version)', () => {
    const path = join(tempDir, 'legacy.md');
    writeFileSync(path, '<!-- hotsheet-skill-version: 1 port: 4174 -->\nLegacy');
    const result = updateFile(path, `<!-- hotsheet-skill-version: ${SKILL_VERSION} -->\nUpdated`);
    expect(result).toBe(true);
    expect(readFileSync(path, 'utf-8')).toContain('Updated');
  });

  it('overwrites file with no version header', () => {
    const path = join(tempDir, 'noheader.md');
    writeFileSync(path, 'No header here');
    const result = updateFile(path, `<!-- hotsheet-skill-version: ${SKILL_VERSION} -->\nNew`);
    expect(result).toBe(true);
    expect(readFileSync(path, 'utf-8')).toContain('New');
  });
});
