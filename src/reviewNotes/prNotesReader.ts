import { readdir, readFile, stat } from 'fs/promises';
import { extname, join, resolve, sep } from 'path';
import { z } from 'zod';

import type { ReviewProofAttachment, ReviewProofNote } from '../api/reviewProof.js';

// HS-9293 — the wire shape (`ReviewProofNote` / `ReviewProofAttachment`) is the
// single source of truth in `src/api/reviewProof.ts` (§9); the reader returns it.
export type { ReviewProofAttachment, ReviewProofNote } from '../api/reviewProof.js';
type ReviewProofAttachmentKind = ReviewProofAttachment['kind'];

/**
 * HS-9223 (docs/110 §110.7 P3, docs/111) — READ-SIDE reader for Glassbox's
 * `.pr-notes/` review notes. Detects the SARIF `result`s whose `workItemUris`
 * reference a given Hot Sheet ticket (`HS-NNNN`) and returns their proof metadata
 * + artifact references, so the ticket detail panel can surface "here's the proof,
 * at these lines".
 *
 * Maintainer decisions (2026-07-02): **Q1(b) direct SARIF read** (Hot Sheet scans
 * + parses; Glassbox still owns authoring/format), **Q3(b) presence-gated** (shown
 * whenever matching notes exist, independent of the `aiReviewNotes` inducement
 * toggle). This module is PURE over a passed `gitRoot` so it's trivially testable;
 * the API layer resolves the root via `getGitRoot(projectRootFromDataDir(dataDir))`.
 *
 * Hot Sheet never writes SARIF (docs/110 §110.6) — this only reads. Tolerant of a
 * missing `.pr-notes/` dir, a malformed shard, or unexpected SARIF fields (a bad
 * file is skipped; the rest still surface).
 */

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;

// --- SARIF subset schema (tolerant: only the fields we read are typed) ---

const RegionSchema = z.object({
  startLine: z.number().optional(),
  endLine: z.number().optional(),
}).loose();

const PhysicalLocationSchema = z.object({
  artifactLocation: z.object({ uri: z.string().optional() }).loose().optional(),
  region: RegionSchema.optional(),
}).loose();

const LocationSchema = z.object({
  physicalLocation: PhysicalLocationSchema.optional(),
}).loose();

const AttachmentSchema = z.object({
  artifactLocation: z.object({ uri: z.string().optional() }).loose().optional(),
  description: z.object({ text: z.string().optional() }).loose().optional(),
}).loose();

const ResultSchema = z.object({
  message: z.object({ text: z.string().optional() }).loose().optional(),
  level: z.string().optional(),
  rank: z.number().optional(),
  locations: z.array(LocationSchema).optional(),
  workItemUris: z.array(z.string()).optional(),
  attachments: z.array(AttachmentSchema).optional(),
  properties: z.object({ tags: z.array(z.string()).optional() }).loose().optional(),
}).loose();

const SarifLogSchema = z.object({
  runs: z.array(z.object({ results: z.array(ResultSchema).optional() }).loose()).optional(),
}).loose();

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when any `workItemUri` references `ticketNumber` as a WHOLE token. Word-
 * boundary anchored so `HS-12` never matches `HS-123` / `HS-1234` (the ticket's
 * "no false matches across tickets" requirement), while still matching a URL that
 * ends in / contains the id (`https://…/HS-1234`).
 */
function workItemsMatchTicket(workItemUris: string[] | undefined, ticketNumber: string): boolean {
  if (workItemUris === undefined || workItemUris.length === 0) return false;
  const re = new RegExp(`(?<![\\w-])${escapeRegExp(ticketNumber)}(?![\\w-])`);
  return workItemUris.some(uri => re.test(uri));
}

function attachmentKind(uri: string): ReviewProofAttachmentKind {
  return IMAGE_EXT.test(uri) ? 'image' : 'text';
}

function toReviewProofNote(result: z.infer<typeof ResultSchema>, sourceFile: string): ReviewProofNote {
  const loc = result.locations?.[0]?.physicalLocation;
  const messageText = result.message?.text ?? '';
  const summary = messageText.split('\n')[0].trim();
  const attachments: ReviewProofAttachment[] = (result.attachments ?? []).flatMap(a => {
    const uri = a.artifactLocation?.uri;
    if (uri === undefined || uri === '') return [];
    const description = a.description?.text;
    return [{ uri, kind: attachmentKind(uri), ...(description !== undefined && description !== '' ? { description } : {}) }];
  });
  return {
    noteKind: result.properties?.tags?.[0] ?? null,
    file: loc?.artifactLocation?.uri ?? null,
    startLine: loc?.region?.startLine ?? null,
    endLine: loc?.region?.endLine ?? null,
    summary,
    rank: result.rank ?? null,
    level: result.level ?? null,
    attachments,
    sourceFile,
  };
}

