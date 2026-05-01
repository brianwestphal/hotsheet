import { api } from './api.js';
import { loadBackupList } from './backups.js';
import { confirmDialog } from './confirm.js';
import { byIdOrNull, toElement } from './dom.js';

/** HS-7897: client-side controls for the Settings → Backups → Database
 *  Repair panel. Three responsibilities:
 *
 *  1. **Status pill** that pulls from `GET /api/db/recovery-status` so
 *     the user can see whether the DB is currently healthy or recovered
 *     from a corruption event.
 *  2. **"Find a working backup"** — calls the server, surfaces the
 *     newest tarball that opens cleanly, offers to start a Restore.
 *  3. **"Run pg_resetwal…"** — checks platform availability, shows
 *     install instructions when missing (cross-platform per the
 *     HS-7897 feedback: macOS / Linux / Windows), runs the repair on
 *     the corrupt directory, surfaces the new tarball for restore.
 */

interface RecoveryMarker { corruptPath: string; recoveredAt: string; errorMessage: string }

interface FindWorkingBackupResponse {
  backup: { tier: string; filename: string; ticketCount: number; createdAt: string } | null;
}

interface InstallInstructions {
  description: string;
  command: string;
  url: string;
}

interface ResetwalAvailability {
  available: boolean;
  path: string | null;
  platform: string;
  installInstructions: InstallInstructions;
}

interface RepairResult {
  tier: string;
  filename: string;
  ticketCount: number;
  sizeBytes: number;
}

/** Pure formatter — extracted so the platform-aware install help can be
 *  unit-tested without DOM. Returns the markdown-style text shown in the
 *  install dialog when `pg_resetwal` is missing. Cross-platform per the
 *  HS-7897 feedback caveat. */
export function formatInstallHelp(availability: ResetwalAvailability): string {
  const { description, command, url } = availability.installInstructions;
  return `pg_resetwal is not installed (${description}).\n\nInstall command:\n${command}\n\nDownload page: ${url}`;
}

/** Pure formatter for the status pill text. Exported for unit-testing. */
export function formatStatusText(marker: RecoveryMarker | null): { text: string; cls: string } {
  if (marker === null) {
    return { text: 'Database is healthy ✓', cls: 'is-healthy' };
  }
  const when = new Date(marker.recoveredAt).toLocaleString();
  return { text: `⚠ Database recovery occurred at ${when} — see banner above the toolbar`, cls: 'is-recovered' };
}

/** Wire the buttons + initial status fetch. Called from `bindBackupsUI`
 *  in `backups.tsx` so the panel is ready whenever Settings opens. */
export function bindDbRepairUI(): void {
  const findBtn = byIdOrNull('db-repair-find-working-btn');
  const resetwalBtn = byIdOrNull('db-repair-pg-resetwal-btn');
  if (findBtn === null || resetwalBtn === null) return;

  findBtn.addEventListener('click', () => { void onFindWorkingBackup(); });
  resetwalBtn.addEventListener('click', () => { void onRunPgResetwal(); });
}

/** Refresh the status pill — called every time Settings opens so the
 *  pill stays current after a Restore / Dismiss flow elsewhere. */
export async function refreshDbRepairStatus(): Promise<void> {
  const statusEl = byIdOrNull('db-repair-status');
  if (statusEl === null) return;
  statusEl.className = 'db-repair-status';
  statusEl.textContent = 'Checking database health…';
  try {
    const res = await api<{ marker: RecoveryMarker | null }>('/db/recovery-status');
    const { text, cls } = formatStatusText(res.marker);
    statusEl.textContent = text;
    statusEl.classList.add(cls);
  } catch (err) {
    console.error('Could not load DB health:', err);
    statusEl.textContent = `Could not load DB health: ${err instanceof Error ? err.message : 'unknown error'}`;
  }
}

