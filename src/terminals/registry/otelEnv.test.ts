/**
 * HS-8145 / HS-8684 — pure-helper tests for the spawn-env OTLP injector.
 * Verifies the §67.3 contract: HS-8684 default-on (undefined →
 * enabled), opt-out via `telemetry_enabled: false`, sub-toggles +
 * beta traces, defensive empties when port/secret missing.
 */
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildOtelEnv } from './otelEnv.js';

function makeDataDir(settings: Record<string, unknown>): string {
  const dir = join(tmpdir(), `hs-otel-env-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
  return dir;
}

describe('buildOtelEnv (HS-8145 / §67.3)', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const d of cleanup) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    cleanup.length = 0;
  });

  function dir(settings: Record<string, unknown>): string {
    const d = makeDataDir(settings);
    cleanup.push(d);
    return d;
  }

  it('returns the full env block when telemetry_enabled is missing (HS-8684 default-on)', () => {
    const d = dir({ secret: 'abc-secret', port: 4174 });
    const env = buildOtelEnv(d);
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain('hotsheet_project=abc-secret');
  });

  it('returns {} when telemetry_enabled is explicitly false (opt-out)', () => {
    const d = dir({ secret: 'abc', port: 4174, telemetry_enabled: false });
    expect(buildOtelEnv(d)).toEqual({});
  });

  it('returns the full env block when telemetry_enabled is true (default sub-toggles)', () => {
    const d = dir({ secret: 'abc-secret', port: 4174, telemetry_enabled: true });
    const env = buildOtelEnv(d);
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
    expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('http/protobuf');
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://localhost:4174');
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain('hotsheet_project=abc-secret');
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain(`working_dir=${d}`);
    // Default sub-toggles: metrics + logs ON, traces OFF.
    expect(env.OTEL_METRICS_EXPORTER).toBe('otlp');
    // HS-8599 — delta temporality rides alongside the metrics exporter so
    // Claude Code's cumulative cost/token counters aren't summed + inflated.
    expect(env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE).toBe('delta');
    expect(env.OTEL_LOGS_EXPORTER).toBe('otlp');
    expect(env.OTEL_TRACES_EXPORTER).toBeUndefined();
    expect(env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA).toBeUndefined();
  });

  // HS-8537 — without `OTEL_LOG_USER_PROMPTS=1` Claude Code redacts the
  // user_prompt body, which strips the `<!-- hotsheet:ticket=HS-NNNN -->`
  // marker the per-ticket cost rollup depends on (§67.10.7 / HS-8152).
  it('sets OTEL_LOG_USER_PROMPTS=1 whenever telemetry is enabled (so the per-ticket marker survives)', () => {
    const d = dir({ secret: 'abc', port: 4174, telemetry_enabled: true });
    expect(buildOtelEnv(d).OTEL_LOG_USER_PROMPTS).toBe('1');
  });

  it('still sets OTEL_LOG_USER_PROMPTS=1 when only metrics is enabled (logs/traces off)', () => {
    const d = dir({ secret: 'abc', port: 4174, telemetry_enabled: true, telemetry_logs_enabled: false });
    expect(buildOtelEnv(d).OTEL_LOG_USER_PROMPTS).toBe('1');
  });

  it('omits OTEL_LOG_USER_PROMPTS when telemetry is disabled', () => {
    const d = dir({ secret: 'abc', port: 4174, telemetry_enabled: false });
    expect(buildOtelEnv(d).OTEL_LOG_USER_PROMPTS).toBeUndefined();
  });

  it('omits OTEL_METRICS_EXPORTER + temporality preference when telemetry_metrics_enabled is false', () => {
    const d = dir({ secret: 'abc', port: 4174, telemetry_enabled: true, telemetry_metrics_enabled: false });
    const env = buildOtelEnv(d);
    expect(env.OTEL_METRICS_EXPORTER).toBeUndefined();
    expect(env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE).toBeUndefined();
    expect(env.OTEL_LOGS_EXPORTER).toBe('otlp');
  });

  it('omits OTEL_LOGS_EXPORTER when telemetry_logs_enabled is false', () => {
    const d = dir({ secret: 'abc', port: 4174, telemetry_enabled: true, telemetry_logs_enabled: false });
    const env = buildOtelEnv(d);
    expect(env.OTEL_METRICS_EXPORTER).toBe('otlp');
    expect(env.OTEL_LOGS_EXPORTER).toBeUndefined();
  });

  it('adds OTEL_TRACES_EXPORTER + CLAUDE_CODE_ENHANCED_TELEMETRY_BETA when telemetry_traces_enabled is true', () => {
    const d = dir({ secret: 'abc', port: 4174, telemetry_enabled: true, telemetry_traces_enabled: true });
    const env = buildOtelEnv(d);
    expect(env.OTEL_TRACES_EXPORTER).toBe('otlp');
    expect(env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA).toBe('1');
  });

  it('returns {} when secret is missing despite telemetry_enabled', () => {
    const d = dir({ port: 4174, telemetry_enabled: true });
    expect(buildOtelEnv(d)).toEqual({});
  });

  it('returns {} when port is missing despite telemetry_enabled', () => {
    const d = dir({ secret: 'abc', telemetry_enabled: true });
    expect(buildOtelEnv(d)).toEqual({});
  });

  it('returns {} when secret is the empty string', () => {
    const d = dir({ secret: '', port: 4174, telemetry_enabled: true });
    expect(buildOtelEnv(d)).toEqual({});
  });

  it('encodes the dataDir into OTEL_RESOURCE_ATTRIBUTES (working_dir)', () => {
    const d = dir({ secret: 'abc', port: 4174, telemetry_enabled: true });
    const env = buildOtelEnv(d);
    // HS-8713 — assert the actual dataDir is encoded, not that it begins with
    // `/`. On Windows the dataDir is a `C:\...` path with no leading slash, so
    // the old `/working_dir=\//` regex failed there.
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain(`working_dir=${d}`);
  });
});
