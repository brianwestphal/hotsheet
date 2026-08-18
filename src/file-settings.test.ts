import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetSettingsCacheForTests,
  _settingsParseCountForTests,
  clearLocalOverrides,
  defaultScope,
  ensureSecret,
  getBackupDir,
  invalidateSettingsCache,
  migrateLocalScopedKeys,
  readFileSettings,
  readLocalSettings,
  readSharedSettings,
  resolveAuthoritativeDataDir,
  writeFileSettings,
  writeSettingsLayer,
} from './file-settings.js';
import { readSecretFile, writeSecretFile } from './secret-file.js';
import type { CommandItem } from './settingsCommandDelta.js';

let tempDir: string;

beforeAll(() => {
  tempDir = join(tmpdir(), `hs-settings-test-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// HS-9600 — the settings files are cached for 5s. Every existing test in this
// file writes and immediately re-reads, so they exercise the write-invalidation
// path; the reset keeps one test's cache from leaking into the next (they share
// `tempDir`, so paths collide).
beforeEach(() => { _resetSettingsCacheForTests(); });

describe('readFileSettings', () => {
  it('returns empty object if file missing', () => {
    expect(readFileSettings(join(tempDir, 'nonexistent'))).toEqual({});
  });

  it('returns parsed settings', () => {
    const dir = join(tempDir, 'valid');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ appName: 'Test' }));
    const result = readFileSettings(dir);
    expect(result.appName).toBe('Test');
  });

  it('returns empty object for corrupt file', () => {
    const dir = join(tempDir, 'corrupt');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), 'not valid json');
    expect(readFileSettings(dir)).toEqual({});
  });
});

describe('writeFileSettings', () => {
  it('creates settings file', () => {
    const dir = join(tempDir, 'create');
    mkdirSync(dir, { recursive: true });
    const result = writeFileSettings(dir, { appName: 'New' });
    expect(result.appName).toBe('New');
  });

  it('merges into existing settings', () => {
    const dir = join(tempDir, 'merge');
    mkdirSync(dir, { recursive: true });
    writeFileSettings(dir, { appName: 'First' });
    const result = writeFileSettings(dir, { backupDir: '/custom' });
    expect(result.appName).toBe('First');
    expect(result.backupDir).toBe('/custom');
  });

  // HS-9695 — the write is atomic (temp + rename), so a concurrent reader never sees a
  // torn file. Guard that the rename completes and leaves no `.tmp` litter behind.
  it('writes atomically and leaves no leftover .tmp file', () => {
    const dir = join(tempDir, 'atomic');
    mkdirSync(dir, { recursive: true });
    writeFileSettings(dir, { appName: 'Atomic', port: 4174 });
    const leftovers = readdirSync(dir).filter(f => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
    // Both layers written this way (port is a local-scope key → settings.local.json).
    expect(readFileSync(join(dir, 'settings.json'), 'utf-8')).toContain('Atomic');
    expect(readdirSync(dir).filter(f => f.includes('.tmp'))).toEqual([]);
  });
});

describe('getBackupDir', () => {
  it('returns default if not configured', () => {
    const dir = join(tempDir, 'default-backup');
    mkdirSync(dir, { recursive: true });
    expect(getBackupDir(dir)).toBe(join(dir, 'backups'));
  });

  it('returns custom dir if configured', () => {
    const dir = join(tempDir, 'custom-backup');
    mkdirSync(dir, { recursive: true });
    writeFileSettings(dir, { backupDir: '/custom/backups' });
    expect(getBackupDir(dir)).toBe('/custom/backups');
  });
});

describe('ensureSecret', () => {
  it('generates a new secret when none exists', () => {
    const dir = join(tempDir, 'secret-new');
    mkdirSync(dir, { recursive: true });
    const secret = ensureSecret(dir, 4174);
    expect(secret).toBeTruthy();
    expect(secret).toHaveLength(32);
    // HS-8999 — persisted to the secret.json sidecar, NOT settings.json.
    const sidecar = readSecretFile(dir);
    expect(sidecar.secret).toBe(secret);
    expect(sidecar.secretPathHash).toBeTruthy();
    const settings = readFileSettings(dir);
    expect(settings.secret).toBeUndefined();
    expect(settings.port).toBe(4174); // port stays in settings.json
  });

  it('returns existing secret when path hash matches', () => {
    const dir = join(tempDir, 'secret-existing');
    mkdirSync(dir, { recursive: true });
    const secret1 = ensureSecret(dir, 4174);
    const secret2 = ensureSecret(dir, 4174);
    expect(secret2).toBe(secret1);
  });

  it('updates port without regenerating secret', () => {
    const dir = join(tempDir, 'secret-port');
    mkdirSync(dir, { recursive: true });
    const secret1 = ensureSecret(dir, 4174);
    const secret2 = ensureSecret(dir, 4175);
    expect(secret2).toBe(secret1);
    // Verify port was updated
    const settings = readFileSettings(dir);
    expect(settings.port).toBe(4175);
  });

  it('regenerates secret when path hash changes', () => {
    const dir = join(tempDir, 'secret-rehash');
    mkdirSync(dir, { recursive: true });
    const secret1 = ensureSecret(dir, 4174);
    // HS-8999 — the path hash lives in the sidecar now; tamper it to simulate a
    // directory move so ensureSecret regenerates.
    writeSecretFile(dir, { secret: secret1, secretPathHash: 'wrong-hash' });
    const secret2 = ensureSecret(dir, 4174);
    expect(secret2).not.toBe(secret1);
    expect(secret2).toHaveLength(32);
  });

  it('regenerates secret when secretPathHash is missing', () => {
    const dir = join(tempDir, 'secret-nohash');
    mkdirSync(dir, { recursive: true });
    // Write a secret without a path hash (simulating old data)
    writeFileSettings(dir, { secret: 'old-secret-value' });
    const secret = ensureSecret(dir, 4174);
    expect(secret).not.toBe('old-secret-value');
    expect(secret).toHaveLength(32);
  });

  it('generates unique secrets for different directories', () => {
    const dir1 = join(tempDir, 'secret-unique-1');
    const dir2 = join(tempDir, 'secret-unique-2');
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    const secret1 = ensureSecret(dir1, 4174);
    const secret2 = ensureSecret(dir2, 4174);
    expect(secret1).not.toBe(secret2);
  });
});

describe('writeFileSettings edge cases', () => {
  it('overwrites existing keys with new values', () => {
    const dir = join(tempDir, 'overwrite');
    mkdirSync(dir, { recursive: true });
    writeFileSettings(dir, { appName: 'First' });
    writeFileSettings(dir, { appName: 'Second' });
    const settings = readFileSettings(dir);
    expect(settings.appName).toBe('Second');
  });

  it('writes valid JSON with trailing newline', () => {
    const dir = join(tempDir, 'json-format');
    mkdirSync(dir, { recursive: true });
    writeFileSettings(dir, { appName: 'Test' });
    const raw = readFileSync(join(dir, 'settings.json'), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(raw) as unknown).not.toThrow();
  });

  it('handles writing to non-existent file (create from scratch)', () => {
    const dir = join(tempDir, 'fresh-write');
    mkdirSync(dir, { recursive: true });
    const result = writeFileSettings(dir, { port: 4174, appIcon: 'red' });
    expect(result.port).toBe(4174);
    expect(result.appIcon).toBe('red');
  });

  it('preserves all existing keys when adding new ones', () => {
    const dir = join(tempDir, 'preserve-all');
    mkdirSync(dir, { recursive: true });
    writeFileSettings(dir, { appName: 'App', backupDir: '/backup', port: 4174 });
    writeFileSettings(dir, { appIcon: 'blue' });
    const settings = readFileSettings(dir);
    expect(settings.appName).toBe('App');
    expect(settings.backupDir).toBe('/backup');
    expect(settings.port).toBe(4174);
    expect(settings.appIcon).toBe('blue');
  });
});

/**
 * HS-8290 — six dashboard-related keys (visibility_groupings,
 * active_visibility_grouping_id, hidden_terminals, dashboard_layout_mode,
 * dashboard_columns_per_row, dashboard_slider_value) moved to global
 * config (~/.hotsheet/config.json under `dashboard`). The reader strips
 * them from the in-memory shape so old per-project settings.json files
 * stop surfacing stale values; the next writeFileSettings then drops
 * them from disk via the read-merge-write flow.
 */
describe('HS-8290 — dashboard keys stripped on read + dropped on next write', () => {
  const dataDir = join(tmpdir(), `hs-fs-8290-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dataDir, { recursive: true });

  it('readFileSettings drops every HS-8290 dead key from the in-memory shape', () => {
    const settingsPath = join(dataDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      appName: 'keepme',
      visibility_groupings: [{ id: 'default', name: 'D', hiddenIds: ['x'] }],
      active_visibility_grouping_id: 'default',
      hidden_terminals: ['x'],
      dashboard_layout_mode: 'flat',
      dashboard_columns_per_row: 5,
      dashboard_slider_value: 33,
    }));
    const out = readFileSettings(dataDir);
    expect(out.appName).toBe('keepme');
    expect(out.visibility_groupings).toBeUndefined();
    expect(out.active_visibility_grouping_id).toBeUndefined();
    expect(out.hidden_terminals).toBeUndefined();
    expect(out.dashboard_layout_mode).toBeUndefined();
    expect(out.dashboard_columns_per_row).toBeUndefined();
    expect(out.dashboard_slider_value).toBeUndefined();
  });

  it('next writeFileSettings persists the cleaned shape to disk', () => {
    const settingsPath = join(dataDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      appName: 'keepme',
      visibility_groupings: [{ id: 'default', name: 'D', hiddenIds: [] }],
      hidden_terminals: ['stale'],
    }));
    writeFileSettings(dataDir, { appName: 'updated' });
    const onDisk = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    expect(onDisk.appName).toBe('updated');
    expect(onDisk.visibility_groupings).toBeUndefined();
    expect(onDisk.hidden_terminals).toBeUndefined();
  });
});