async function onFindWorkingBackup(): Promise<void> {
  const result = byIdOrNull('db-repair-result');
  if (result === null) return;
  result.innerHTML = '';
  result.appendChild(toElement(<span>Validating backups (newest first)…</span>));
  try {
    const res = await api<FindWorkingBackupResponse>('/db/repair/find-working-backup', { method: 'POST' });
    if (res.backup === null) {
      result.innerHTML = '';
      result.appendChild(toElement(
        <span className="db-repair-result-err">
          No working backup found. Every tarball failed to load. Try the pg_resetwal flow if a recent backup is critical.
        </span>
      ));
      return;
    }
    const b = res.backup;
    result.innerHTML = '';
    result.appendChild(toElement(
      <div>
        <div className="db-repair-result-ok">
          ✓ Found <strong>{b.filename}</strong> ({b.tier}, {b.ticketCount} tickets, created {new Date(b.createdAt).toLocaleString()})
        </div>
        <div className="db-repair-result-actions">
          <button className="btn btn-sm btn-danger" id="db-repair-restore-found-btn">Restore from this backup</button>
        </div>
      </div>
    ));
    byIdOrNull('db-repair-restore-found-btn')?.addEventListener('click', () => {
      void doRestoreFromFoundBackup(b.tier, b.filename);
    });
  } catch (err) {
    result.innerHTML = '';
    result.appendChild(toElement(
      <span className="db-repair-result-err">
        Validation failed: {err instanceof Error ? err.message : 'unknown error'}
      </span>
    ));
  }
}

async function doRestoreFromFoundBackup(tier: string, filename: string): Promise<void> {
  const ok = await confirmDialog({
    title: 'Restore from backup',
    message: `This will replace your current database with the contents of ${filename}. A safety backup of the current state will be created first.\n\nContinue?`,
    confirmLabel: 'Restore',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('/backups/restore', { method: 'POST', body: { tier, filename } });
    window.location.reload();
  } catch (err) {
    const result = byIdOrNull('db-repair-result');
    if (result !== null) {
      result.innerHTML = '';
      result.appendChild(toElement(
        <span className="db-repair-result-err">
          Restore failed: {err instanceof Error ? err.message : 'unknown error'}
        </span>
      ));
    }
  }
}

async function onRunPgResetwal(): Promise<void> {
  const result = byIdOrNull('db-repair-result');
  if (result === null) return;
  result.innerHTML = '';
  result.appendChild(toElement(<span>Checking pg_resetwal availability…</span>));

  let availability: ResetwalAvailability;
  try {
    availability = await api<ResetwalAvailability>('/db/repair/pg-resetwal-availability');
  } catch (err) {
    result.innerHTML = '';
    result.appendChild(toElement(
      <span className="db-repair-result-err">
        Could not probe pg_resetwal: {err instanceof Error ? err.message : 'unknown error'}
      </span>
    ));
    return;
  }

  if (!availability.available) {
    result.innerHTML = '';
    const help = formatInstallHelp(availability);
    result.appendChild(toElement(
      <div>
        <div className="db-repair-result-err">pg_resetwal is not installed.</div>
        <pre>{help}</pre>
        <span>Once installed and on PATH, click "Run pg_resetwal…" again.</span>
      </div>
    ));
    return;
  }

  const ok = await confirmDialog({
    title: 'Run pg_resetwal',
    message:
      'This will:\n' +
      `  1. Copy the corrupt directory to a temp location.\n` +
      `  2. Run "${availability.path} -f" against the copy.\n` +
      `  3. Re-dump the repaired directory as a new tarball in the 5-min backup tier.\n\n` +
      'Your live database is NOT modified. After this completes you can Restore from the new tarball if it looks good.',
    confirmLabel: 'Run pg_resetwal',
    danger: true,
  });
  if (!ok) {
    result.innerHTML = '';
    return;
  }

  result.innerHTML = '';
  result.appendChild(toElement(<span>Running pg_resetwal…</span>));
  try {
    const res = await api<RepairResult>('/db/repair/run-pg-resetwal', { method: 'POST' });
    void loadBackupList();
    result.innerHTML = '';
    result.appendChild(toElement(
      <div>
        <div className="db-repair-result-ok">
          ✓ Repaired tarball created: <strong>{res.filename}</strong> ({res.ticketCount} tickets)
        </div>
        <div className="db-repair-result-actions">
          <button className="btn btn-sm btn-danger" id="db-repair-restore-resetwal-btn">Restore from this tarball</button>
        </div>
      </div>
    ));
    byIdOrNull('db-repair-restore-resetwal-btn')?.addEventListener('click', () => {
      void doRestoreFromFoundBackup(res.tier, res.filename);
    });
  } catch (err) {
    result.innerHTML = '';
    result.appendChild(toElement(
      <span className="db-repair-result-err">
        pg_resetwal failed: {err instanceof Error ? err.message : 'unknown error'}
      </span>
    ));
  }
}
