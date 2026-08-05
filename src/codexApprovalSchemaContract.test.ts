/**
 * HS-9586 — validate the drive's approval replies against **codex's own**
 * protocol schema.
 *
 * This is the test that would have caught the reported bug. The unit tests in
 * `codexAppServerMapping.test.ts` pin what we *intend* to send; they cannot tell
 * you the wire disagrees, because both sides of that assertion are ours. The bug
 * was exactly that: `{decision:'accept'}` was asserted, shipped, and silently
 * read by codex as a refusal, because `accept` is not a member of the
 * `ReviewDecision` enum that `execCommandApproval` answers with.
 *
 * `codex app-server generate-json-schema --out <dir>` emits one JSON Schema per
 * protocol type. We generate it from the INSTALLED binary and check every
 * payload `approvalResponseFromReply` can produce against the response schema
 * for the method it answers. A codex upgrade that renames a variant therefore
 * fails here rather than in the user's terminal.
 *
 * Skips when codex isn't installed (CI), like the other codex-dependent tests.
 * It never starts a daemon, never runs a turn, and never talks to the network —
 * schema generation is a pure local dump into a temp dir.
 */
import { execFileSync } from 'node:child_process';

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import { approvalAutoAcceptResponse, type ApprovalFamily, approvalResponseFromReply } from './codexAppServerMapping.js';

/** The response schema each approval method answers with, per codex's own
 *  `ServerRequest` union. The pairing is the thing HS-9586 got wrong, so it is
 *  spelled out rather than derived. */
const METHOD_RESPONSE: Readonly<Record<string, { schema: string; family: ApprovalFamily }>> = {
  execCommandApproval: { schema: 'ExecCommandApprovalResponse', family: 'review-decision' },
  applyPatchApproval: { schema: 'ApplyPatchApprovalResponse', family: 'review-decision' },
  'item/commandExecution/requestApproval': { schema: 'CommandExecutionRequestApprovalResponse', family: 'item-decision' },
  'item/fileChange/requestApproval': { schema: 'FileChangeRequestApprovalResponse', family: 'item-decision' },
  'item/permissions/requestApproval': { schema: 'PermissionsRequestApprovalResponse', family: 'permissions' },
};

function codexAvailable(): boolean {
  try {
    execFileSync('codex', ['--version'], { stdio: 'ignore', timeout: 10_000, killSignal: 'SIGKILL' });
    return true;
  } catch { return false; }
}

const HAVE_CODEX = codexAvailable();
let schemaDir: string | null = null;

function generateSchemas(): string {
  if (schemaDir !== null) return schemaDir;
  const dir = mkdtempSync(join(tmpdir(), 'hs-codex-schema-'));
  execFileSync('codex', ['app-server', 'generate-json-schema', '--out', dir], {
    stdio: 'ignore', timeout: 60_000, killSignal: 'SIGKILL',
  });
  schemaDir = dir;
  return dir;
}

afterAll(() => {
  if (schemaDir !== null) { try { rmSync(schemaDir, { recursive: true, force: true }); } catch { /* ignore */ } }
});

interface JsonSchema {
  required?: string[];
  properties?: Record<string, JsonSchema>;
  definitions?: Record<string, JsonSchema>;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  type?: string | string[];
  $ref?: string;
}

function loadSchema(dir: string, name: string): JsonSchema {
  const path = join(dir, `${name}.json`);
  if (!existsSync(path)) throw new Error(`codex schema ${name}.json not found — the protocol may have renamed it`);
  return JSON.parse(readFileSync(path, 'utf-8')) as JsonSchema;
}

/**
 * A deliberately small structural validator — enough for these response types
 * (enums, `oneOf` variants, required object keys, `$ref` into `definitions`) and
 * no more. Pulling in a full JSON-Schema library for five payload shapes would
 * be a dependency doing less work than this function.
 *
 * Returns null when valid, or a human-readable reason.
 */
