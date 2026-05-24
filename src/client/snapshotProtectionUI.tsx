import { api } from './api.js';
import { byIdOrNull } from './dom.js';

/** HS-8594 — client controls for the Settings → Backups → "Snapshot
 *  protection" subsection (docs/73-snapshot-protection.md §73.6). Sibling
 *  of `dbRepairUI.tsx`; both are wired from `bindBackupsUI` /
 *  `loadBackupList` in `backups.tsx`. Two responsibilities:
 *
 *  1. A checkbox bound to the `db_snapshot_protection` file-setting
 *     (default ON per decision D3). Flipping it PATCHes `/file-settings`;
 *     the server gate `isSnapshotProtectionEnabled` (HS-8586) reads the
 *     same key, so the next mutation honors the new value immediately.
 *  2. A status line ("Last snapshot: HH:MM · N KB") fed by
 *     `GET /api/db/snapshot-status` (HS-8594 route → `getSnapshotStatus`).
 */

interface SnapshotStatus {
  lastSnapshotAt: number | null;
  lastSizeBytes: number | null;
}

/** Human-readable byte size for the status line. `null` ⇒ size omitted. */
function formatSnapshotSize(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Pure formatter for the status line. Extracted so the time/size shaping
 *  can be unit-tested without DOM. Before the session's first snapshot both
 *  fields are null — we say so rather than render a bogus "00:00 · 0 B". */
export function formatSnapshotStatusLine(status: SnapshotStatus): string {
  if (status.lastSnapshotAt === null) {
    return 'No snapshot taken yet this session — one is written shortly after the next change.';
  }
  const time = new Date(status.lastSnapshotAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const size = formatSnapshotSize(status.lastSizeBytes);
  return size !== null ? `Last snapshot: ${time} · ${size}` : `Last snapshot: ${time}`;
}

/** Wire the checkbox change handler. Called once from `bindBackupsUI`. */
export function bindSnapshotProtectionUI(): void {
  const checkbox = byIdOrNull<HTMLInputElement>('settings-snapshot-protection');
  if (checkbox === null) return;
  checkbox.addEventListener('change', () => {
    void api('/file-settings', { method: 'PATCH', body: { db_snapshot_protection: checkbox.checked } })
      .then(() => { void refreshSnapshotProtectionStatus(); })
      .catch((err: unknown) => {
        console.error('Could not save snapshot-protection setting:', err);
      });
  });
}

/** Populate the checkbox state + status line. Called on each Settings →
 *  Backups open from `loadBackupList`. The checkbox defaults ON (decision
 *  D3) — only an explicit stored `false` unchecks it. */
export async function refreshSnapshotProtectionStatus(): Promise<void> {
  const checkbox = byIdOrNull<HTMLInputElement>('settings-snapshot-protection');
  const statusEl = byIdOrNull('settings-snapshot-status');
  if (checkbox === null || statusEl === null) return;

  try {
    const fs = await api<{ db_snapshot_protection?: boolean }>('/file-settings');
    checkbox.checked = fs.db_snapshot_protection !== false;
  } catch (err) {
    console.error('Could not load snapshot-protection setting:', err);
  }

  try {
    const status = await api<SnapshotStatus>('/db/snapshot-status');
    statusEl.textContent = formatSnapshotStatusLine(status);
  } catch (err) {
    console.error('Could not load snapshot status:', err);
    statusEl.textContent = 'Snapshot status unavailable.';
  }
}
