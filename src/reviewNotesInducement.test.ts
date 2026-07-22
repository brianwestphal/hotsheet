import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  _resetGlassboxInstructionsCacheForTests,
  buildReviewNotesSection,
  getGlassboxNoteInstructions,
} from './reviewNotesInducement.js';

// HS-9221 (docs/110) — the inducement section that opts a project into emitting
// Glassbox `.pr-notes/` review notes from the worklist.
// HS-9371 — the probe understands the desktop-launcher quirk (`--browser`
// fallback form) and distinguishes "not on PATH" from "installed but too old".

const isExecutableOnPathMock = vi.hoisted(() => vi.fn<(name: string) => boolean>());
const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock('./utils/isExecutableOnPath.js', () => ({ isExecutableOnPath: isExecutableOnPathMock }));
vi.mock('child_process', () => ({ execFileSync: execFileSyncMock }));

describe('buildReviewNotesSection (HS-9221 / HS-9371)', () => {
  it('returns [] when the project has not opted in (default off)', () => {
    expect(buildReviewNotesSection(false, { kind: 'ok', text: 'whatever', browserPrefix: false })).toEqual([]);
    expect(buildReviewNotesSection(false, { kind: 'not-on-path' })).toEqual([]);
    expect(buildReviewNotesSection(false, null)).toEqual([]);
  });

  it('returns [] when the probe was skipped (null)', () => {
    expect(buildReviewNotesSection(true, null)).toEqual([]);
  });

  it('injects the ticket-id wrapper + the verbatim Glassbox instructions when enabled', () => {
    const text = '# Emitting AI review notes\n\nGlassbox-authored canonical text.';
    const out = buildReviewNotesSection(true, { kind: 'ok', text, browserPrefix: false }).join('\n');

    expect(out).toContain('## AI Review Notes (`.pr-notes/`)');
    // Hot Sheet's only original prose: the ticket-id threading wrapper.
    expect(out).toContain('--ticket <its HS-NNNN>');
    expect(out).toContain('--producer "Hot Sheet"');
    // The canonical text is injected verbatim (not forked).
    expect(out).toContain(text);
    expect(out).toContain('glassbox note instructions');
    // Not a fallback, and no machine-specific --browser note.
    expect(out).not.toContain('was not found on PATH');
    expect(out).not.toContain('--browser');
  });

  it('adds the machine-specific --browser note when only that form works (HS-9371)', () => {
    const text = '# Emitting AI review notes\n\nCanonical.';
    const out = buildReviewNotesSection(true, { kind: 'ok', text, browserPrefix: true }).join('\n');

    expect(out).toContain('prefix every note subcommand with `--browser`');
    expect(out).toContain('glassbox --browser note add');
    // Canonical text still injected verbatim after the note.
    expect(out).toContain(text);
  });

  it('injects the CLI-absent fallback nudge (not forked instructions) for not-on-path', () => {
    const out = buildReviewNotesSection(true, { kind: 'not-on-path' }).join('\n');

    expect(out).toContain('## AI Review Notes (`.pr-notes/`)');
    expect(out).toContain('--ticket <its HS-NNNN>');
    expect(out).toContain('The `glassbox` CLI was not found on PATH');
    expect(out).toContain('docs/20-ai-review-notes.md');
  });

  it('injects the too-old fallback (distinct from not-on-path) for probe-failed', () => {
    const out = buildReviewNotesSection(true, { kind: 'probe-failed' }).join('\n');

    expect(out).toContain('## AI Review Notes (`.pr-notes/`)');
    expect(out).toContain('installed but `glassbox note instructions` failed');
    expect(out).not.toContain('was not found on PATH');
    expect(out).toContain('docs/20-ai-review-notes.md');
  });
});

describe('getGlassboxNoteInstructions (HS-9221 / HS-9371)', () => {
  afterEach(() => {
    _resetGlassboxInstructionsCacheForTests();
    isExecutableOnPathMock.mockReset();
    execFileSyncMock.mockReset();
  });

  it('returns not-on-path without shelling out when the glassbox CLI is absent', () => {
    isExecutableOnPathMock.mockReturnValue(false);

    expect(getGlassboxNoteInstructions()).toEqual({ kind: 'not-on-path' });
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('runs `glassbox note instructions`, trims, and caches the output', () => {
    isExecutableOnPathMock.mockReturnValue(true);
    execFileSyncMock.mockReturnValue('  canonical instructions text  \n');

    expect(getGlassboxNoteInstructions()).toEqual({
      kind: 'ok',
      text: 'canonical instructions text',
      browserPrefix: false,
    });
    // Cached: a second call does not re-invoke the CLI.
    expect(getGlassboxNoteInstructions()).toEqual({
      kind: 'ok',
      text: 'canonical instructions text',
      browserPrefix: false,
    });
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock).toHaveBeenCalledWith('glassbox', ['note', 'instructions'], expect.any(Object));
  });

  it('falls back to the --browser form when the plain form fails (desktop-launcher quirk)', () => {
    isExecutableOnPathMock.mockReturnValue(true);
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === '--browser') return 'canonical via browser mode\n';
      throw new Error('Unknown option: note');
    });

    expect(getGlassboxNoteInstructions()).toEqual({
      kind: 'ok',
      text: 'canonical via browser mode',
      browserPrefix: true,
    });
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    expect(execFileSyncMock).toHaveBeenNthCalledWith(1, 'glassbox', ['note', 'instructions'], expect.any(Object));
    expect(execFileSyncMock).toHaveBeenNthCalledWith(
      2,
      'glassbox',
      ['--browser', 'note', 'instructions'],
      expect.any(Object),
    );
    // Cached — no further exec on subsequent calls.
    getGlassboxNoteInstructions();
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });

  it('returns probe-failed (cached) when both invocation forms throw', () => {
    isExecutableOnPathMock.mockReturnValue(true);
    execFileSyncMock.mockImplementation(() => {
      throw new Error('boom');
    });

    expect(getGlassboxNoteInstructions()).toEqual({ kind: 'probe-failed' });
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    // Exec-backed result is cached for the process — no repeated blocking probes.
    expect(getGlassboxNoteInstructions()).toEqual({ kind: 'probe-failed' });
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });

  it('returns probe-failed when both forms print nothing', () => {
    isExecutableOnPathMock.mockReturnValue(true);
    execFileSyncMock.mockReturnValue('   \n');

    expect(getGlassboxNoteInstructions()).toEqual({ kind: 'probe-failed' });
  });

  it('re-checks PATH after a not-on-path result so a later install is picked up', () => {
    isExecutableOnPathMock.mockReturnValue(false);
    expect(getGlassboxNoteInstructions()).toEqual({ kind: 'not-on-path' });

    // Glassbox gets installed mid-session — the next sync should find it
    // without a Hot Sheet restart.
    isExecutableOnPathMock.mockReturnValue(true);
    execFileSyncMock.mockReturnValue('now installed\n');
    expect(getGlassboxNoteInstructions()).toEqual({
      kind: 'ok',
      text: 'now installed',
      browserPrefix: false,
    });
  });
});
