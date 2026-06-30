import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  _resetGlassboxInstructionsCacheForTests,
  buildReviewNotesSection,
  getGlassboxNoteInstructions,
} from './reviewNotesInducement.js';

// HS-9221 (docs/110) — the inducement section that opts a project into emitting
// Glassbox `.pr-notes/` review notes from the worklist.

const isExecutableOnPathMock = vi.hoisted(() => vi.fn<(name: string) => boolean>());
const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock('./utils/isExecutableOnPath.js', () => ({ isExecutableOnPath: isExecutableOnPathMock }));
vi.mock('child_process', () => ({ execFileSync: execFileSyncMock }));

describe('buildReviewNotesSection (HS-9221)', () => {
  it('returns [] when the project has not opted in (default off)', () => {
    expect(buildReviewNotesSection(false, 'whatever')).toEqual([]);
    expect(buildReviewNotesSection(false, null)).toEqual([]);
  });

  it('injects the ticket-id wrapper + the verbatim Glassbox instructions when enabled', () => {
    const instructions = '# Emitting AI review notes\n\nGlassbox-authored canonical text.';
    const out = buildReviewNotesSection(true, instructions).join('\n');

    expect(out).toContain('## AI Review Notes (`.pr-notes/`)');
    // Hot Sheet's only original prose: the ticket-id threading wrapper.
    expect(out).toContain('--ticket <its HS-NNNN>');
    expect(out).toContain('--producer "Hot Sheet"');
    // The canonical text is injected verbatim (not forked).
    expect(out).toContain(instructions);
    expect(out).toContain('glassbox note instructions');
    // Not the CLI-absent fallback.
    expect(out).not.toContain('was not found on PATH');
  });

  it('injects the fallback nudge (not forked instructions) when the CLI is absent', () => {
    const out = buildReviewNotesSection(true, null).join('\n');

    expect(out).toContain('## AI Review Notes (`.pr-notes/`)');
    expect(out).toContain('--ticket <its HS-NNNN>');
    expect(out).toContain('The `glassbox` CLI was not found on PATH');
    expect(out).toContain('docs/20-ai-review-notes.md');
  });
});

describe('getGlassboxNoteInstructions (HS-9221)', () => {
  afterEach(() => {
    _resetGlassboxInstructionsCacheForTests();
    isExecutableOnPathMock.mockReset();
    execFileSyncMock.mockReset();
  });

  it('returns null without shelling out when the glassbox CLI is absent', () => {
    isExecutableOnPathMock.mockReturnValue(false);

    expect(getGlassboxNoteInstructions()).toBeNull();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('runs `glassbox note instructions`, trims, and caches the output', () => {
    isExecutableOnPathMock.mockReturnValue(true);
    execFileSyncMock.mockReturnValue('  canonical instructions text  \n');

    expect(getGlassboxNoteInstructions()).toBe('canonical instructions text');
    // Cached: a second call does not re-invoke the CLI.
    expect(getGlassboxNoteInstructions()).toBe('canonical instructions text');
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock).toHaveBeenCalledWith('glassbox', ['note', 'instructions'], expect.any(Object));
  });

  it('returns null when the CLI call throws', () => {
    isExecutableOnPathMock.mockReturnValue(true);
    execFileSyncMock.mockImplementation(() => { throw new Error('boom'); });

    expect(getGlassboxNoteInstructions()).toBeNull();
  });

  it('returns null when the CLI prints nothing', () => {
    isExecutableOnPathMock.mockReturnValue(true);
    execFileSyncMock.mockReturnValue('   \n');

    expect(getGlassboxNoteInstructions()).toBeNull();
  });
});