/**
 * HS-9002 — shared (`settings.json`, committed) vs local (`settings.local.json`,
 * gitignored) settings split. The app reads a merged view with `local` winning;
 * writes route each key to its default layer; a startup migration relocates
 * machine-local keys out of a committed settings.json.
 */
describe('HS-9002 — shared/local settings split', () => {
  function freshDir(name: string): string {
    const dir = join(tempDir, `split-${name}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  const sharedPath = (d: string) => join(d, 'settings.json');
  const localPath = (d: string) => join(d, 'settings.local.json');
  const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;

  describe('defaultScope', () => {
    it('classifies machine-local keys as local', () => {
      for (const k of ['backupDir', 'port', 'permission_allow_rules', 'terminal_prompt_allow_rules',
        'announcer_ai_key_id', 'announcer_last_listened_at', 'notify_permission',
        'detail_width', 'drawer_open']) {
        expect(defaultScope(k)).toBe('local');
      }
    });
    // HS-9005 (docs/95 §95.4) — personal/machine settings reclassified shared → local.
    it('classifies HS-9005 personal/machine preferences as local', () => {
      for (const k of ['hide_verified_column', 'sort_by', 'sort_dir', 'layout', 'notify_completed',
        'auto_order', 'shell_integration_ui', 'terminal_scrollback_bytes',
        'terminal_default', 'confirm_quit_with_running_terminals', 'quit_confirm_exempt_processes',
        'db_snapshot_protection', 'telemetry_enabled', 'telemetry_metrics_enabled',
        'telemetry_logs_enabled', 'telemetry_traces_enabled', 'telemetry_retention_days',
        'announcer_dismissed_topics']) {
        expect(defaultScope(k)).toBe('local');
      }
    });
    it('classifies *_nudge_dismissed suffix keys as local', () => {
      expect(defaultScope('ai_instructions_nudge_dismissed')).toBe('local');
    });
    it('keeps genuinely team/project keys shared', () => {
      // appName + ticketPrefix are shared-only (no local override — docs/95 §95.4 Q2);
      // categories is shared-only; the cleanup-days + worklist preamble stay team policy.
      for (const k of ['appName', 'ticketPrefix', 'worklist_preamble', 'categories', 'custom_commands',
        'custom_views', 'terminals', 'auto_context', 'trash_cleanup_days', 'completed_cleanup_days',
        'verified_cleanup_days', 'channel_enabled',
        // HS-9222 — the AI Review Notes inducement is a repo/team property (like
        // committing `.pr-notes/`), so it defaults to the shared layer.
        'aiReviewNotes']) {
        expect(defaultScope(k)).toBe('shared');
      }
    });
  });

  it('readFileSettings merges both layers with local winning', () => {
    const dir = freshDir('merge');
    writeFileSync(sharedPath(dir), JSON.stringify({ appName: 'Team', backupDir: '/team/default' }));
    writeFileSync(localPath(dir), JSON.stringify({ backupDir: '/me/local', port: 4180 }));
    const resolved = readFileSettings(dir);
    expect(resolved.appName).toBe('Team');     // only shared
    expect(resolved.backupDir).toBe('/me/local'); // local overrides shared
    expect(resolved.port).toBe(4180);           // only local
  });

  // HS-9010a — readFileSettings applies element-level deltas for the delta keys.
  it('readFileSettings applies a local element-level delta to a shared list key', () => {
    const dir = freshDir('delta');
    writeFileSync(sharedPath(dir), JSON.stringify({
      custom_views: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
    }));
    writeFileSync(localPath(dir), JSON.stringify({
      custom_views: { hidden: ['b'], overrides: { a: { name: 'A2' } }, added: [{ id: 'x', name: 'Local X' }] },
    }));
    const views = readFileSettings(dir).custom_views;
    expect(Array.isArray(views)).toBe(true);
    const arr = views as { id: string; name: string }[];
    expect(arr.map(v => v.id)).toEqual(['a', 'c', 'x']); // b hidden, x appended
    expect(arr.find(v => v.id === 'a')?.name).toBe('A2'); // override applied
  });

  // HS-9010c/HS-9014 — readFileSettings applies the tree-aware delta for custom_commands.
  it('readFileSettings resolves a local custom_commands tree delta (hide/override/group-add/orphan)', () => {
    const dir = freshDir('cmd-delta');
    writeFileSync(sharedPath(dir), JSON.stringify({
      custom_commands: [
        { id: 'cmd-a', name: 'A', prompt: 'pa' },
        { id: 'cmd-b', name: 'B', prompt: 'pb' },
        { type: 'group', id: 'grp-1', name: 'G', children: [{ id: 'cmd-c', name: 'C', prompt: 'pc' }] },
      ],
    }));
    writeFileSync(localPath(dir), JSON.stringify({
      custom_commands: {
        hidden: ['cmd-a'],
        overrides: { 'cmd-b': { name: 'B2' } },
        childAdded: { 'grp-1': { group: { id: 'grp-1', name: 'G' }, children: [{ id: 'cmd-local', name: 'L', prompt: 'pl' }] } },
        added: [{ id: 'cmd-x', name: 'X', prompt: 'px' }],
      },
    }));
    const cmds = readFileSettings(dir).custom_commands as CommandItem[];
    expect(cmds.map(c => c.id)).toEqual(['cmd-b', 'grp-1', 'cmd-x']); // a hidden, x appended
    expect(cmds.find(c => c.id === 'cmd-b')?.name).toBe('B2'); // override applied
    const grp = cmds.find(c => c.id === 'grp-1');
    expect(grp && 'children' in grp ? grp.children.map(ch => ch.id) : []).toEqual(['cmd-c', 'cmd-local']);
  });

  it('readFileSettings leaves custom_commands untouched when local is a plain array', () => {
    const dir = freshDir('cmd-legacy');
    writeFileSync(sharedPath(dir), JSON.stringify({ custom_commands: [{ id: 's', name: 'S', prompt: 'ps' }] }));
    writeFileSync(localPath(dir), JSON.stringify({ custom_commands: [{ id: 'l', name: 'L', prompt: 'pl' }] }));
    const cmds = readFileSettings(dir).custom_commands as { id: string }[];
    expect(cmds.map(c => c.id)).toEqual(['l']); // local wins wholesale
  });

  it('readFileSettings is unchanged when the local value is a plain array (legacy whole-replacement)', () => {
    const dir = freshDir('delta-legacy');
    writeFileSync(sharedPath(dir), JSON.stringify({ terminals: [{ id: 'shared', name: 'S' }] }));
    writeFileSync(localPath(dir), JSON.stringify({ terminals: [{ id: 'localwins', name: 'L' }] }));
    const terms = readFileSettings(dir).terminals as { id: string }[];
    expect(terms.map(t => t.id)).toEqual(['localwins']); // local wins wholesale, exactly as pre-HS-9010a
  });

  // HS-9210 — an EMPTY delta object `{}` (written when Local mode saves with no
  // changes) must resolve to the shared list, NOT clobber it. Pre-fix the
  // `{...shared, ...local}` spread set the effective value to `{}` (which the
  // editor read as "every shared item locally hidden").
  it('readFileSettings resolves an empty {} delta to the shared list (terminals)', () => {
    const dir = freshDir('empty-delta-terminals');
    writeFileSync(sharedPath(dir), JSON.stringify({
      terminals: [{ id: 'claude', name: 'Claude', command: '{{claudeCommand}}' }],
    }));
    writeFileSync(localPath(dir), JSON.stringify({ terminals: {} }));
    const terms = readFileSettings(dir).terminals;
    expect(Array.isArray(terms)).toBe(true);
    expect((terms as { id: string }[]).map(t => t.id)).toEqual(['claude']); // not hidden
  });

  it('readFileSettings resolves an empty {} delta to the shared list (auto_context)', () => {
    const dir = freshDir('empty-delta-context');
    writeFileSync(sharedPath(dir), JSON.stringify({
      auto_context: [{ type: 'category', key: 'feature', text: 'F' }, { type: 'category', key: 'bug', text: 'B' }],
    }));
    writeFileSync(localPath(dir), JSON.stringify({ auto_context: {} }));
    const ctx = readFileSettings(dir).auto_context;
    expect(Array.isArray(ctx)).toBe(true);
    expect((ctx as { key: string }[]).map(c => c.key)).toEqual(['feature', 'bug']); // none disabled
  });

  it('readFileSettings resolves an empty {} delta to the shared tree (custom_commands)', () => {
    const dir = freshDir('empty-delta-cmds');
    writeFileSync(sharedPath(dir), JSON.stringify({
      custom_commands: [{ id: 'cmd-a', name: 'A', prompt: 'pa' }],
    }));
    writeFileSync(localPath(dir), JSON.stringify({ custom_commands: {} }));
    const cmds = readFileSettings(dir).custom_commands;
    expect(Array.isArray(cmds)).toBe(true);
    expect((cmds as { id: string }[]).map(c => c.id)).toEqual(['cmd-a']); // not hidden
  });

  it('readSharedSettings / readLocalSettings read only their own file', () => {
    const dir = freshDir('isolation');
    writeFileSync(sharedPath(dir), JSON.stringify({ appName: 'Team', backupDir: '/team' }));
    writeFileSync(localPath(dir), JSON.stringify({ backupDir: '/me' }));
    expect(readSharedSettings(dir).backupDir).toBe('/team');
    expect(readSharedSettings(dir).port).toBeUndefined();
    expect(readLocalSettings(dir).backupDir).toBe('/me');
    expect(readLocalSettings(dir).appName).toBeUndefined();
  });

  it('writeFileSettings routes each key to its default layer on disk', () => {
    const dir = freshDir('route');
    writeFileSettings(dir, { appName: 'Routed', backupDir: '/my/backups', port: 4199 });
    const shared = readJson(sharedPath(dir));
    const local = readJson(localPath(dir));
    expect(shared.appName).toBe('Routed');
    expect(shared.backupDir).toBeUndefined();   // local-scoped → NOT in committed file
    expect(shared.port).toBeUndefined();
    expect(local.backupDir).toBe('/my/backups');
    expect(local.port).toBe(4199);
    expect(local.appName).toBeUndefined();
  });

  it('getBackupDir resolves a local-layer override', () => {
    const dir = freshDir('backupdir');
    writeFileSync(localPath(dir), JSON.stringify({ backupDir: '/local/backups' }));
    expect(getBackupDir(dir)).toBe('/local/backups');
  });

  it('writeSettingsLayer writes the chosen layer regardless of key default', () => {
    const dir = freshDir('explicit-layer');
    // Force a normally-local key (backupDir) into the SHARED file (a team default).
    writeSettingsLayer(dir, 'shared', { backupDir: '/team/shared-backups' });
    expect(readJson(sharedPath(dir)).backupDir).toBe('/team/shared-backups');
    // Force a normally-shared key (appName) into the LOCAL file (a personal override).
    writeSettingsLayer(dir, 'local', { appName: 'My Name' });
    expect(readJson(localPath(dir)).appName).toBe('My Name');
    expect(readFileSettings(dir).appName).toBe('My Name'); // local wins on resolve
  });

  it('clearLocalOverrides removes a local key so the shared value re-applies', () => {
    const dir = freshDir('reset');
    writeFileSync(sharedPath(dir), JSON.stringify({ backupDir: '/team' }));
    writeSettingsLayer(dir, 'local', { backupDir: '/me' });
    expect(readFileSettings(dir).backupDir).toBe('/me');
    clearLocalOverrides(dir, ['backupDir']);
    expect(readLocalSettings(dir).backupDir).toBeUndefined();
    expect(readFileSettings(dir).backupDir).toBe('/team'); // falls back to shared
  });

  describe('migrateLocalScopedKeys', () => {
    it('relocates machine-local keys out of a committed settings.json', () => {
      const dir = freshDir('migrate');
      writeFileSync(sharedPath(dir), JSON.stringify({
        appName: 'Team',
        categories: [{ id: 'bug', label: 'Bug' }],
        backupDir: '/Users/me/Drive/backups',
        port: 4174,
        permission_allow_rules: [{ id: 'x' }],
      }));
      migrateLocalScopedKeys(dir);
      const shared = readJson(sharedPath(dir));
      const local = readJson(localPath(dir));
      // Shareable keys stay committed.
      expect(shared.appName).toBe('Team');
      expect(shared.categories).toBeDefined();
      // Machine-local keys are gone from the committed file...
      expect(shared.backupDir).toBeUndefined();
      expect(shared.port).toBeUndefined();
      expect(shared.permission_allow_rules).toBeUndefined();
      // ...and now live in the gitignored local file.
      expect(local.backupDir).toBe('/Users/me/Drive/backups');
      expect(local.port).toBe(4174);
      expect(local.permission_allow_rules).toBeDefined();
    });

    it('is idempotent and a no-op on a clean shared file', () => {
      const dir = freshDir('migrate-idem');
      writeFileSync(sharedPath(dir), JSON.stringify({ appName: 'Team', backupDir: '/x' }));
      migrateLocalScopedKeys(dir);
      const afterFirst = readJson(sharedPath(dir));
      migrateLocalScopedKeys(dir); // second run
      expect(readJson(sharedPath(dir))).toEqual(afterFirst);
      expect(readJson(localPath(dir)).backupDir).toBe('/x');
    });

    it('does not clobber an existing local override (local wins)', () => {
      const dir = freshDir('migrate-noclobber');
      writeFileSync(sharedPath(dir), JSON.stringify({ backupDir: '/stale-shared' }));
      writeFileSync(localPath(dir), JSON.stringify({ backupDir: '/my-real-local' }));
      migrateLocalScopedKeys(dir);
      expect(readJson(localPath(dir)).backupDir).toBe('/my-real-local'); // preserved
      expect(readJson(sharedPath(dir)).backupDir).toBeUndefined();       // stale copy stripped
    });

    it('does nothing when settings.json is absent', () => {
      const dir = freshDir('migrate-absent');
      expect(() => migrateLocalScopedKeys(dir)).not.toThrow();
    });
  });
});

describe('resolveAuthoritativeDataDir (HS-8934 — git-worktree follower)', () => {
  function makeDir(name: string, settings?: Record<string, unknown>): string {
    const dir = join(tempDir, 'wt', name);
    mkdirSync(dir, { recursive: true });
    if (settings) writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
    return dir;
  }

  it('returns the (resolved) input dir when there is no pointer', () => {
    const owner = makeDir('owner-noptr', { appName: 'Owner' });
    expect(resolveAuthoritativeDataDir(owner)).toBe(owner);
  });

  it('returns the input dir when settings.json is absent', () => {
    const dir = makeDir('no-settings');
    expect(resolveAuthoritativeDataDir(dir)).toBe(dir);
  });

  it('redirects a follower to its authoritative owner', () => {
    const owner = makeDir('owner-a', { appName: 'Owner A' });
    const follower = makeDir('follower-a', { authoritativeDataDir: owner });
    expect(resolveAuthoritativeDataDir(follower)).toBe(owner);
  });

  it('treats an empty/whitespace pointer as no pointer', () => {
    const dir = makeDir('blank-ptr', { authoritativeDataDir: '   ' });
    expect(resolveAuthoritativeDataDir(dir)).toBe(dir);
  });

  it('throws on a self-referential pointer', () => {
    const dir = makeDir('self-ptr');
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ authoritativeDataDir: dir }));
    expect(() => resolveAuthoritativeDataDir(dir)).toThrow(/points at itself/);
  });

  it('throws when the target does not exist', () => {
    const follower = makeDir('follower-missing', { authoritativeDataDir: join(tempDir, 'wt', 'does-not-exist') });
    expect(() => resolveAuthoritativeDataDir(follower)).toThrow(/does not exist/);
  });

  it('throws on a chained follower (target is itself a follower)', () => {
    const owner = makeDir('owner-chain', { appName: 'Owner' });
    const mid = makeDir('mid-chain', { authoritativeDataDir: owner });
    const follower = makeDir('follower-chain', { authoritativeDataDir: mid });
    expect(() => resolveAuthoritativeDataDir(follower)).toThrow(/chains not allowed/);
  });
});

/**
 * HS-9600 — the settings cache. A cache is a state machine, so these walk
 * SEQUENCES (§"Transition-matrix testing"): the single-read tests above would
 * pass against a cache that never invalidated, which is the failure that
 * matters — "I changed a setting and it didn't take".
 */
describe('settings cache (HS-9600)', () => {
  let dir: string;
  let clock: number;

  beforeEach(() => {
    dir = join(tempDir, `cache-${String(Date.now())}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    clock = 1_000_000;
    _resetSettingsCacheForTests(() => clock);
  });

  it('does not re-read or re-parse while the file is unchanged', () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ appName: 'first' }));
    readFileSettings(dir);
    const after1 = _settingsParseCountForTests();
    for (let i = 0; i < 20; i++) expect(readFileSettings(dir).appName).toBe('first');
    // The point of the whole change: 20 more reads, zero extra parses.
    expect(_settingsParseCountForTests()).toBe(after1);
  });

  it('picks up an out-of-process edit IMMEDIATELY, not after the TTL', () => {
    // The stamp check (mtime+size) is what buys this. A blind TTL would have
    // made a hand-edited settings.json invisible for seconds — and ~20 test
    // files, plus anything that edits the file outside this module, would have
    // silently read stale values.
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ appName: 'first' }));
    expect(readFileSettings(dir).appName).toBe('first');
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ appName: 'edited-by-hand' }));
    expect(readFileSettings(dir).appName).toBe('edited-by-hand');
  });

  it('re-reads once the TTL expires even when the stamp is unchanged', () => {
    // The TTL is a ceiling behind the stamp — insurance against a filesystem
    // with coarse mtime granularity, where two writes could share a stamp.
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ appName: 'first' }));
    readFileSettings(dir);
    const before = _settingsParseCountForTests();
    clock += 4_000;
    readFileSettings(dir);
    expect(_settingsParseCountForTests(), 'inside the TTL').toBe(before);
    clock += 2_000;
    readFileSettings(dir);
    expect(_settingsParseCountForTests(), 'past the TTL').toBe(before + 1);
  });

  it('caches the absent-file answer too', () => {
    // A brand-new project reads `{}` constantly; that should not re-probe.
    readFileSettings(dir);
    const before = _settingsParseCountForTests();
    readFileSettings(dir);
    readFileSettings(dir);
    expect(_settingsParseCountForTests()).toBe(before);
  });

  it('an in-process write is visible IMMEDIATELY, not after the TTL', () => {
    // The sequence that matters: a user changing a setting must never wait.
    writeFileSettings(dir, { appName: 'before' });
    expect(readFileSettings(dir).appName).toBe('before');
    writeFileSettings(dir, { appName: 'after' });
    expect(readFileSettings(dir).appName).toBe('after');
  });

  it('invalidates for the LAYER writers too, not just writeFileSettings', () => {
    // `writeSettingsLayer` writes its file directly. A cache hooked only to
    // `writeFileSettings` would go stale here — the docs/95 scope-layer moves.
    writeSettingsLayer(dir, 'shared', { appName: 'shared-v1' });
    expect(readFileSettings(dir).appName).toBe('shared-v1');
    writeSettingsLayer(dir, 'local', { appName: 'local-v1' });
    expect(readFileSettings(dir).appName, 'local wins and is fresh').toBe('local-v1');
    writeSettingsLayer(dir, 'local', { appName: 'local-v2' });
    expect(readFileSettings(dir).appName).toBe('local-v2');
  });

  it('invalidates when a local override is CLEARED', () => {
    // `clearLocalOverrides` is one of the direct-write paths; a stale cache here
    // would leave a "Reset to shared" click looking like it did nothing.
    writeSettingsLayer(dir, 'shared', { appName: 'shared-value' });
    writeSettingsLayer(dir, 'local', { appName: 'local-value' });
    expect(readFileSettings(dir).appName).toBe('local-value');
    clearLocalOverrides(dir, ['appName']);
    expect(readFileSettings(dir).appName).toBe('shared-value');
  });

  it('keys by path, so two projects never share an entry', () => {
    const other = join(tempDir, `cache-other-${Math.random().toString(36).slice(2)}`);
    mkdirSync(other, { recursive: true });
    writeFileSettings(dir, { appName: 'project-a' });
    writeFileSettings(other, { appName: 'project-b' });
    expect(readFileSettings(dir).appName).toBe('project-a');
    expect(readFileSettings(other).appName).toBe('project-b');
    // …and the shared/local layers of ONE project don't collide either.
    writeSettingsLayer(dir, 'local', { appName: 'project-a-local' });
    expect(readSharedSettings(dir).appName).toBe('project-a');
    expect(readLocalSettings(dir).appName).toBe('project-a-local');
  });

  it('hands out a COPY — a caller mutating a nested value cannot poison the cache', () => {
    // The regression this guards is created BY caching. Before it, every call
    // re-parsed from disk, so an in-place edit was harmless. `readFileSettings`
    // merges the layers shallowly, so a shared reference would let one caller's
    // mutation reach every other reader for the rest of the TTL.
    writeFileSettings(dir, { terminals: [{ id: 'a', command: 'bash' }] });
    const first = readFileSettings(dir);
    (first.terminals as { id: string }[])[0].id = 'MUTATED';
    (first.terminals as { id: string }[]).push({ id: 'injected' });

    const second = readFileSettings(dir);
    expect((second.terminals as { id: string }[])[0]?.id).toBe('a');
    expect((second.terminals as unknown[]).length).toBe(1);
  });

  it('does not cache a miss as a value — a file appearing is picked up', () => {
    // A brand-new project reads `{}` before its settings file exists; that must
    // not pin an empty object for the TTL when the file lands moments later.
    expect(readFileSettings(dir)).toEqual({});
    writeFileSettings(dir, { appName: 'created-after-first-read' });
    expect(readFileSettings(dir).appName).toBe('created-after-first-read');
  });

  it('invalidateSettingsCache() drops everything', () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ appName: 'first' }));
    expect(readFileSettings(dir).appName).toBe('first');
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ appName: 'second' }));
    invalidateSettingsCache();
    expect(readFileSettings(dir).appName).toBe('second');
  });
});
