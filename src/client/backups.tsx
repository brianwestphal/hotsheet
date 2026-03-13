import { api } from './api.js';
import { toElement } from './dom.js';
import { state } from './state.js';
import { loadTickets } from './ticketList.js';

interface BackupInfo {
  tier: string;
  filename: string;
  createdAt: string;
  ticketCount: number;
  sizeBytes: number;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function tierLabel(tier: string): string {
  if (tier === '5min') return 'Recent (every 5 min)';
  if (tier === 'hourly') return 'Hourly';
  if (tier === 'daily') return 'Daily';
  return tier;
}

export async function loadBackupList(): Promise<void> {
  const container = document.getElementById('backup-list');
  if (!container) return;

  try {
    const data = await api<{ backups: BackupInfo[] }>('/backups');
    if (data.backups.length === 0) {
      container.textContent = 'No backups yet. First backup will be created shortly.';
      return;
    }

    // Group by tier
    const grouped: Record<string, BackupInfo[]> = {};
    for (const b of data.backups) {
      (grouped[b.tier] ||= []).push(b);
    }

    container.innerHTML = '';
    for (const tier of ['5min', 'hourly', 'daily']) {
      const items = grouped[tier];
      if (!items || items.length === 0) continue;

      container.appendChild(toElement(
        <div className="backup-tier-label">{tierLabel(tier)}</div>
      ));

      for (const backup of items) {
        const row = toElement(
          <div className="backup-row" data-tier={backup.tier} data-filename={backup.filename}>
            <span className="backup-row-time">{timeAgo(backup.createdAt)}</span>
            <span className="backup-row-meta">
              {new Date(backup.createdAt).toLocaleString()} · {formatSize(backup.sizeBytes)}
            </span>
          </div>
        );
        row.addEventListener('click', () => {
          void startPreview(backup.tier, backup.filename, backup.createdAt);
        });
        container.appendChild(row);
      }
    }
  } catch {
    container.textContent = 'Failed to load backups.';
  }
}

async function startPreview(tier: string, filename: string, createdAt: string): Promise<void> {
  // Close settings dialog
  const overlay = document.getElementById('settings-overlay')!;
  overlay.style.display = 'none';

  // Show loading state
  const banner = document.getElementById('backup-preview-banner')!;
  const label = document.getElementById('backup-preview-label')!;
  label.textContent = 'Loading backup preview...';
  banner.style.display = 'flex';

  try {
    const result = await api<{ tickets: Array<Record<string, unknown>>; stats: { total: number; open: number; upNext: number } }>(
      `/backups/preview/${tier}/${filename}`
    );

    state.backupPreview = {
      active: true,
      tickets: result.tickets as unknown as typeof state.tickets,
      timestamp: createdAt,
      tier,
      filename,
    };
    state.selectedIds.clear();
    state.activeTicketId = null;

    label.textContent = `Previewing backup from ${new Date(createdAt).toLocaleString()} (${result.stats.total} tickets, ${result.stats.open} open) — read-only`;
    void loadTickets();
  } catch {
    label.textContent = 'Failed to load backup preview.';
    setTimeout(() => { banner.style.display = 'none'; }, 3000);
  }
}

async function cancelPreview(): Promise<void> {
  const banner = document.getElementById('backup-preview-banner')!;
  banner.style.display = 'none';
  state.backupPreview = null;
  state.selectedIds.clear();
  state.activeTicketId = null;
  await api('/backups/preview/cleanup', { method: 'POST' });
  void loadTickets();
}

async function confirmRestore(): Promise<void> {
  if (!state.backupPreview) return;

  const btn = document.getElementById('backup-restore-btn') as HTMLButtonElement;
  btn.textContent = 'Restoring...';
  btn.disabled = true;

  try {
    await api('/backups/restore', {
      method: 'POST',
      body: { tier: state.backupPreview.tier, filename: state.backupPreview.filename },
    });
    window.location.reload();
  } catch {
    btn.textContent = 'Restore failed';
    btn.disabled = false;
    setTimeout(() => { btn.textContent = 'Restore This Backup'; }, 3000);
  }
}

export function bindBackupsUI(): void {
  document.getElementById('backup-cancel-btn')?.addEventListener('click', () => {
    void cancelPreview();
  });

  document.getElementById('backup-restore-btn')?.addEventListener('click', () => {
    void confirmRestore();
  });

  const backupNowBtn = document.getElementById('backup-now-btn');
  backupNowBtn?.addEventListener('click', async () => {
    backupNowBtn.textContent = 'Backing up...';
    (backupNowBtn as HTMLButtonElement).disabled = true;
    try {
      const result = await api<{ error?: string }>('/backups/now', { method: 'POST' });
      if (result.error) {
        backupNowBtn.textContent = 'In progress...';
      } else {
        backupNowBtn.textContent = 'Done!';
        void loadBackupList();
      }
    } catch {
      backupNowBtn.textContent = 'Failed';
    }
    setTimeout(() => {
      backupNowBtn.textContent = 'Backup Now';
      (backupNowBtn as HTMLButtonElement).disabled = false;
    }, 1500);
  });
}
