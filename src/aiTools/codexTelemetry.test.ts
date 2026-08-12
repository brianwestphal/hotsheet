/**
 * HS-9603 — the `-c` override that turns codex's OTLP exporter on.
 *
 * The value's SHAPE is the risky part: `exporter` is a tagged enum, so the
 * obvious `exporter="otlp-http"` is rejected by codex's own parser and the table
 * form is required. A malformed flag would break every codex terminal — the
 * HS-9594 failure mode — so the exact string is pinned here, and was verified
 * against `codex doctor` (which fails its `config` check on a bad override)
 * rather than inferred from the binary's strings.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _resetSettingsCacheForTests } from '../file-settings.js';
import { codexOtelConfigFlag, withCodexOtel } from './codexTelemetry.js';

let dataDir: string;

/** A project with a port + secret — the two things the flag needs. */
function writeSettings(extra: Record<string, unknown> = {}): void {
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ port: 4174, secret: 'sek', ...extra }));
  _resetSettingsCacheForTests();
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'hs-codex-otel-'));
  _resetSettingsCacheForTests();
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  _resetSettingsCacheForTests();
});

describe('codexOtelConfigFlag (HS-9603)', () => {
  it('emits the TABLE form of the tagged enum, not the bare string', () => {
    writeSettings();
    const flag = codexOtelConfigFlag(dataDir);
    // `otel.exporter="otlp-http"` is REJECTED by codex. The nested table is the
    // accepted spelling, and getting it wrong breaks the terminal.
    expect(flag).toContain('otel.exporter={otlp-http={');
    expect(flag).not.toMatch(/otel\.exporter="otlp-http"/);
  });

  it('points at this project\'s own server port', () => {
    writeSettings({ port: 4321 });
    expect(codexOtelConfigFlag(dataDir)).toContain('endpoint="http://localhost:4321/v1/logs"');
  });

  it('includes the /v1/logs path — codex uses this endpoint verbatim (HS-9621)', () => {
    // codex-cli 0.147.0 POSTs to this URL literally (no `/v1/*` append). Without
    // the path it hit `/` and Hot Sheet 404'd every batch, so no codex telemetry
    // ever landed. `/v1/logs` because codex exports token usage only as OTLP logs.
    writeSettings({ port: 4174 });
    const flag = codexOtelConfigFlag(dataDir);
    expect(flag).toContain('endpoint="http://localhost:4174/v1/logs"');
    expect(flag).not.toContain('endpoint="http://localhost:4174"'); // the pre-fix broken form
  });

  it('uses protobuf, matching what Claude already exports and the receiver decodes', () => {
    writeSettings();
    expect(codexOtelConfigFlag(dataDir)).toContain('protocol="binary"');
  });

  it('is single-quoted for the shell, and contains no single quote of its own', () => {
    // Single-quoting is total here only because the value has no `'` in it —
    // assert that rather than assume it, since a future field could break it.
    writeSettings();
    const flag = codexOtelConfigFlag(dataDir);
    expect(flag.startsWith("-c '")).toBe(true);
    expect(flag.endsWith("'")).toBe(true);
    expect(flag.slice(4, -1)).not.toContain("'");
  });

  it('is empty when the project opted OUT of telemetry', () => {
    // One switch governs both tools — codex must not keep exporting after the
    // user turned telemetry off for the project.
    writeSettings({ telemetry_enabled: false });
    expect(codexOtelConfigFlag(dataDir)).toBe('');
  });

  it('is present by default — only an explicit false opts out (HS-8684)', () => {
    writeSettings();
    expect(codexOtelConfigFlag(dataDir)).not.toBe('');
  });

  it('is empty when both metrics and logs are off — nothing left to export', () => {
    writeSettings({ telemetry_metrics_enabled: false, telemetry_logs_enabled: false });
    expect(codexOtelConfigFlag(dataDir)).toBe('');
  });

  it('is empty without a port or secret rather than emitting a broken flag', () => {
    // The secret is the §67.5.3 routing key; without it the receiver drops the
    // payload anyway, so the flag would be pure noise on the command line.
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ secret: 'sek' }));
    _resetSettingsCacheForTests();
    expect(codexOtelConfigFlag(dataDir)).toBe('');
  });
});

describe('withCodexOtel (HS-9603)', () => {
  it('inserts the flag after the binary, before any subcommand', () => {
    // `-c` is a GLOBAL option — codex rejects it after a subcommand.
    writeSettings();
    const out = withCodexOtel("codex --remote 'unix:///tmp/s.sock' -C '/proj'", dataDir);
    expect(out.startsWith('codex -c ')).toBe(true);
    // …and the rest of the launch line survives intact, quoting included.
    expect(out).toContain("--remote 'unix:///tmp/s.sock'");
    expect(out).toContain("-C '/proj'");
  });

  it('handles the plain `codex` form', () => {
    writeSettings();
    expect(withCodexOtel('codex', dataDir)).toMatch(/^codex -c '/);
  });

  it('returns the command untouched when telemetry is off', () => {
    // The caller needs no branch of its own, so this must be a true no-op.
    writeSettings({ telemetry_enabled: false });
    expect(withCodexOtel('codex --remote x', dataDir)).toBe('codex --remote x');
  });
});
