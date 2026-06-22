import { existsSync, mkdtempSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { centralTelemetryDataDir } from './db/connection.js';
import { writeGlobalConfig } from './global-config.js';
import { globalHotsheetDir } from './global-dir.js';
import { writeInstanceFile } from './instance.js';
import { addToProjectList } from './project-list.js';
import { getStartupLogPath } from './startup-log.js';

// HS-8920 — one switch (`HOTSHEET_HOME`) relocates every global `~/.hotsheet`
// path so an isolated test instance touches none of the real global state.
// These tests pin the helper's contract AND that each routed resolver follows
// it — both the path it returns and (for the two pre-existing narrow overrides)
// the precedence: specific override → HOTSHEET_HOME → homedir()/.hotsheet.
describe('globalHotsheetDir (HS-8920)', () => {
  const SAVED_HOME = process.env.HOTSHEET_HOME;
  const SAVED_STARTUP = process.env.HOTSHEET_STARTUP_LOG;
  const SAVED_TELEMETRY = process.env.HOTSHEET_TELEMETRY_DIR;

  afterEach(() => {
    // Restore the env exactly so no test leaks a relocation into the next one
    // (or, worse, into the real ~/.hotsheet).
    if (SAVED_HOME === undefined) delete process.env.HOTSHEET_HOME;
    else process.env.HOTSHEET_HOME = SAVED_HOME;
    if (SAVED_STARTUP === undefined) delete process.env.HOTSHEET_STARTUP_LOG;
    else process.env.HOTSHEET_STARTUP_LOG = SAVED_STARTUP;
    if (SAVED_TELEMETRY === undefined) delete process.env.HOTSHEET_TELEMETRY_DIR;
    else process.env.HOTSHEET_TELEMETRY_DIR = SAVED_TELEMETRY;
  });

  describe('the helper itself', () => {
    it('returns HOTSHEET_HOME verbatim when set', () => {
      process.env.HOTSHEET_HOME = '/some/test/home';
      expect(globalHotsheetDir()).toBe('/some/test/home');
    });

    it('defaults to homedir()/.hotsheet when unset', () => {
      delete process.env.HOTSHEET_HOME;
      expect(globalHotsheetDir()).toBe(join(homedir(), '.hotsheet'));
    });

    it('ignores an empty or whitespace-only HOTSHEET_HOME', () => {
      const fallback = join(homedir(), '.hotsheet');
      process.env.HOTSHEET_HOME = '';
      expect(globalHotsheetDir()).toBe(fallback);
      process.env.HOTSHEET_HOME = '   ';
      expect(globalHotsheetDir()).toBe(fallback);
    });
  });

  // The path-only resolvers (no filesystem writes) — assert the resolved path
  // tracks HOTSHEET_HOME and that the narrow per-file override still wins.
  describe('path resolvers', () => {
    it('startup log: HOTSHEET_HOME relocates it; the narrow override still wins', () => {
      delete process.env.HOTSHEET_STARTUP_LOG;
      process.env.HOTSHEET_HOME = '/relocated';
      expect(getStartupLogPath()).toBe(join('/relocated', 'startup.log'));

      delete process.env.HOTSHEET_HOME;
      expect(getStartupLogPath()).toBe(join(homedir(), '.hotsheet', 'startup.log'));

      // Narrow override beats HOTSHEET_HOME.
      process.env.HOTSHEET_HOME = '/relocated';
      process.env.HOTSHEET_STARTUP_LOG = '/explicit/startup.log';
      expect(getStartupLogPath()).toBe('/explicit/startup.log');
    });

    it('central telemetry dir: HOTSHEET_HOME relocates it; the narrow override still wins', () => {
      delete process.env.HOTSHEET_TELEMETRY_DIR;
      process.env.HOTSHEET_HOME = '/relocated';
      expect(centralTelemetryDataDir()).toBe(join('/relocated', 'telemetry'));

      delete process.env.HOTSHEET_HOME;
      expect(centralTelemetryDataDir()).toBe(join(homedir(), '.hotsheet', 'telemetry'));

      // Narrow override beats HOTSHEET_HOME.
      process.env.HOTSHEET_HOME = '/relocated';
      process.env.HOTSHEET_TELEMETRY_DIR = '/explicit/telemetry';
      expect(centralTelemetryDataDir()).toBe('/explicit/telemetry');
    });
  });

  // The file-writing resolvers (private path getters) — assert the file lands
  // under HOTSHEET_HOME and the real ~/.hotsheet is never touched.
  describe('file-writing resolvers land under HOTSHEET_HOME', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'hs-global-dir-'));
      process.env.HOTSHEET_HOME = dir;
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('config.json is written under HOTSHEET_HOME', () => {
      writeGlobalConfig({ dashboard: { layoutMode: 'flow' } });
      expect(existsSync(join(dir, 'config.json'))).toBe(true);
    });

    it('projects.json is written under HOTSHEET_HOME', () => {
      addToProjectList(join(dir, 'some-project'));
      expect(existsSync(join(dir, 'projects.json'))).toBe(true);
    });

    it('instance.json is written under HOTSHEET_HOME', () => {
      writeInstanceFile(4274);
      expect(existsSync(join(dir, 'instance.json'))).toBe(true);
    });
  });
});
