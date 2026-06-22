import { homedir } from 'os';
import { join } from 'path';

/**
 * HS-8920 — single switch for the location of all global Hot Sheet state.
 *
 * Every global path under `~/.hotsheet/` (config.json, projects.json,
 * instance.json, startup.log, telemetry/) used to be resolved by its own
 * independent `join(homedir(), '.hotsheet', …)` call, so there was no one place
 * to relocate them. This helper is that place: set `HOTSHEET_HOME` and every
 * global resolver that routes through here follows.
 *
 * The primary consumer is the isolated test instance (parent investigation
 * HS-8919): a `--test` launch points `HOTSHEET_HOME` at its own dir so it keeps
 * a separate registry / config / instance file / telemetry store and can't
 * touch the real `~/.hotsheet`.
 *
 * Precedence for the per-file overrides that predate this helper
 * (`HOTSHEET_STARTUP_LOG`, `HOTSHEET_TELEMETRY_DIR`): the specific override wins,
 * then `HOTSHEET_HOME`, then `homedir()/.hotsheet`. Those narrow overrides are
 * applied by their own modules; this helper only resolves the root.
 *
 * An empty or whitespace-only `HOTSHEET_HOME` is treated as unset so an
 * accidentally-exported blank var can't silently relocate state to the process
 * cwd.
 */
export function globalHotsheetDir(): string {
  const override = process.env.HOTSHEET_HOME;
  if (typeof override === 'string' && override.trim() !== '') return override;
  return join(homedir(), '.hotsheet');
}
