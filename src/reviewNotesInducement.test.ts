import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  _resetGlassboxInstructionsCacheForTests,
  buildReviewNotesSection,
  DIRECT_AUTHORING_INSTRUCTIONS,
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

  // HS-9376 — glassbox is only needed for VIEWING notes; without a working CLI
  // the section must still enable GENERATION via direct SARIF authoring.
  it('injects the direct-authoring instructions (not a completion-note nudge) for not-on-path', () => {
    const out = buildReviewNotesSection(true, { kind: 'not-on-path' }).join('\n');

    expect(out).toContain('## AI Review Notes (`.pr-notes/`)');
    expect(out).toContain('--ticket <its HS-NNNN>');
    expect(out).toContain('The `glassbox` CLI was not found on PATH');
    expect(out).toContain('only needed for *viewing*');
    // The full self-contained on-disk contract (Glassbox docs/20 §20.2).
    expect(out).toContain('.pr-notes/notes/<repo-relative source path>.000000.sarif');
    expect(out).toContain('"ruleId": "review-note"');
    expect(out).toContain('prNoteAnchor/v1');
    expect(out).toContain('rationale|proof|assumption|alternative-considered|risk|test-evidence');
    expect(out).toContain('workItemUris');
    // HS-9377 — diagram-as-proof artifacts: Mermaid SOURCE attached, never
    // rendered images / ASCII art.
    expect(out).toContain('Mermaid SOURCE');
    expect(out).toContain('.pr-notes/artifacts/');
    expect(out).toContain('attachments');
    // No degradation to "record it in the ticket note instead".
    expect(out).not.toContain('completion note instead');
  });

  it('injects the same direct-authoring instructions (distinct preamble) for probe-failed', () => {
    const out = buildReviewNotesSection(true, { kind: 'probe-failed' }).join('\n');

    expect(out).toContain('## AI Review Notes (`.pr-notes/`)');
    expect(out).toContain('does not support `note` subcommands');
    expect(out).not.toContain('was not found on PATH');
    expect(out).toContain('only needed for *viewing*');
    expect(out).toContain('.pr-notes/notes/<repo-relative source path>.000000.sarif');
    expect(out).toContain('"ruleId": "review-note"');
    expect(out).not.toContain('completion note instead');
  });

  it('the ok path does NOT include the direct-authoring template (canonical text wins)', () => {
    const out = buildReviewNotesSection(true, { kind: 'ok', text: 'canonical', browserPrefix: false }).join('\n');
    expect(out).not.toContain('.pr-notes/notes/<repo-relative source path>.000000.sarif');
  });

  it('a file authored per the template is read back by Hot Sheet\'s own §111 proof reader', async () => {
    // The template must produce files the ecosystem actually consumes — this is
    // the direct-generation analogue of the HS-9371 live-CLI guard.
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { readReviewProofForTicket } = await import('./reviewNotes/prNotesReader.js');

    const root = mkdtempSync(join(tmpdir(), 'hs-prnotes-'));
    try {
      // Exactly the template shape from DIRECT_AUTHORING_INSTRUCTIONS, filled in.
      const log = {
        $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
        version: '2.1.0',
        runs: [{
          tool: { driver: { name: 'Claude Code', rules: [{ id: 'review-note', name: 'ReviewNote', shortDescription: { text: 'AI-authored, line-anchored review note.' } }] } },
          versionControlProvenance: [{ revisionId: 'abc123', branch: 'main' }],
          results: [{
            ruleId: 'review-note',
            ruleIndex: 0,
            kind: 'informational',
            level: 'none',
            guid: '3f2c8f60-0000-4000-8000-000000000001',
            message: { text: 'Chose a probe over a flag: **rationale**.', markdown: 'Chose a probe over a flag: **rationale**.' },
            locations: [{ physicalLocation: { artifactLocation: { uri: 'src/api/client.ts' }, region: { startLine: 12, endLine: 18, snippet: { text: 'const x = 1;' } } } }],
            properties: { tags: ['rationale'] },
            workItemUris: ['HS-1234'],
            partialFingerprints: { 'prNoteAnchor/v1': 'deadbeefdeadbeefdeadbeefdeadbeef' },
            // HS-9377 — a Mermaid-source proof artifact attached per the template.
            attachments: [{ artifactLocation: { uri: '.pr-notes/artifacts/claim-flow.mmd' } }],
          }],
        }],
      };
      const shardDir = join(root, '.pr-notes', 'notes', 'src', 'api');
      mkdirSync(shardDir, { recursive: true });
      writeFileSync(join(shardDir, 'client.ts.000000.sarif'), JSON.stringify(log, null, 2), 'utf-8');

      const notes = await readReviewProofForTicket(root, 'HS-1234');
      expect(notes).toHaveLength(1);
      expect(notes[0].file).toBe('src/api/client.ts');
      // HS-9377 — the attached Mermaid-source artifact surfaces (as a text kind).
      expect(notes[0].attachments).toEqual([
        expect.objectContaining({ uri: '.pr-notes/artifacts/claim-flow.mmd', kind: 'text' }),
      ]);
      // Word-boundary ticket matching still applies (HS-123 must not match).
      expect(await readReviewProofForTicket(root, 'HS-123')).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('documented fingerprint recipe matches the Glassbox algorithm (sha256 of normalized lines, first 32 hex)', async () => {
    // Pin the algorithm the instructions describe: trim each anchored line,
    // collapse inner whitespace, join with \n (no trailing newline), sha256 → 32.
    const { createHash } = await import('crypto');
    const slice = ['  const x =  1;', '\treturn   x;'];
    const normalized = slice.map(l => l.trim().replace(/\s+/g, ' ')).join('\n');
    const fp = createHash('sha256').update(normalized).digest('hex').slice(0, 32);
    expect(fp).toHaveLength(32);
    expect(normalized).toBe('const x = 1;\nreturn x;');
    // The injected text must describe exactly this recipe.
    const text = DIRECT_AUTHORING_INSTRUCTIONS.join('\n');
    expect(text).toContain('first 32 hex chars of the SHA-256');
    expect(text).toContain('NO trailing newline');
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
