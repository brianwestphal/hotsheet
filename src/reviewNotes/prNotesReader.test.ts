import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readReviewProofForTicket } from './prNotesReader.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hs-9223-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Write a SARIF shard at `<root>/.pr-notes/notes/<name>` wrapping `results`. */
async function writeShard(name: string, results: unknown[]): Promise<void> {
  const file = join(root, '.pr-notes', 'notes', name);
  await mkdir(dirname(file), { recursive: true }); // name may carry a nested repo path
  await writeFile(file, JSON.stringify({ runs: [{ results }] }), 'utf-8');
}

function proofResult(ticket: string | string[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message: { text: 'Verified the export flow\nsecond line ignored' },
    level: 'none',
    rank: 50,
    locations: [{ physicalLocation: { artifactLocation: { uri: 'src/export.ts' }, region: { startLine: 42, endLine: 50 } } }],
    workItemUris: Array.isArray(ticket) ? ticket : [ticket],
    attachments: [
      { artifactLocation: { uri: '.pr-notes/artifacts/shot.png' }, description: { text: 'screenshot' } },
      { artifactLocation: { uri: '.pr-notes/artifacts/out.txt' } },
    ],
    properties: { tags: ['proof'] },
    ...over,
  };
}

describe('readReviewProofForTicket (HS-9223)', () => {
  it('surfaces a matching ticket note with its metadata + typed attachments', async () => {
    await writeShard('src/export.ts.000000.sarif', [proofResult('HS-1234')]);
    const notes = await readReviewProofForTicket(root, 'HS-1234');
    expect(notes).toHaveLength(1);
    const n = notes[0];
    expect(n.noteKind).toBe('proof');
    expect(n.file).toBe('src/export.ts');
    expect(n.startLine).toBe(42);
    expect(n.endLine).toBe(50);
    expect(n.summary).toBe('Verified the export flow'); // first line only
    expect(n.attachments).toEqual([
      { uri: '.pr-notes/artifacts/shot.png', kind: 'image', description: 'screenshot' },
      { uri: '.pr-notes/artifacts/out.txt', kind: 'text' },
    ]);
    expect(n.sourceFile).toBe('.pr-notes/notes/src/export.ts.000000.sarif');
  });

  it('excludes notes for OTHER tickets (no cross-ticket bleed)', async () => {
    await writeShard('a.sarif', [
      proofResult('HS-1234', { message: { text: 'mine' } }),
      proofResult('HS-9999', { message: { text: 'theirs' } }),
    ]);
    const notes = await readReviewProofForTicket(root, 'HS-1234');
    expect(notes).toHaveLength(1);
    expect(notes[0].summary).toBe('mine'); // only the HS-1234 note, not HS-9999's
  });

  it('NO false match: HS-12 must not match HS-123 / HS-1234 (word-boundary)', async () => {
    await writeShard('a.sarif', [proofResult('HS-123'), proofResult('HS-1234')]);
    expect(await readReviewProofForTicket(root, 'HS-12')).toHaveLength(0);
    // And the exact ids DO match their own notes.
    expect(await readReviewProofForTicket(root, 'HS-123')).toHaveLength(1);
    expect(await readReviewProofForTicket(root, 'HS-1234')).toHaveLength(1);
  });

  it('matches a ticket embedded in a work-item URL', async () => {
    await writeShard('a.sarif', [proofResult('https://tracker.example/browse/HS-1234')]);
    expect(await readReviewProofForTicket(root, 'HS-1234')).toHaveLength(1);
    expect(await readReviewProofForTicket(root, 'HS-123')).toHaveLength(0); // still boundary-safe
  });

  it('skips a malformed shard but still reads the valid ones', async () => {
    const dir = join(root, '.pr-notes', 'notes');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'broken.sarif'), '{ not valid json', 'utf-8');
    await writeShard('good.sarif', [proofResult('HS-1234')]);
    const notes = await readReviewProofForTicket(root, 'HS-1234');
    expect(notes).toHaveLength(1);
    expect(notes[0].sourceFile).toBe('.pr-notes/notes/good.sarif');
  });

  it('returns [] when there is no .pr-notes/ directory', async () => {
    expect(await readReviewProofForTicket(root, 'HS-1234')).toEqual([]);
  });

  it('sorts most-important first (rank desc)', async () => {
    await writeShard('a.sarif', [
      proofResult('HS-1234', { rank: 20, locations: [{ physicalLocation: { artifactLocation: { uri: 'a.ts' } } }] }),
      proofResult('HS-1234', { rank: 90, locations: [{ physicalLocation: { artifactLocation: { uri: 'b.ts' } } }] }),
    ]);
    const notes = await readReviewProofForTicket(root, 'HS-1234');
    expect(notes.map(n => n.rank)).toEqual([90, 20]);
  });

  it('tolerates a result with no attachments / no location', async () => {
    await writeShard('a.sarif', [{ message: { text: 'bare note' }, workItemUris: ['HS-1234'] }]);
    const notes = await readReviewProofForTicket(root, 'HS-1234');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ file: null, startLine: null, attachments: [], summary: 'bare note', noteKind: null });
  });

  it('ignores a result with no workItemUris', async () => {
    await writeShard('a.sarif', [{ message: { text: 'unlinked' } }]);
    expect(await readReviewProofForTicket(root, 'HS-1234')).toEqual([]);
  });
});
