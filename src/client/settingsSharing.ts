/**
 * HS-9004 — pure model for the dialog-wide Shared | Local overrides | Resolved
 * scope control (the Xcode-build-settings "Levels" view of the HS-9002
 * shared/local split, docs/2 §2.3.1).
 *
 * The control is a persistent toolbar under the Settings tab strip; it doesn't
 * move the settings out of their tabs (that was the rejected first cut — a
 * dedicated "Sharing" tab). Each *file-settings* field decorates in place with
 * a per-mode affordance; the rendering + wiring live in `settingsScope.ts`.
 *
 * This module is pure (no DOM, no fetch) so the layer logic is unit-tested in
 * isolation.
 */
import type { LayeredFileSettings } from '../api/index.js';

export type ScopeMode = 'shared' | 'local' | 'resolved';
export type SettingKind = 'text' | 'number' | 'boolean' | 'complex';
/** Where a key's effective (resolved) value comes from. */
export type Origin = 'shared' | 'local' | 'default';

/** The per-key view across the two layers + the resolved result. */
export interface FieldScope {
  /** Present in `settings.json`. */
  inShared: boolean;
  /** Present in `settings.local.json` (i.e. locally overridden). */
  overridden: boolean;
  origin: Origin;
  sharedValue: unknown;
  localValue: unknown;
  resolvedValue: unknown;
}

function hasKey(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Resolve one key's layer state from the layered settings payload. */
export function resolveFieldScope(layered: LayeredFileSettings, key: string): FieldScope {
  const inShared = hasKey(layered.shared, key);
  const overridden = hasKey(layered.local, key);
  return {
    inShared,
    overridden,
    origin: overridden ? 'local' : inShared ? 'shared' : 'default',
    sharedValue: layered.shared[key],
    localValue: layered.local[key],
    resolvedValue: layered.resolved[key],
  };
}

/**
 * The value a field's editor should DISPLAY in a given mode.
 *
 * - `shared` → the literal `settings.json` value, **even when locally
 *   overridden** (the bug the rework fixes: a Server port overridden in the
 *   local layer used to render blank under the Shared segment).
 * - `local` → the local override when present, otherwise the inherited
 *   (resolved) value shown read-only behind a "+ Override" affordance.
 * - `resolved` → the effective value.
 *
 * Shared/Local surface the literal file contents (blank when the key is absent
 * from that layer); Resolved surfaces the effective value (which the field's
 * own populate path may have defaulted).
 */
export function scopedDisplayValue(scope: FieldScope, mode: ScopeMode): unknown {
  if (mode === 'shared') return scope.sharedValue;
  if (mode === 'local') return scope.overridden ? scope.localValue : scope.resolvedValue;
  return scope.resolvedValue;
}

/** A short, scannable summary of a settings value (used for read-only displays). */
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
