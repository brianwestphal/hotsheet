/**
 * HS-9507 — the permission-hook command builder, and specifically that the CLI path it
 * resolves actually EXISTS.
 *
 * Nothing asserted that before, and the gap has teeth: the resolution is relative to this
 * module's own directory, so moving it one level down (which HS-9505 nearly did, folding
 * it into `aiTools/`) makes the dev probe look for a sibling `cli.ts` that isn't there,
 * silently fall through to the prod branch, and write a hook pointing at a `dist/cli.js`
 * that in a dev tree is stale or missing.
 *
 * The failure mode is the worst kind: the permission overlay just never appears. No
 * error, no log line — the agent runs unattended when the user asked to be asked.
 */
import { existsSync } from 'fs';
import { basename } from 'path';
import { describe, expect, it } from 'vitest';

import { permissionHookCommand, permissionHookCommandTarget } from './permissionHookCommand.js';

describe('permissionHookCommandTarget (HS-9507)', () => {
  it('resolves to a CLI file that EXISTS — the check that catches a bad move', () => {
    const { path } = permissionHookCommandTarget();
    expect(existsSync(path), `resolved CLI ${path} does not exist`).toBe(true);
  });

  it('resolves to the CLI entry point, not some other sibling', () => {
    expect(['cli.ts', 'cli.js']).toContain(basename(permissionHookCommandTarget().path));
  });

  it('picks the runner that matches the file it found', () => {
    // A `.ts` entry needs tsx; a built `.js` runs on plain node. Mismatching them writes
    // a hook that cannot start.
    const { runner, path } = permissionHookCommandTarget();
    expect(runner).toBe(basename(path) === 'cli.ts' ? 'tsx' : 'node');
  });
});

describe('permissionHookCommand (HS-9507)', () => {
  it('embeds the marker verbatim — hooksFile.ts finds our group by it', () => {
    // The marker is both the CLI subcommand and the ownership marker. If it were
    // transformed here, `ensureHooksFile` could no longer recognize its own group and
    // every generation pass would stack another copy.
    expect(permissionHookCommand('__agy-permission-hook')).toContain('__agy-permission-hook');
    expect(permissionHookCommand('__codex-permission-hook')).toContain('__codex-permission-hook');
  });

  it('quotes the paths — install directories contain spaces', () => {
    // `~/Library/Application Support`, a home directory with a space: an unquoted command
    // splits mid-path and the hook silently fails to start.
    const cmd = permissionHookCommand('__test-marker');
    const { path } = permissionHookCommandTarget();
    expect(cmd).toContain(`"${path}"`);
  });

  it('is deterministic — two calls agree', () => {
    // Written into a config file and compared for idempotence, so an unstable answer
    // would rewrite the user's hooks file on every pass.
    expect(permissionHookCommand('__x')).toBe(permissionHookCommand('__x'));
  });

  it('distinguishes the two agents', () => {
    expect(permissionHookCommand('__agy-permission-hook'))
      .not.toBe(permissionHookCommand('__codex-permission-hook'));
  });
});
