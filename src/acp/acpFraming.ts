// HS-9330 — the ACP wire framing: newline-delimited JSON-RPC 2.0 over stdio.
//
// Validated live against opencode 1.17.9 (docs/114 §114.11): each message is a
// single JSON object on its own line (`\n`-terminated), NOT Content-Length-framed.
// Pure + streaming so it's unit-testable without a spawned agent; the real
// transport (`acpDrive.ts`, still to build) pipes a child process's stdout through
// `createNdjsonDecoder` and writes `encodeMessage(...)` to its stdin.

import { createLineSplitter } from '../aiTools/lineFraming.js';

/** A parsed JSON-RPC message — the client discriminates request/response/notification. */
export type AcpMessage = Record<string, unknown>;

/** Serialize a JSON-RPC message to a single wire line (with the trailing `\n`). */
export function encodeMessage(msg: AcpMessage): string {
  return JSON.stringify(msg) + '\n';
}

/**
 * A streaming newline decoder. `push(chunk)` appends bytes and returns every
 * COMPLETE JSON object seen so far; a partial trailing line is buffered until its
 * newline arrives. Blank lines are ignored; a non-JSON line (e.g. a stray log leak
 * on stdout) is skipped rather than throwing — a well-behaved ACP agent emits pure
 * JSON-RPC on stdout (opencode sends logs to stderr / its log file), so this is
 * defensive, not expected.
 */
export function createNdjsonDecoder(): { push: (chunk: string) => AcpMessage[] } {
  // HS-9506 — the chunk-accumulate-and-split half is shared with the codex app-server
  // transport and lives in the host toolkit. The parse/skip policy below stays here:
  // it is ACP's, not every stdio agent's.
  const lines = createLineSplitter();
  return {
    push(chunk: string): AcpMessage[] {
      const out: AcpMessage[] = [];
      for (const raw of lines.push(chunk)) {
        const line = raw.trim();
        if (line === '') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // skip a non-JSON line rather than derail the stream
        }
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          out.push(parsed as AcpMessage);
        }
      }
      return out;
    },
  };
}

/** True when a message is a JSON-RPC RESPONSE (has an `id` and a `result`/`error`). */
export function isResponse(msg: AcpMessage): boolean {
  return 'id' in msg && ('result' in msg || 'error' in msg);
}

/** True when a message is an incoming JSON-RPC REQUEST (has both `id` and `method`). */
export function isRequest(msg: AcpMessage): boolean {
  return 'id' in msg && 'method' in msg;
}

/** True when a message is a JSON-RPC NOTIFICATION (a `method` with no `id`). */
export function isNotification(msg: AcpMessage): boolean {
  return 'method' in msg && !('id' in msg);
}

/** A monotonically increasing JSON-RPC request-id source, starting at 0. */
export function createIdCounter(): { next: () => number } {
  let n = 0;
  return { next: () => n++ };
}
