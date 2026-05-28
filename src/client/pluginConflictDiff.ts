/**
 * HS-8686 — pure helper that turns a `ticket_sync.conflict_data` JSON blob into
 * a structured diff the conflict-row UI can render.
 *
 * Why this is its own module:
 *
 *   1. **Testable.** The previous inline render in `pluginSettings.tsx` had no
 *      unit-test coverage and a too-narrow zod schema (HS-8567's
 *      `ConflictPrimitiveSchema = string | number | boolean | null`) silently
 *      ate every real conflict, because `extractTicketFields` (server side,
 *      `src/plugins/syncEngine.ts`) emits `tags` as a `string[]` — the parse
 *      failed, `parseJsonOrNull` returned null, the diff section vanished, and
 *      the UI degraded to "Ticket #N github-issues Remote: 4" + Keep buttons.
 *      That's the user-visible bug HS-8686 was filed for.
 *   2. **Tolerant.** Real conflict payloads carry arrays (`tags`) and may carry
 *      `null` field values and even the synthetic `base_synced_at` timestamp
 *      the engine writes alongside `local` + `remote`. We accept any JSON-ish
 *      value and stringify lossily at render time — the client only displays
 *      diffs, never re-serialises.
 *   3. **Self-explanatory.** When `conflict_data` is missing OR every field
 *      stringify-matches (e.g. a metadata-only conflict from a webhook bounce),
 *      we surface an explicit `status` + `summary` so the UI can render a
 *      friendly placeholder instead of nothing.
 *
 * The matching server-side schema is `PluginConflictDataSchema` in
 * `src/schemas.ts` — both use `z.unknown()` for field values.
 */
import { z } from 'zod';

import { parseJsonOrNull } from '../schemas.js';

// Loose schema — every field value is opaque-on-purpose. We never re-serialise,
// only `String()`-stringify for display. The `loose()` call lets the synthetic
// `base_synced_at` (and any future engine-added top-level keys) survive parse.
const ConflictDataSchema = z.object({
  local: z.record(z.string(), z.unknown()).optional(),
  remote: z.record(z.string(), z.unknown()).optional(),
  base_synced_at: z.string().optional(),
}).loose();

/** Ordering the conflict-row UI uses when laying out per-field rows. */
const FIELD_ORDER: readonly string[] = [
  'title',
  'status',
  'category',
  'priority',
  'up_next',
  'tags',
  'details',
];

/** Display labels for each known field. Unknown keys fall through to the raw key. */
const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  status: 'Status',
  category: 'Category',
  priority: 'Priority',
  up_next: 'Up Next',
  tags: 'Tags',
  details: 'Details',
};

export interface ConflictFieldDiff {
  /** Raw field key (`title`, `tags`, …) — stable for tests and HTML data-attrs. */
  key: string;
  /** Human-readable label for display (e.g. `Up Next`). */
  label: string;
  /** Stringified local value, ready to render. `(empty)` for null / undefined. */
  local: string;
  /** Stringified remote value, ready to render. `(empty)` for null / undefined. */
  remote: string;
  /** True when the value spans multiple lines or is longer than 80 chars. */
  multiline: boolean;
}

export type ConflictDiffStatus = 'no-data' | 'no-diff' | 'has-diff' | 'parse-error';

export interface ConflictDiff {
  /**
   * - `no-data`     — `conflict_data` column was null / empty
   * - `parse-error` — column was not JSON-parseable at all
   * - `no-diff`     — parsed cleanly but every field stringify-matches
   * - `has-diff`    — at least one field differs
   */
  status: ConflictDiffStatus;
  fields: ConflictFieldDiff[];
  /** One-line description for the UI placeholder text. */
  summary: string;
  /** ISO timestamp from `base_synced_at`, when present. Used for the "last synced" line. */
  baseSyncedAt: string | null;
}

/**
 * Render a value as a one-or-many-line display string. Arrays join with `, `
 * for tags. Each primitive type is handled explicitly so the catch-all uses
 * `JSON.stringify` — avoids the `String(unknown) → '[object Object]'` foot-gun
 * the `@typescript-eslint/no-base-to-string` rule guards against.
 */
function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return '(empty)';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'symbol') return v.toString();
  if (Array.isArray(v)) return v.length === 0 ? '(empty)' : v.map((x) => stringifyValue(x)).join(', ');
  try {
    return JSON.stringify(v);
  } catch {
    return '[object]';
  }
}

/** True when the raw stringified value is multi-line or longer than 80 chars — UI uses block layout for these. */
function isMultiline(s: string): boolean {
  return s.includes('\n') || s.length > 80;
}

/**
 * Parse a `conflict_data` JSON blob into a renderable diff structure. Total
 * function — never throws; every failure mode maps to a `status`.
 */
export function computeConflictDiff(conflictDataJson: string | null | undefined): ConflictDiff {
  if (conflictDataJson === null || conflictDataJson === undefined || conflictDataJson === '') {
    return { status: 'no-data', fields: [], summary: 'No diff details recorded for this conflict.', baseSyncedAt: null };
  }

  const parsed = parseJsonOrNull(ConflictDataSchema, conflictDataJson);
  if (parsed === null) {
    return { status: 'parse-error', fields: [], summary: 'Conflict data could not be parsed.', baseSyncedAt: null };
  }

  const local = parsed.local ?? {};
  const remote = parsed.remote ?? {};
  const baseSyncedAt = typeof parsed.base_synced_at === 'string' ? parsed.base_synced_at : null;

  // Union of keys so the UI sees fields that exist on only one side too (an
  // add or delete is still a meaningful diff).
  const allKeys = new Set<string>([...Object.keys(local), ...Object.keys(remote)]);

  // Order by FIELD_ORDER then alphabetical for any unknown trailing keys, so
  // the same conflict renders deterministically across reloads.
  const ordered = [...allKeys].sort((a, b) => {
    const ai = FIELD_ORDER.indexOf(a);
    const bi = FIELD_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  const fields: ConflictFieldDiff[] = [];
  for (const key of ordered) {
    const localRaw = local[key];
    const remoteRaw = remote[key];
    // Stringify both sides and compare on the stringified shape — order-stable
    // for arrays / objects (we control the serialisation above).
    const localStr = stringifyValue(localRaw);
    const remoteStr = stringifyValue(remoteRaw);
    if (localStr === remoteStr) continue;
    fields.push({
      key,
      label: FIELD_LABELS[key] ?? key,
      local: localStr,
      remote: remoteStr,
      multiline: isMultiline(localStr) || isMultiline(remoteStr),
    });
  }

  if (fields.length === 0) {
    return {
      status: 'no-diff',
      fields,
      summary: 'No field-level differences detected — likely a metadata-only conflict.',
      baseSyncedAt,
    };
  }

  const summary = fields.length === 1
    ? `1 field differs: ${fields[0].label.toLowerCase()}.`
    : `${fields.length} fields differ: ${fields.map((f) => f.label.toLowerCase()).join(', ')}.`;

  return { status: 'has-diff', fields, summary, baseSyncedAt };
}
