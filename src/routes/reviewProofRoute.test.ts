import { execFileSync } from 'child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { Hono } from 'hono';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppEnv } from '../types.js';
import { ticketRoutes } from './tickets.js';

/**
 * HS-9293 (docs/111) — the `GET /tickets/:number/review-proof` endpoint wiring:
 * resolve the repo root from the dataDir + hand it to `readReviewProofForTicket`.
 * (The reader's matching/tolerance is exhaustively covered by
 * `reviewNotes/prNotesReader.test.ts`; this pins the route resolution + shape.)
 */
let root: string;
let app: Hono<AppEnv>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hs-9293-'));
  // `git init` so `getGitRoot(root)` deterministically resolves to `root`
  // (independent of whether the ambient tmpdir sits inside another repo).
  execFileSync('git', ['init', '-q'], { cwd: root });
  app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('dataDir', join(root, '.hotsheet')); // projectRootFromDataDir peels `.hotsheet` → root
    c.set('projectSecret', 'test');
    await next();
  });
  app.route('/api', ticketRoutes);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeShard(name: string, results: unknown[]): Promise<void> {
  const file = join(root, '.pr-notes', 'notes', name);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ runs: [{ results }] }), 'utf-8');
}

interface ProofBody { notes: { summary: string; file: string | null; noteKind: string | null; attachments: { kind: string }[] }[] }

describe('GET /tickets/:number/review-proof (HS-9293)', () => {
  it('returns the ticket-matching proof notes with resolved metadata', async () => {
    await writeShard('src/x.ts.000000.sarif', [{
      message: { text: 'proved the export flow' },
      rank: 60,
      workItemUris: ['HS-1234'],
      locations: [{ physicalLocation: { artifactLocation: { uri: 'src/x.ts' }, region: { startLine: 3, endLine: 9 } } }],
      attachments: [{ artifactLocation: { uri: '.pr-notes/artifacts/shot.png' } }],
      properties: { tags: ['proof'] },
    }]);
    const res = await app.request('/api/tickets/HS-1234/review-proof');
    expect(res.status).toBe(200);
    const body = await res.json() as ProofBody;
    expect(body.notes).toHaveLength(1);
    expect(body.notes[0].summary).toBe('proved the export flow');
    expect(body.notes[0].file).toBe('src/x.ts');
    expect(body.notes[0].noteKind).toBe('proof');
    expect(body.notes[0].attachments[0].kind).toBe('image');
  });

  it('returns empty notes when nothing references the ticket (no cross-ticket bleed)', async () => {
    await writeShard('x.sarif', [{ message: { text: 'other' }, workItemUris: ['HS-9999'] }]);
    const res = await app.request('/api/tickets/HS-1234/review-proof');
    expect(res.status).toBe(200);
    expect((await res.json() as ProofBody).notes).toEqual([]);
  });

  it('returns empty notes (presence-gated) when there is no .pr-notes/ directory', async () => {
    const res = await app.request('/api/tickets/HS-1234/review-proof');
    expect(res.status).toBe(200);
    expect((await res.json() as ProofBody).notes).toEqual([]);
  });
});
