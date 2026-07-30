// HS-9506 (docs/132 §132.9.1) — newline framing for agent stdio transports.
//
// Two drives accumulate a child process's stdout and split it on `\n`: the ACP
// transport (`acp/acpFraming.ts::createNdjsonDecoder`) and the codex app-server
// transport (`codexAppServer.ts`'s stdio reader). Same mechanism, written twice —
// which is the toolkit rule's trigger.
//
// What is NOT shared is what happens to a line once you have it, and that difference
// is real rather than incidental:
//   - ACP wants PARSED JSON objects, and deliberately skips blank lines and
//     unparseable ones (a stray log leak on stdout must not derail the stream).
//   - codex wants the RAW line handed straight to its JSON-RPC dispatcher.
//
// So the split is: this file owns "accumulate chunks, emit complete lines" and
// nothing else. Pushing the parse/filter policy in here too would have forced one
// transport to adopt the other's line-dropping rules — a behavior change smuggled
// into a dedup, and exactly the "parameterize the SHAPE, not the behavior" mistake
// docs/132 §132.11.2 warns about.

/**
 * A streaming newline splitter. `push(chunk)` appends and returns every COMPLETE
 * line seen so far, WITHOUT the terminator; a partial trailing line stays buffered
 * until its newline arrives.
 *
 * Lines are returned verbatim — not trimmed, and empty lines are NOT dropped. Both
 * are deliberate: filtering is the caller's policy (see the module note), and a
 * splitter that silently swallowed blank lines would change codex's stream.
 */
export function createLineSplitter(): { push: (chunk: string) => string[] } {
  let buffer = '';
  return {
    push(chunk: string): string[] {
      buffer += chunk;
      const out: string[] = [];
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        out.push(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
      return out;
    },
  };
}
