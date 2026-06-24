// HS-8999 — the per-project secret lives in its own gitignored sidecar
// (`<dataDir>/secret.json`), separate from `settings.json`, so `settings.json`
// (shareable project config: categories, commands, terminals, …) can be safely
// checked into git (the HS-8989 `.gitignore` rule `/.hotsheet/* !/.hotsheet/
// settings.json`). Only `secret` + `secretPathHash` move here. (`port` is not
// sensitive and is NOT in this sidecar; note HS-9002 later relocated `port` from
// `settings.json` to the gitignored `settings.local.json` as a machine-local key,
// so resolve it via `readFileSettings`, not a raw `settings.json` read — HS-9007.)
//
// The migration (in `file-settings.ts::ensureSecret`) runs once on a version
// upgrade and writes the secret here + strips it from `settings.json`. Readers
// go through `getProjectSecret`, which prefers the sidecar but falls back to the
// legacy `settings.json` secret for an un-migrated project (so nothing breaks in
// the window before `ensureSecret` runs, or if the sidecar can't be read).

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';

const SecretFileSchema = z.object({
  secret: z.string().optional(),
  secretPathHash: z.string().optional(),
}).loose();

export interface SecretFile {
  secret?: string;
  secretPathHash?: string;
}

export function secretFilePath(dataDir: string): string {
  return join(dataDir, 'secret.json');
}

/** Read the sidecar. Returns `{}` when absent/unreadable/malformed. */
export function readSecretFile(dataDir: string): SecretFile {
  const path = secretFilePath(dataDir);
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const parsed = SecretFileSchema.safeParse(raw);
    return parsed.success ? { secret: parsed.data.secret, secretPathHash: parsed.data.secretPathHash } : {};
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[secret] Failed to read secret.json in ${dataDir}: ${err.message}`);
    }
    return {};
  }
}

export function writeSecretFile(dataDir: string, data: SecretFile): void {
  writeFileSync(secretFilePath(dataDir), JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/** Read just `secret` directly from `settings.json` (the legacy location) —
 *  used as the migration source + the un-migrated fallback WITHOUT importing
 *  `file-settings.ts` (avoids an import cycle). */
function legacySettingsSecret(dataDir: string): string | undefined {
  const path = join(dataDir, 'settings.json');
  if (!existsSync(path)) return undefined;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (raw !== null && typeof raw === 'object') {
      const s = (raw as { secret?: unknown }).secret;
      if (typeof s === 'string' && s !== '') return s;
    }
  } catch { /* fall through */ }
  return undefined;
}

/** The active project secret: the sidecar first, then the legacy `settings.json`
 *  value (un-migrated / pre-`ensureSecret`), else `''`. */
export function getProjectSecret(dataDir: string): string {
  const fromSidecar = readSecretFile(dataDir).secret;
  if (fromSidecar !== undefined && fromSidecar !== '') return fromSidecar;
  return legacySettingsSecret(dataDir) ?? '';
}

export { legacySettingsSecret as readLegacySettingsSecret };
