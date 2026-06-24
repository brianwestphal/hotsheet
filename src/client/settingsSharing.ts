/**
 * HS-9004 — pure model for the Settings → Sharing tab (the Xcode-build-settings
 * "Levels" view of the HS-9002 shared/local split, docs/2 §2.3.1).
 *
 * The tab renders one of three modes via a segmented control:
 *   - `shared`   — edit `settings.json` (committed, team).
 *   - `local`    — edit `settings.local.json` (gitignored, this machine), with
 *                  per-row Override / Reset-to-shared.
 *   - `resolved` — read-only merged view, each row tagged by origin.
 *
 * This module is pure (no DOM, no fetch) so the row logic is unit-tested in
 * isolation; `settingsSharingUI.tsx` does the rendering + wiring.
 */
import type { LayeredFileSettings } from '../api/index.js';

export type SharingMode = 'shared' | 'local' | 'resolved';
export type SettingKind = 'text' | 'number' | 'boolean' | 'complex';
export type Origin = 'shared' | 'local' | 'default';

export interface SettingRegistryEntry {
  key: string;
  label: string;
  /** The key's default home layer — drives the "normally shared/local" hint. */
  defaultLayer: 'shared' | 'local';
  kind: SettingKind;
  hint?: string;
}

/**
 * Curated, friendly-labeled settings surfaced in the Sharing tab. Keys NOT here
 * but present on disk still appear (as an "Other" row) so the tab never hides
 * what's committed — see `buildSharingRows`. Keep the local-default entries in
 * sync with `defaultScope` in `src/file-settings.ts`.
 */
export const SETTINGS_REGISTRY: SettingRegistryEntry[] = [
  // Machine-local by default (HS-9002).
  { key: 'backupDir', label: 'Backup directory', defaultLayer: 'local', kind: 'text', hint: 'Absolute path on this machine' },
  { key: 'port', label: 'Server port', defaultLayer: 'local', kind: 'number', hint: 'Takes effect on next launch' },
  { key: 'announcer_ai_key_id', label: 'Announcer API key', defaultLayer: 'local', kind: 'text', hint: 'Personal key, by name' },
  { key: 'notify_permission', label: 'Notification permission', defaultLayer: 'local', kind: 'text' },
  { key: 'permission_allow_rules', label: 'Permission allow-rules', defaultLayer: 'local', kind: 'complex' },
  { key: 'terminal_prompt_allow_rules', label: 'Terminal prompt allow-rules', defaultLayer: 'local', kind: 'complex' },
  // Shareable / committed by default.
  { key: 'appName', label: 'App name', defaultLayer: 'shared', kind: 'text' },
  { key: 'appIcon', label: 'App icon', defaultLayer: 'shared', kind: 'text' },
  { key: 'ticketPrefix', label: 'Ticket prefix', defaultLayer: 'shared', kind: 'text' },
  { key: 'worklist_preamble', label: 'Worklist preamble', defaultLayer: 'shared', kind: 'text' },
  { key: 'categories', label: 'Categories', defaultLayer: 'shared', kind: 'complex' },
  { key: 'custom_views', label: 'Custom views', defaultLayer: 'shared', kind: 'complex' },
  { key: 'custom_commands', label: 'Custom commands', defaultLayer: 'shared', kind: 'complex' },
  { key: 'terminals', label: 'Terminals', defaultLayer: 'shared', kind: 'complex' },
  { key: 'trash_cleanup_days', label: 'Trash cleanup (days)', defaultLayer: 'shared', kind: 'number' },
  { key: 'completed_cleanup_days', label: 'Completed cleanup (days)', defaultLayer: 'shared', kind: 'number' },
  { key: 'verified_cleanup_days', label: 'Verified cleanup (days)', defaultLayer: 'shared', kind: 'number' },
  { key: 'sort_by', label: 'Default sort', defaultLayer: 'shared', kind: 'text' },
  { key: 'layout', label: 'Layout', defaultLayer: 'shared', kind: 'text' },
];

export interface SharingRow {
  key: string;
  label: string;
  hint?: string;
  kind: SettingKind;
  defaultLayer: 'shared' | 'local';
  /** Present in `settings.local.json`. */
  overridden: boolean;
  /** Where the resolved (effective) value comes from. */
  origin: Origin;
  /** Present in `settings.json`. */
  inShared: boolean;
  sharedValue: unknown;
  localValue: unknown;
  resolvedValue: unknown;
  sharedDisplay: string;
  localDisplay: string;
  resolvedDisplay: string;
  /** True when this key isn't in the curated registry (rendered read-only). */
  isOther: boolean;
}

/** A short, scannable summary of a settings value for display. */
export function summarizeValue(kind: SettingKind, value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (kind === 'boolean' || typeof value === 'boolean') {
    const on = value === true || value === 'true';
    return on ? 'On' : 'Off';
  }
  if (Array.isArray(value)) return `${String(value.length)} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object') {
    const n = Object.keys(value).length;
    return `${String(n)} field${n === 1 ? '' : 's'}`;
  }
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' ? value : '—';
}

function hasKey(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Build the ordered row models for the Sharing tab: every curated registry key
 * (shown even when unset, so it can be configured), followed by any
 * present-but-unregistered key (so nothing committed is hidden), sorted by key.
 */
export function buildSharingRows(layered: LayeredFileSettings, registry: SettingRegistryEntry[] = SETTINGS_REGISTRY): SharingRow[] {
  const { shared, local, resolved } = layered;
  const registryKeys = new Set(registry.map(e => e.key));

  const makeRow = (entry: SettingRegistryEntry, isOther: boolean): SharingRow => {
    const inShared = hasKey(shared, entry.key);
    const overridden = hasKey(local, entry.key);
    const origin: Origin = overridden ? 'local' : inShared ? 'shared' : 'default';
    return {
      key: entry.key,
      label: entry.label,
      hint: entry.hint,
      kind: entry.kind,
      defaultLayer: entry.defaultLayer,
      overridden,
      origin,
      inShared,
      sharedValue: shared[entry.key],
      localValue: local[entry.key],
      resolvedValue: resolved[entry.key],
      sharedDisplay: summarizeValue(entry.kind, shared[entry.key]),
      localDisplay: summarizeValue(entry.kind, local[entry.key]),
      resolvedDisplay: summarizeValue(entry.kind, resolved[entry.key]),
      isOther,
    };
  };

  const rows = registry.map(e => makeRow(e, false));

  // "Other" — present on disk but not curated. Shown read-only so the tab is a
  // complete picture of what's shared vs local.
  const otherKeys = new Set<string>();
  for (const k of Object.keys(shared)) if (!registryKeys.has(k)) otherKeys.add(k);
  for (const k of Object.keys(local)) if (!registryKeys.has(k)) otherKeys.add(k);
  for (const k of [...otherKeys].sort()) {
    rows.push(makeRow(
      { key: k, label: k, defaultLayer: hasKey(local, k) && !hasKey(shared, k) ? 'local' : 'shared', kind: 'complex' },
      true,
    ));
  }

  return rows;
}
