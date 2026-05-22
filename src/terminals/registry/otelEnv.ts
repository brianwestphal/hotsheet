import { readFileSettings } from '../../file-settings.js';

/**
 * HS-8145 — pure helper that returns the OTLP env vars Hot Sheet
 * injects into spawned terminals so a `claude` invocation inside
 * that terminal exports telemetry to Hot Sheet's own OTLP receiver
 * (§67.3 / §67.5).
 *
 * Returns `{}` when the per-project `telemetry_enabled` setting is
 * not `true` — gated default-off so we never surprise a user with
 * telemetry export they didn't ask for.
 *
 * Returns the full env block when `telemetry_enabled === true`,
 * matching the contract documented in `docs/67-telemetry.md` §67.3:
 *
 *   CLAUDE_CODE_ENABLE_TELEMETRY=1
 *   OTEL_METRICS_EXPORTER=otlp                (if telemetry_metrics_enabled !== false)
 *   OTEL_LOGS_EXPORTER=otlp                   (if telemetry_logs_enabled !== false)
 *   OTEL_TRACES_EXPORTER=otlp                 (if telemetry_traces_enabled === true)
 *   CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1     (if telemetry_traces_enabled === true)
 *   OTEL_LOG_USER_PROMPTS=1                   (always, when telemetry_enabled === true — HS-8537)
 *   OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf (Claude Code default; matches §67.3)
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:<port>
 *   OTEL_RESOURCE_ATTRIBUTES=hotsheet_project=<secret>,working_dir=<dataDir>
 *
 * HS-8537 — `OTEL_LOG_USER_PROMPTS=1` is required for the per-ticket
 * cost rollup (§67.10.7 / HS-8152) to work. Without it, Claude Code
 * emits `claude_code.user_prompt` events with only metadata
 * (`prompt_length`, etc.); the prompt body is redacted. The HS-8151
 * marker `<!-- hotsheet:ticket=HS-NNNN -->` rides inside the prompt
 * body, so without the body the marker has nowhere to land + the
 * `getPerTicketRollup` LIKE query always matches zero rows. The
 * telemetry data stays local in PGLite, so logging the prompt content
 * is no worse than logging any other local telemetry — the user
 * already opted in by enabling telemetry.
 *
 * Pure: takes only `dataDir`, reads settings via `readFileSettings`,
 * returns the env block. The lifecycle code in `lifecycle.ts::buildEnv`
 * spreads it into the spawn env. Tests cover the on / off / per-signal
 * branches without spawning a real PTY.
 *
 * Notes:
 *
 *   - The `hotsheet_project` resource attribute is the routing key for
 *     `src/routes/otel.ts` (§67.5.3 anti-pollution gate) — the receiver
 *     drops payloads whose attribute value doesn't match a registered
 *     project secret. The value MUST be the project's actual secret
 *     from settings.json so the receiver can route correctly.
 *   - The protocol stays `http/protobuf` per §67.3 / Claude Code's
 *     default, even though the current Phase-2 persistence layer
 *     (HS-8470) only decodes JSON. Phase 2b adds protobuf decoding
 *     and at that point telemetry rows will actually land in PGLite
 *     from a Claude Code run. Until Phase 2b, the receiver still
 *     accepts protobuf bytes + returns 200 + logs the size — just no
 *     persistence yet.
 *   - When `port` or `secret` is missing from settings.json (extremely
 *     unusual — `ensureSecret` populates both at server startup) the
 *     helper still returns `{}` defensively. No bad env vars get
 *     written.
 */
export function buildOtelEnv(dataDir: string): Record<string, string> {
  const settings = readFileSettings(dataDir);
  if (settings.telemetry_enabled !== true) return {};

  const port = typeof settings.port === 'number' ? settings.port : null;
  const secret = typeof settings.secret === 'string' && settings.secret !== '' ? settings.secret : null;
  if (port === null || secret === null) return {};

  const metricsEnabled = settings.telemetry_metrics_enabled !== false;
  const logsEnabled = settings.telemetry_logs_enabled !== false;
  const tracesEnabled = settings.telemetry_traces_enabled === true;

  const env: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${String(port)}`,
    OTEL_RESOURCE_ATTRIBUTES: `hotsheet_project=${secret},working_dir=${dataDir}`,
    OTEL_LOG_USER_PROMPTS: '1',
  };

  if (metricsEnabled) env.OTEL_METRICS_EXPORTER = 'otlp';
  if (logsEnabled) env.OTEL_LOGS_EXPORTER = 'otlp';
  if (tracesEnabled) {
    env.OTEL_TRACES_EXPORTER = 'otlp';
    env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA = '1';
  }

  return env;
}