function validate(value: unknown, schema: JsonSchema, defs: Record<string, JsonSchema>, path = '$'): string | null {
  if (schema.$ref !== undefined) {
    const name = schema.$ref.split('/').pop() ?? '';
    if (!(name in defs)) return `${path}: unresolved $ref ${schema.$ref}`;
    return validate(value, defs[name], defs, path);
  }
  if (schema.allOf !== undefined) {
    for (const sub of schema.allOf) {
      const err = validate(value, sub, defs, path);
      if (err !== null) return err;
    }
    return null;
  }
  if (schema.oneOf !== undefined || schema.anyOf !== undefined) {
    const variants = schema.oneOf ?? schema.anyOf ?? [];
    const reasons = variants.map(v => validate(value, v, defs, path));
    if (reasons.some(r => r === null)) return null;
    return `${path}: matched none of ${String(variants.length)} variants (${JSON.stringify(value)})`;
  }
  if (schema.const !== undefined) {
    return value === schema.const ? null : `${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`;
  }
  if (schema.enum !== undefined) {
    return schema.enum.includes(value) ? null : `${path}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`;
  }
  const types = schema.type === undefined ? [] : (Array.isArray(schema.type) ? schema.type : [schema.type]);
  if (types.includes('null') && value === null) return null;
  if (types.includes('string') && typeof value === 'string') return null;
  if (types.includes('array')) return Array.isArray(value) ? null : `${path}: expected array`;
  if (types.includes('object') || schema.properties !== undefined || schema.required !== undefined) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${path}: expected object, got ${JSON.stringify(value)}`;
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) return `${path}: missing required "${key}"`;
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj) {
        const err = validate(obj[key], sub, defs, `${path}.${key}`);
        if (err !== null) return err;
      }
    }
    return null;
  }
  // No constraint we model (e.g. a bare `{}` schema) — accept.
  return null;
}

describe.skipIf(!HAVE_CODEX)('codex approval replies satisfy codex\'s own schema (HS-9586)', () => {
  it('reports which codex version the contract was checked against', () => {
    const version = execFileSync('codex', ['--version'], { encoding: 'utf-8', timeout: 10_000, killSignal: 'SIGKILL' }).trim();
    // Not an assertion about the version — a breadcrumb, so a failure below can
    // be read as "codex changed" rather than "our code changed".
    expect(version).toMatch(/codex/i);
  });

  for (const [method, { schema: schemaName, family }] of Object.entries(METHOD_RESPONSE)) {
    describe(method, () => {
      // The captured request for the v2 exec method constrains decisions; the
      // others are unconstrained. Both paths must produce valid payloads.
      const requests: Array<{ label: string; params: Record<string, unknown> }> = [
        { label: 'unconstrained', params: { permissions: { fileSystem: null, network: null } } },
        {
          label: 'availableDecisions accept+cancel (the captured shape)',
          params: {
            availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch'] } }, 'cancel'],
            permissions: { fileSystem: null, network: null },
          },
        },
      ];

      for (const { label, params } of requests) {
        for (const optionId of ['allow', 'allow_session', 'deny']) {
          it(`${optionId} (${label}) is a valid ${schemaName}`, () => {
            const dir = generateSchemas();
            const schema = loadSchema(dir, schemaName);
            const payload = approvalResponseFromReply(family, { optionId }, params);
            expect(validate(payload, schema, schema.definitions ?? {})).toBeNull();
          });
        }

        it(`a dismissed popup (${label}) is a valid ${schemaName}`, () => {
          const dir = generateSchemas();
          const schema = loadSchema(dir, schemaName);
          const payload = approvalResponseFromReply(family, { cancelled: true }, params);
          expect(validate(payload, schema, schema.definitions ?? {})).toBeNull();
        });

        it(`the auto-accept payload (${label}) is a valid ${schemaName}`, () => {
          // The opt-out and allow-rule paths bypass the overlay entirely, so
          // they need the same check — they carried the identical bug.
          const dir = generateSchemas();
          const schema = loadSchema(dir, schemaName);
          const payload = approvalAutoAcceptResponse(family, params);
          expect(validate(payload, schema, schema.definitions ?? {})).toBeNull();
        });
      }
    });
  }

  it('the pre-fix payload is REJECTED by the v1 schema — the bug, pinned', () => {
    // Guards the guard: if `validate` were too lenient every assertion above
    // would pass vacuously. This is the exact payload the drive used to send for
    // `npm install motion`.
    const dir = generateSchemas();
    const schema = loadSchema(dir, 'ExecCommandApprovalResponse');
    const reason = validate({ decision: 'accept' }, schema, schema.definitions ?? {});
    expect(reason).not.toBeNull();
    expect(reason).toContain('decision');
  });

  it('every approval method this drive answers still exists in the protocol', () => {
    // A renamed or removed method would otherwise show up as approvals that
    // silently stop being recognized (they'd fall through to the empty-`{}`
    // branch), which is invisible until a user hits one.
    const dir = generateSchemas();
    for (const { schema } of Object.values(METHOD_RESPONSE)) {
      expect(existsSync(join(dir, `${schema}.json`))).toBe(true);
    }
  });
});
