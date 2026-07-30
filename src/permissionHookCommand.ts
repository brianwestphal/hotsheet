/**
 * HS-9507 — resolve the `<hotsheet-cli> <marker>` command an agent's permission hook
 * runs, for whichever way Hot Sheet is currently running.
 *
 * Third instance of the HS-9496 duplication: `agyPermissionHookCommand` and
 * `codexPermissionHookCommand` were byte-identical apart from the marker string. Same
 * treatment — parameterize the one thing that varies, share the resolution.
 *
 * ## Why this module sits at `src/` root, and must stay there
 *
 * The resolution is relative to THIS module's own location:
 *
 *   - **prod** — the server bundles to `dist/cli.js`, so `import.meta.url` resolves into
 *     `dist/` and the sibling `cli.js` is the real entry point.
 *   - **dev** — nothing is bundled, so `import.meta.url` is this source file and the
 *     sibling is `src/cli.ts`.
 *
 * Both branches assume the module is a SIBLING of the CLI entry point. That holds at
 * `src/` root and breaks one directory down: from `src/aiTools/` the dev probe looks for
 * `src/aiTools/cli.ts`, misses, and silently falls through to a `dist/cli.js` that in a
 * dev tree is stale or absent. The hook would then be installed pointing at nothing — and
 * the failure mode is the permission overlay simply never appearing, with no error
 * anywhere. That is why it did not move into the capability layer with its callers.
 *
 * `permissionHookCommandTarget` exists so a test can assert the resolved path actually
 * exists, which is the check that would have caught the above.
 */
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/** The CLI file the hook command will invoke, and how. Exported for the path test. */
export function permissionHookCommandTarget(): { runner: 'node' | 'tsx'; path: string } {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const distCli = join(thisDir, 'cli.js'); // prod: bundled alongside this module
  if (existsSync(distCli)) return { runner: 'node', path: distCli };
  const srcCli = join(thisDir, 'cli.ts'); // dev: source sibling
  if (existsSync(srcCli)) return { runner: 'tsx', path: srcCli };
  // Neither present: fall back to the prod shape so the written hook is at least
  // well-formed. It will fail loudly when invoked rather than silently doing nothing.
  return { runner: 'node', path: distCli };
}

/**
 * The shell command for an agent's permission hook. `marker` is both the CLI subcommand
 * and the ownership marker `aiTools/hooksFile.ts` uses to find our group again — so it
 * must appear verbatim in the returned string.
 *
 * Paths are quoted: the install path can contain spaces (`~/Library/Application Support`,
 * a user directory with a space), and an unquoted command would split mid-path.
 */
export function permissionHookCommand(marker: string): string {
  const { runner, path } = permissionHookCommandTarget();
  return runner === 'tsx'
    ? `npx tsx "${path}" ${marker}`
    : `"${process.execPath}" "${path}" ${marker}`;
}
