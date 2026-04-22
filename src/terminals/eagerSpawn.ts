import { getErrorMessage } from '../utils/errorMessage.js';
import { listTerminalConfigs } from './config.js';
import { ensureSpawned } from './registry.js';

/**
 * Best-effort eager spawn of every non-lazy configured terminal for a project
 * (docs/22-terminal.md §22.17.8). Called on project registration and on any
 * PATCH /file-settings that writes the `terminals` array.
 *
 * Since HS-6337 the `terminals` list defaults to empty — there is no implicit
 * default terminal — so a freshly-initialized project never spawns a PTY
 * here. Only projects where the user has explicitly added a terminal with
 * `lazy: false` trigger an eager spawn. Web-only users never see the settings
 * tab that lets them configure terminals (HS-6437), so in practice only
 * Tauri-configured projects can reach this path.
 *
 * Idempotent: `ensureSpawned` skips terminals that already have a live (or
 * exited) session. Failures are logged but never thrown — a missing `node-pty`
 * binary or a broken shell should not take the whole server down.
 */
export function eagerSpawnTerminals(secret: string, dataDir: string): void {
  let configs;
  try {
    configs = listTerminalConfigs(dataDir);
  } catch (err) {
    console.warn(`[terminals] Failed to list configured terminals: ${getErrorMessage(err)}`);
    return;
  }
  for (const config of configs) {
    if (config.lazy !== false) continue; // lazy is the default; only eager terminals spawn here
    try {
      ensureSpawned(secret, dataDir, config.id);
    } catch (err) {
      console.warn(`[terminals] Eager-spawn failed for '${config.id}': ${getErrorMessage(err)}`);
    }
  }
}
