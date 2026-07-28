/**
 * HS-9458 / HS-9460 — the storage-corruption predicate, in its own module.
 *
 * Lives here rather than in `connection.ts` because BOTH sides need it and
 * `connection.ts` imports `queryInstrumentation.ts`: the open path
 * (`isRecoverableOpenError`) uses it to route a corrupt cluster into recovery,
 * and the live query proxy uses it to notice the same corruption appearing
 * mid-session. Importing it back from `connection.ts` would be a cycle.
 *
 * `connection.ts` re-exports it, so existing importers are unaffected.
 */

/**
 * HS-9458 — is this the "the cluster's storage is inconsistent" class?
 *
 * The reported failure was an endless 500 on every request, from a project cluster
 * whose data pages had been written ahead of the WAL:
 *
 *     xlog flush request 0/3BA18488 is not satisfied --- flushed only to 0/3BA175E0
 *     code: 'XX000', file: 'xlog.c', routine: 'XLogFlush',
 *     where: 'writing block 5 of relation base/1/461145'
 *
 * That is the classic signature of a cluster killed mid-write (plausibly the docs/128
 * OOM crash loop): Postgres is asked to flush WAL up to an LSN that was never durably
 * written, so it refuses every subsequent write. It is unrecoverable in place — the
 * cluster has to be replaced from a snapshot/backup, which is exactly what
 * `recoverFromOpenFailure` does.
 *
 * Before this, the class matched NONE of the patterns above, so recovery never ran:
 * the error propagated out of `getDb` untouched and every request 500'd, forever,
 * across restarts. The user had no signal beyond the raw stack trace — not even the
 * §73 restore prompt, which is gated on the recovery marker this unblocks.
 *
 * Matched by message substring, like the rest of the classifier, because the message
 * is what survives PGLite's error wrapping and what gets logged. Deliberately narrow:
 * `XX000` alone is Postgres's generic internal-error code and would over-match, so we
 * key on the specific phrases instead. Only the `xlog flush request` variant is
 * MEASURED (from the report); the two page-level phrases are long-standing Postgres
 * corruption messages in the same "storage is bad, replace the cluster" family and
 * never appear on a healthy cluster. Over-matching is low-risk anyway — recovery
 * preserves the old `db/` aside rather than deleting it.
 *
 * Pure: takes only the thrown value, returns a boolean. Exported for the unit test.
 */
export function isClusterStorageFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (message === '') return false;
  return message.includes('xlog flush request')
    || message.includes('invalid page in block')
    || message.includes('could not read block');
}
