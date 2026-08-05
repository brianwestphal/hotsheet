/**
 * HS-9603 (docs/67 §67.16) — turn Codex's OpenTelemetry export ON for a Hot Sheet
 * terminal.
 *
 * ## Why a CLI flag and not env, and not `config.toml`
 *
 * Measured against codex-cli 0.146.0:
 *
 * - Codex **does** honour the standard `OTEL_EXPORTER_OTLP_*` env vars and
 *   `OTEL_RESOURCE_ATTRIBUTES`, and `buildOtelEnv` already injects those into
 *   *every* spawned terminal — so a codex terminal already knows the endpoint
 *   and carries the `hotsheet_project` routing attribute.
 * - But codex has **no** `OTEL_METRICS_EXPORTER` / `OTEL_LOGS_EXPORTER` — the
 *   strings are absent from the binary. Selecting an exporter is a *config*
 *   decision (`[otel] exporter`), and its default is off. That single gate is
 *   why no codex telemetry has ever reached Hot Sheet.
 * - Writing `~/.codex/config.toml` would work but mutates the user's GLOBAL
 *   config for a per-project, per-terminal concern. `codex -c key=value`
 *   overrides the same setting per invocation, touches no file, and composes
 *   with the launch line Hot Sheet already builds.
 *
 * ## The shape is not guessable — it was verified
 *
 * `exporter` is a TAGGED enum, so the obvious spelling is rejected:
 *
 * ```
 * codex -c 'otel.exporter="otlp-http"'                                   ✗ rejected
 * codex -c 'otel.exporter={otlp-http={endpoint="…",protocol="binary"}}'  ✓ accepted
 * codex -c 'otel.exporter="none"'                                        ✓ accepted
 * ```
 *
 * Checked with `codex doctor`, which fails its `config` check on a malformed
 * override — so the flag below is validated by codex's own parser rather than
 * inferred. That matters: a bad flag would break every codex terminal, which is
 * the HS-9594 failure mode.
 *
 * `protocol="binary"` (protobuf) matches the `http/protobuf` Claude already
 * uses; Hot Sheet's receiver decodes both (`routes/otel.ts`, HS-8471).
 */
import { readFileSettings } from '../file-settings.js';
import { getProjectSecret } from '../secret-file.js';

/**
 * The `-c` override that points codex's OTLP exporter at Hot Sheet, or `''` when
 * telemetry is off for this project / the project isn't fully set up.
 *
 * Gated on the same `telemetry_enabled` setting as `buildOtelEnv` — default-on,
 * only an explicit `false` opts out (HS-8684) — so one switch governs both tools
 * rather than codex needing its own.
 *
 * Single-quoted for the shell, matching `codexTerminalRemoteCommand`'s
 * convention. The value contains `"` but no `'`, so single-quoting is total here.
 */
export function codexOtelConfigFlag(dataDir: string): string {
  const settings = readFileSettings(dataDir);
  if (settings.telemetry_enabled === false) return '';
  // Metrics carry the token counters; with them off there is nothing codex would
  // usefully export, and `buildOtelEnv` has already suppressed Claude's too.
  if (settings.telemetry_metrics_enabled === false && settings.telemetry_logs_enabled === false) return '';

  const port = typeof settings.port === 'number' ? settings.port : null;
  // The secret is the §67.5.3 routing key. Without it the receiver would drop
  // the payload anyway, so emitting the flag would only add noise.
  if (port === null || getProjectSecret(dataDir) === '') return '';

  const endpoint = `http://localhost:${String(port)}`;
  return `-c 'otel.exporter={otlp-http={endpoint="${endpoint}",protocol="binary"}}'`;
}

/** Append the flag to a codex launch line. Returns `command` unchanged when
 *  telemetry is off, so the caller needs no branch of its own. */
export function withCodexOtel(command: string, dataDir: string): string {
  const flag = codexOtelConfigFlag(dataDir);
  if (flag === '') return command;
  // `-c` is a GLOBAL option, so it has to precede any subcommand. Every codex
  // launch line Hot Sheet builds starts with the bare binary, so inserting
  // directly after it is correct for both the plain and `--remote` forms.
  const [bin, ...rest] = command.split(' ');
  return [bin, flag, ...rest].join(' ');
}
