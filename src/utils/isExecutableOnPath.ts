import { existsSync } from 'fs';
import { delimiter, join } from 'path';

/**
 * HS-8486 / HS-8491 — `PATH` probe for an executable file. Used by:
 *
 * - `src/skills.ts::ensureSkillsForDir` to install AI-tool skill files
 *   when the corresponding CLI is on PATH (so the user's first launch
 *   of the tool finds the Hot Sheet skill already in scope).
 * - `src/projects.ts::registerProject` to auto-seed a `claude` configured
 *   terminal on first-run when the binary is installed.
 * - `src/terminals/resolveCommand.ts::defaultClaudeDetector` to pick
 *   between `claude` and the user's default shell when launching a
 *   terminal with the `{{claudeCommand}}` template.
 *
 * Pre-fix the same logic lived as a private helper in each of those
 * three modules. Extracted here so the contract has one home; callers
 * import from this module rather than re-implement the probe.
 */
export function isExecutableOnPath(name: string): boolean {
  const pathEnv = process.env.PATH ?? '';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === '') continue;
    for (const ext of exts) {
      if (existsSync(join(dir, name + ext))) return true;
    }
  }
  return false;
}
