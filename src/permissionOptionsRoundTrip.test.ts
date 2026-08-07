/**
 * HS-9586 — the guard for a bug class that produced NO error anywhere: a field the
 * server sends that the client's own wire schema doesn't name.
 *
 * ## What happened
 *
 * `routes/projects.ts` put the agent's `options` on each pending-permission entry.
 * `schemas.ts::PendingPermissionEntrySchema` (server) declared them. The CLIENT's
 * `api/projects.ts::PermissionEntrySchema` did not — and zod STRIPS what it doesn't
 * name. So the browser received a permission with no options, fell back to the
 * legacy two-icon Allow/Deny layout, and answered WITHOUT an `option_id`; the
 * respond route read a missing option id as a dismissal. The user clicked Allow and
 * codex was told no.
 *
 * Nothing failed. Both schemas were internally consistent, both parsed successfully,
 * and every existing test asserted against one side or the other — never across the
 * seam. That seam is what this file tests.
 *
 * ## The invariant
 *
 * **Whatever the server puts on a pending-permission entry must survive the client's
 * parse.** Adding a field to the server schema without adding it to the client one
 * fails here, by comparing the parsed key sets rather than by listing fields (a list
 * would need the same edit the bug was, so it would go stale the same way).
 */
import { describe, expect, it } from 'vitest';

import { ProjectsPermissionsSchema } from './api/projects.js';
import { PendingPermissionEntrySchema } from './schemas.js';

/** A pending entry exactly as `routes/projects.ts` builds one for an ACP request. */
const SERVER_ENTRY = {
  request_id: 'acp-perm-1',
  tool_name: 'Codex: Shell command',
  description: 'Codex wants to run a command that needs approval',
  input_preview: 'npm install motion\ncwd: /tmp/p',
  options: [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'allow_session', name: 'Allow for session', kind: 'allow_always' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
  ],
};

/** Parse through the CLIENT schema, the way the browser's long-poll does. */
function throughClient(entry: unknown): Record<string, unknown> {
  const parsed = ProjectsPermissionsSchema.parse({ permissions: { 'secret-1': entry }, v: 3 });
  const out = parsed.permissions['secret-1'];
  expect(out).not.toBeNull();
  return out as unknown as Record<string, unknown>;
}

describe('pending-permission entry survives the client parse (HS-9586)', () => {
  it('the client keeps EVERY key the server schema declares — the seam the bug lived in', () => {
    // Both sides parse the same entry; the client must not drop keys the server kept.
    const serverKeys = Object.keys(PendingPermissionEntrySchema.parse(SERVER_ENTRY));
    const clientKeys = Object.keys(throughClient(SERVER_ENTRY));
    const dropped = serverKeys.filter(k => !clientKeys.includes(k));
    expect(
      dropped,
      `api/projects.ts::PermissionEntrySchema drops ${dropped.join(', ')} — zod strips what it does not name, `
      + 'and a dropped field fails silently in the browser rather than at the wire. Add it there too.',
    ).toEqual([]);
  });

  it('options round-trip with their ids intact — the id IS the answer sent back', () => {
    const entry = throughClient(SERVER_ENTRY);
    expect(entry.options).toEqual(SERVER_ENTRY.options);
  });

  it('a Claude/MCP-hooks entry (no options) still parses — options are optional, not required', () => {
    const entry = throughClient({ request_id: 'r1', tool_name: 'Bash', description: 'run it' });
    expect(entry.request_id).toBe('r1');
    expect(entry.options).toBeUndefined();
  });

  it('a malformed options array does not discard the whole pending request', () => {
    // A real pending permission must still reach the user even if a newer server
    // sends an option shape this client can't read; losing the popup entirely
    // would strand the agent waiting forever.
    const parsed = ProjectsPermissionsSchema.safeParse({
      permissions: { s: { request_id: 'r1', tool_name: 'Bash', description: 'd', options: 'not-an-array' } },
      v: 1,
    });
    // Either it parses (options coerced away) or the schema rejects only that entry —
    // what it must NOT do is throw away a valid request_id.
    if (parsed.success) {
      expect(parsed.data.permissions.s?.request_id).toBe('r1');
    } else {
      expect.fail('a bad options value rejected the entire poll response — a real pending request would be lost');
    }
  });
});