/** List every `.sarif` file under `<gitRoot>/.pr-notes/notes/` (recursive).
 *  Returns [] when the directory doesn't exist / can't be read. */
async function listSarifShards(gitRoot: string): Promise<string[]> {
  const notesDir = join(gitRoot, '.pr-notes', 'notes');
  try {
    // Recursive readdir (no `withFileTypes`) yields notesDir-relative path strings
    // for every entry; `.sarif` filtering also excludes the intermediate dirs.
    const rels = await readdir(notesDir, { recursive: true });
    return rels.filter(rel => rel.endsWith('.sarif')).map(rel => join(notesDir, rel));
  } catch {
    return []; // no `.pr-notes/notes/` yet — nothing to surface
  }
}

/**
 * HS-9223 — the ticket's proof notes: every `.pr-notes/` SARIF `result` whose
 * `workItemUris` reference `ticketNumber`, mapped to display metadata + artifact
 * refs, most-important first (by `rank` desc, then file). A malformed shard is
 * skipped; a missing `.pr-notes/` dir yields `[]`.
 */
export async function readReviewProofForTicket(gitRoot: string, ticketNumber: string): Promise<ReviewProofNote[]> {
  const shards = await listSarifShards(gitRoot);
  const notes: ReviewProofNote[] = [];
  for (const shard of shards) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(shard, 'utf-8'));
    } catch {
      continue; // unreadable / non-JSON shard — skip, keep going
    }
    const log = SarifLogSchema.safeParse(parsed);
    if (!log.success) continue;
    const sourceFile = shard.slice(gitRoot.length).replace(/^[/\\]+/, '');
    for (const run of log.data.runs ?? []) {
      for (const result of run.results ?? []) {
        if (workItemsMatchTicket(result.workItemUris, ticketNumber)) {
          notes.push(toReviewProofNote(result, sourceFile));
        }
      }
    }
  }
  notes.sort((a, b) => (b.rank ?? -1) - (a.rank ?? -1) || (a.file ?? '').localeCompare(b.file ?? ''));
  return notes;
}

/** HS-9294 — the outcome of resolving one `.pr-notes/` proof artifact for inline
 *  display. `lfs-pointer` = the file is an unpulled Git-LFS stub (show an
 *  "open in Glassbox" fallback, not a broken image). */
export type ReviewProofArtifactResult =
  | { kind: 'file'; content: Buffer; ext: string }
  | { kind: 'lfs-pointer' }
  | { kind: 'not-found' }
  | { kind: 'forbidden' };

/** The first line of a Git-LFS pointer file (a tiny text stub left when LFS
 *  content isn't pulled). Real image bytes never start with this. */
const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1';
/** Cap so a pathologically large file never streams into memory; screenshots are
 *  far under this, and a bigger file is treated as absent. */
const MAX_ARTIFACT_BYTES = 15 * 1024 * 1024;

/**
 * HS-9294 (docs/111 Phase 3) — read one `.pr-notes/` proof artifact for inline
 * display. **Path-guarded** to stay under `<gitRoot>/.pr-notes/` — no traversal to
 * arbitrary repo files. Detects a Git-LFS pointer stub so the caller can fall back
 * to "open in Glassbox" instead of serving a broken image. Returns the raw bytes +
 * extension for a real file. Pure over a passed `gitRoot` (testable).
 */
export async function readReviewProofArtifact(gitRoot: string, relPath: string): Promise<ReviewProofArtifactResult> {
  const prNotesDir = resolve(join(gitRoot, '.pr-notes'));
  const full = resolve(join(gitRoot, relPath));
  if (full !== prNotesDir && !full.startsWith(prNotesDir + sep)) return { kind: 'forbidden' };
  let size: number;
  try {
    size = (await stat(full)).size;
  } catch {
    return { kind: 'not-found' };
  }
  if (size > MAX_ARTIFACT_BYTES) return { kind: 'not-found' };
  const content = await readFile(full);
  if (content.subarray(0, LFS_POINTER_PREFIX.length).toString('utf-8') === LFS_POINTER_PREFIX) {
    return { kind: 'lfs-pointer' };
  }
  return { kind: 'file', content, ext: extname(full).toLowerCase() };
}
