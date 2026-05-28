import { readFileSettings } from '../../file-settings.js';
import type { SessionState } from './types.js';

/**
 * HS-8189 — module-level session storage shared by the split registry
 * modules. Pre-fix everything here lived in the 1006-line
 * `src/terminals/registry.ts`. Splitting requires the Map + key helper +
 * defaults to live somewhere all behavioral modules
 * (`./attach.ts` / `./lifecycle.ts` / `./state.ts` / `./scannerHandler.ts`)
 * can read + mutate without a circular import.
 */

export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
const SCROLLBACK_MIN = 64 * 1024;
const SCROLLBACK_MAX = 16 * 1024 * 1024;
const SCROLLBACK_DEFAULT = 1024 * 1024;

export const sessions = new Map<string, SessionState>();

export function sessionKey(secret: string, terminalId: string): string {
  return `${secret}::${terminalId}`;
}

/** The `${secret}::` prefix for a project's session keys. HS-8674 — symmetric
 *  with `sessionKey` so the prefix isn't hand-built at each callsite. */
export function projectPrefix(secret: string): string {
  return `${secret}::`;
}

/** Split a session key back into `{ secret, terminalId }`. HS-8674 — the inverse
 *  of `sessionKey`, centralizing the `::` split that was hand-rolled three ways
 *  across the registry slices. Terminal ids never contain `::`, so the first
 *  separator is authoritative. */
export function parseSessionKey(key: string): { secret: string; terminalId: string } {
  const sepIdx = key.indexOf('::');
  if (sepIdx === -1) return { secret: key, terminalId: '' };
  return { secret: key.slice(0, sepIdx), terminalId: key.slice(sepIdx + 2) };
}

/** Resolve the per-session scrollback budget from project settings (clamped to
 *  `[SCROLLBACK_MIN, SCROLLBACK_MAX]`). Read once at session-create time so
 *  every PTY for that project gets the user's chosen size. */
export function resolveScrollbackBytes(dataDir: string): number {
  const settings = readFileSettings(dataDir);
  const raw = settings.terminal_scrollback_bytes;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return SCROLLBACK_DEFAULT;
  return Math.max(SCROLLBACK_MIN, Math.min(SCROLLBACK_MAX, Math.floor(n)));
}
