import { type CorruptCluster, findWorkingBackup, getRecoveryStatus, getResetwalAvailability, listCorruptClusters, probeCorruptCluster, restoreBackup, runResetwal } from '../api/index.js';
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
    const marker = await getRecoveryStatus();
    const { text, cls } = formatStatusText(marker);
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
    const backup = await findWorkingBackup();
    if (backup === null) {
      result.innerHTML = '';
      result.appendChild(toElement(
        <span className="db-repair-result-err">
          No working backup found. Every tarball failed to load. Try the pg_resetwal flow if a recent backup is critical.
        </span>
      ));
      return;
    }
    const b = backup;
    result.innerHTML = '';
    result.appendChild(toElement(
      <div>
        <div className="db-repair-result-ok">
          ✓ Found <strong>{b.filename}</strong> ({b.tier}, {b.ticketCount} tickets, created {new Date(b.createdAt).toLocaleString()})
        </div>
        <div className="db-repair-result-actions">
          <button className="btn btn-sm btn-danger" id="db-repair-restore-found-btn">Restore from This Backup</button>
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
    title: 'Restore from Backup',
    message: `This will replace your current database with the contents of ${filename}. A safety backup of the current state will be created first.\n\nContinue?`,
    confirmLabel: 'Restore',
    danger: true,
  });
  if (!ok) return;
  try {
    await restoreBackup(tier, filename);
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
    availability = await getResetwalAvailability();
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

  // HS-9575 — choose WHICH preserved directory to repair. Before this the flow
  // silently used the recovery marker's path, and a recovery that died partway
  // leaves the previous incident's marker behind: on 2026-08-04 that named a
  // 0-byte directory while the one holding 432 tickets sat beside it.
  const chosen = await pickCorruptCluster(result);
  if (chosen === null) {
    result.replaceChildren();
    return;
  }

  const ok = await confirmDialog({
    title: 'Run pg_resetwal',
    message:
      `Repairing ${chosen.name}` +
      (chosen.recoverableTicketCount !== null ? ` (${String(chosen.recoverableTicketCount)} tickets recoverable).\n\n` : '.\n\n') +
      'This will:\n' +
      `  1. Copy the corrupt directory to a temp location.\n` +
      `  2. Run "${availability.path} -f" against the copy.\n` +
      `  3. Re-dump the repaired directory as a new tarball in the 5-min backup tier.\n\n` +
      'Your live database is NOT modified. After this completes you can Restore from the new tarball if it looks good.',
    confirmLabel: 'Run pg_resetwal',
    danger: true,
  });
  if (!ok) {
    result.replaceChildren();
    return;
  }

  result.replaceChildren(toElement(<span>Running pg_resetwal…</span>));
  try {
    const res = await runResetwal(chosen.path);
    void loadBackupList();
    result.innerHTML = '';
    result.appendChild(toElement(
      <div>
        <div className="db-repair-result-ok">
          ✓ Repaired tarball created: <strong>{res.filename}</strong> ({res.ticketCount} tickets)
        </div>
        <div className="db-repair-result-actions">
          <button className="btn btn-sm btn-danger" id="db-repair-restore-resetwal-btn">Restore from This Tarball</button>
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

/** Human-readable size for the candidate list. */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function describeCandidate(c: CorruptCluster): string {
  const when = new Date(c.modifiedAt).toLocaleString();
  if (!c.looksLikeCluster) return `${c.name} — ${when} — not a database (nothing to recover)`;
  const count = c.recoverableTicketCount === null
    ? 'checking…'
    : `${String(c.recoverableTicketCount)} tickets recoverable`;
  return `${c.name} — ${when} — ${formatSize(c.sizeBytes)} — ${count}`;
}

/**
 * Let the user choose which preserved corrupt directory to repair, defaulting
 * to the one that actually yields the most tickets.
 *
 * Every candidate is probed (copy → `pg_resetwal -f` → open → COUNT) because the
 * count is the only fact that distinguishes them in a way the user can act on —
 * a name is a timestamp and a size is mostly the Postgres template. Probes run
 * one at a time, each rewriting its row as it lands, so the list stays readable
 * while the slow part happens.
 *
 * Returns null when the user cancels or there is nothing to offer.
 */
async function pickCorruptCluster(result: HTMLElement): Promise<CorruptCluster | null> {
  result.replaceChildren(toElement(<span>Looking for preserved databases…</span>));

  let candidates: CorruptCluster[];
  try {
    candidates = await listCorruptClusters();
  } catch (err) {
    result.replaceChildren(toElement(
      <span className="db-repair-result-err">
        Could not list preserved databases: {err instanceof Error ? err.message : 'unknown error'}
      </span>
    ));
    return null;
  }

  if (candidates.length === 0) {
    result.replaceChildren(toElement(
      <span className="db-repair-result-err">No preserved <code>db-corrupt-*</code> directory to repair.</span>
    ));
    return null;
  }

  const render = (): void => {
    result.replaceChildren(toElement(
      <div>
        <div>Choose which preserved database to repair:</div>
        <select id="db-repair-corrupt-select">
          {candidates.map((c) => (
            <option value={c.path} disabled={!c.looksLikeCluster}>{describeCandidate(c)}</option>
          ))}
        </select>
        <div className="db-repair-result-actions">
          <button className="btn btn-sm" id="db-repair-corrupt-cancel">Cancel</button>
          <button className="btn btn-sm btn-danger" id="db-repair-corrupt-go">Repair This One</button>
        </div>
      </div>
    ));
  };
  render();

  // Probe sequentially — each one copies a whole cluster and runs pg_resetwal,
  // so running them at once would multiply disk and CPU for no earlier answer.
  for (const c of candidates) {
    if (!c.looksLikeCluster) continue;
    try {
      c.recoverableTicketCount = await probeCorruptCluster(c.path);
    } catch {
      c.recoverableTicketCount = null;
    }
    const before = byIdOrNull('db-repair-corrupt-select');
    const selectedBefore = before instanceof HTMLSelectElement ? before.value : null;
    render();
    const after = byIdOrNull('db-repair-corrupt-select');
    if (after instanceof HTMLSelectElement && selectedBefore !== null) after.value = selectedBefore;
  }

  // Default to the candidate with the most recoverable tickets — the number the
  // user actually cares about, rather than whichever directory a marker names.
  const best = candidates.reduce<CorruptCluster | null>(
    (acc, c) => ((c.recoverableTicketCount ?? -1) > (acc?.recoverableTicketCount ?? -1) ? c : acc),
    null,
  );
  const select = byIdOrNull('db-repair-corrupt-select');
  if (select instanceof HTMLSelectElement && best !== null) select.value = best.path;

  return await new Promise<CorruptCluster | null>((resolvePick) => {
    byIdOrNull('db-repair-corrupt-cancel')?.addEventListener('click', () => { resolvePick(null); });
    byIdOrNull('db-repair-corrupt-go')?.addEventListener('click', () => {
      const el = byIdOrNull('db-repair-corrupt-select');
      const path = el instanceof HTMLSelectElement ? el.value : '';
      resolvePick(candidates.find((c) => c.path === path) ?? null);
    });
  });
}
