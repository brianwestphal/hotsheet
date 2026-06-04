/**
 * HS-8728 (load resilience, docs/75 §75.6 Phase 5 full-fix follow-up) — move
 * attachment SHA-256 hashing fully OFF the main event loop into a worker thread.
 *
 * Background: `attachmentBackup.ts::buildAttachmentManifest` hashes every
 * attachment during a backup. HS-8359 already keeps that from blocking the loop
 * ≥100 ms by streaming each file + yielding (`setImmediate`) between files — so
 * the loop is never starved. But the per-chunk `hash.update` CPU still runs ON
 * the main thread between those yields. This module moves that CPU (and the file
 * read) entirely onto a worker thread, so the main loop does zero hashing work.
 *
 * Design notes:
 * - **Single long-lived worker, eval-spawned.** The worker source is an inline
 *   string spawned with `{ eval: true }`, NOT a separate file. That sidesteps
 *   bundler path resolution entirely — it works identically under `tsx` (dev)
 *   and the bundled `dist/cli.js` with no extra tsup entry. The worker reads the
 *   file itself (`createReadStream`) and returns only `{ sha, size }`, so no file
 *   bytes cross the thread boundary.
 * - **Non-worker fallback (required by HS-8728).** If the worker can't be
 *   spawned (sandbox, unusual runtime) it falls back to the in-process streaming
 *   hash — byte-for-byte the pre-HS-8728 implementation. After repeated worker
 *   crashes the module gives up on the worker and uses the fallback permanently.
 * - A genuine per-file error (missing/unreadable file) propagates as a rejection
 *   — the caller (`buildAttachmentManifest`) already try/catches per attachment.
 */

import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Worker } from 'worker_threads';

export interface HashResult { sha: string; size: number; }

// Worker source. Plain CommonJS-style JS (eval workers expose `require`); uses
// only Node built-ins. Streams the file so a huge attachment never lands in one
// buffer, and posts back per-request keyed by `id`.
const WORKER_SOURCE = `
const { parentPort } = require('worker_threads');
const { createHash } = require('crypto');
const { createReadStream } = require('fs');
parentPort.on('message', (msg) => {
  const hash = createHash('sha256');
  let size = 0;
  const stream = createReadStream(msg.path);
  stream.on('data', (chunk) => { size += chunk.length; hash.update(chunk); });
  stream.on('end', () => parentPort.postMessage({ id: msg.id, sha: hash.digest('hex'), size: size }));
  stream.on('error', (err) => parentPort.postMessage({ id: msg.id, error: (err && err.message) ? err.message : String(err) }));
});
`;

const MAX_WORKER_CRASHES = 3;

let worker: Worker | null = null;
let workerUnusable = false; // permanent fallback once spawning keeps failing
let crashCount = 0;
let nextId = 1;
const pending = new Map<number, { resolve: (r: HashResult) => void; reject: (e: unknown) => void }>();

interface WorkerReply { id: number; sha?: string; size?: number; error?: string; }

function failWorker(err: unknown): void {
  for (const p of pending.values()) p.reject(err);
  pending.clear();
  if (worker !== null) {
    const w = worker;
    worker = null;
    void w.terminate().catch(() => { /* already gone */ });
  }
  crashCount++;
  if (crashCount >= MAX_WORKER_CRASHES) workerUnusable = true;
}

function ensureWorker(): Worker | null {
  if (workerUnusable) return null;
  if (worker !== null) return worker;
  try {
    const w = new Worker(WORKER_SOURCE, { eval: true });
    w.on('message', (msg: WorkerReply) => {
      const p = pending.get(msg.id);
      if (p === undefined) return;
      pending.delete(msg.id);
      if (msg.error !== undefined) p.reject(new Error(msg.error));
      else p.resolve({ sha: msg.sha ?? '', size: msg.size ?? 0 });
    });
    w.on('error', (err) => { failWorker(err); });
    w.on('exit', (code) => { if (code !== 0) failWorker(new Error(`hash worker exited with code ${code.toString()}`)); });
    // Don't keep the process alive just for the hash worker.
    w.unref();
    worker = w;
    return w;
  } catch {
    workerUnusable = true;
    return null;
  }
}

/**
 * Hash a file's contents (SHA-256) off the main thread, returning `{ sha, size }`.
 * Falls back to in-process streaming when no worker is available.
 */
export async function hashFileOffThread(path: string): Promise<HashResult> {
  const w = ensureWorker();
  if (w === null) return hashFileInProcess(path);
  return new Promise<HashResult>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    try {
      w.postMessage({ id, path });
    } catch (err) {
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * In-process streaming SHA-256 — the non-worker fallback (and the pre-HS-8728
 * implementation). `pipeline(createReadStream, hash)` keeps memory bounded
 * regardless of attachment size.
 */
export async function hashFileInProcess(path: string): Promise<HashResult> {
  const hash = createHash('sha256');
  let size = 0;
  await pipeline(
    createReadStream(path),
    async function* (source) {
      for await (const chunk of source as AsyncIterable<Buffer>) {
        size += chunk.length;
        hash.update(chunk);
        yield chunk;
      }
    },
    async function (source) {
      for await (const _ of source) { /* drain */ }
    },
  );
  return { sha: hash.digest('hex'), size };
}

/** Terminate the hash worker (graceful shutdown / tests). Idempotent. */
export async function terminateHashWorker(): Promise<void> {
  const w = worker;
  worker = null;
  pending.clear();
  if (w !== null) {
    try { await w.terminate(); } catch { /* already gone */ }
  }
}

/** Test-only — reset module state so the worker/fallback flags don't bleed. */
export function _resetHashWorkerForTests(): void {
  void terminateHashWorker();
  workerUnusable = false;
  crashCount = 0;
  pending.clear();
}
