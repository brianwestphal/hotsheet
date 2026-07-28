/**
 * HS-9459 — `defaultProjectName` is the single definition of "what you get when
 * `appName` is empty", shared by `projects.ts` (which resolves the real name),
 * `routes/pages.tsx` (server-rendered placeholder) and `settingsDialog.tsx`
 * (placeholder after a project switch). The bug was a hardcoded
 * `placeholder="Hot Sheet"` that matched none of them.
 */
import { describe, expect, it } from 'vitest';

import { defaultProjectName } from './defaultProjectName.js';

describe('defaultProjectName (HS-9459)', () => {
  it('uses the project directory basename', () => {
    expect(defaultProjectName('/Users/me/Documents/hotsheet')).toBe('hotsheet');
    expect(defaultProjectName('/Users/me/Documents/glassbox')).toBe('glassbox');
  });

  it('strips a trailing .hotsheet data dir', () => {
    // Callers pass either the project dir or its `.hotsheet/` data dir.
    expect(defaultProjectName('/Users/me/Documents/hotsheet/.hotsheet')).toBe('hotsheet');
    expect(defaultProjectName('/Users/me/Documents/hotsheet/.hotsheet/')).toBe('hotsheet');
  });

  it('is NOT the literal "Hot Sheet" for a normal project', () => {
    // The exact defect: the placeholder promised "Hot Sheet", but leaving the
    // field empty gives the directory name. Only a directory actually named
    // "Hot Sheet" produces it.
    expect(defaultProjectName('/Users/me/Documents/hotsheet')).not.toBe('Hot Sheet');
    expect(defaultProjectName('/Users/me/Documents/Hot Sheet')).toBe('Hot Sheet');
  });

  it('handles Windows paths (the inline version did not)', () => {
    // The previous inline derivation split on '/' only, so a Windows dataDir
    // stripped nothing and split nothing — the whole path became the name.
    expect(defaultProjectName('C:\\Users\\me\\Documents\\hotsheet')).toBe('hotsheet');
    expect(defaultProjectName('C:\\Users\\me\\Documents\\hotsheet\\.hotsheet')).toBe('hotsheet');
    expect(defaultProjectName('C:\\Users\\me\\Documents\\hotsheet\\.hotsheet\\')).toBe('hotsheet');
  });

  it('ignores a trailing separator', () => {
    expect(defaultProjectName('/Users/me/Documents/hotsheet/')).toBe('hotsheet');
    expect(defaultProjectName('/Users/me/Documents/hotsheet//')).toBe('hotsheet');
  });

  it('handles names with spaces, dots and unicode', () => {
    expect(defaultProjectName('/Users/me/My Project')).toBe('My Project');
    expect(defaultProjectName('/Users/me/site.com')).toBe('site.com');
    expect(defaultProjectName('/Users/me/проект')).toBe('проект');
  });

  it('falls back to the input when there is nothing to split', () => {
    // Matches the previous `?? absDataDir` fallback rather than returning ''.
    expect(defaultProjectName('hotsheet')).toBe('hotsheet');
    expect(defaultProjectName('/')).toBe('/');
    expect(defaultProjectName('')).toBe('');
  });

  it('does not mistake a directory merely containing ".hotsheet" for the data dir', () => {
    // Only a trailing `.hotsheet` SEGMENT is stripped.
    expect(defaultProjectName('/Users/me/my.hotsheet')).toBe('my.hotsheet');
    expect(defaultProjectName('/Users/me/.hotsheet-backup')).toBe('.hotsheet-backup');
  });
});
