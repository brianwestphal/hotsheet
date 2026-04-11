export function getTauriInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  const tauri = (window as unknown as Record<string, unknown>).__TAURI__ as
    | { core?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } }
    | undefined;
  return tauri?.core?.invoke ?? null;
}

/** Restore the saved app icon variant on page load. The Dock resets to the bundle
 *  icon during app launch, so we re-apply it from the client once the page is ready.
 *  NOTE: Custom icon support is feature-flagged out — always uses default icon. */
export async function restoreAppIcon() {
  // Custom icon switching disabled — always use default icon
}

/** Request user attention — bounces dock icon in Tauri, flashes tab title in browser.
 *  @param level - 'once' = single bounce, 'persistent' = keep bouncing until focused */
export function requestAttention(level: 'once' | 'persistent') {
  const invoke = getTauriInvoke();
  if (invoke) {
    // Tauri: custom command that calls request_user_attention.
    // 'persistent' = Critical (bounces until focused), 'once' = Informational (single bounce).
    invoke(level === 'persistent' ? 'request_attention' : 'request_attention_once').catch(() => {});
  } else if (!document.hasFocus()) {
    // Browser: flash the tab title
    const maxFlashes = level === 'persistent' ? 30 : 6;
    const originalTitle = document.title;
    let flashes = 0;
    const interval = setInterval(() => {
      document.title = flashes % 2 === 0 ? '\u26a0 Hot Sheet needs attention' : originalTitle;
      flashes++;
      if (flashes >= maxFlashes || document.hasFocus()) {
        clearInterval(interval);
        document.title = originalTitle;
      }
    }, 800);
  }
}

export function showUpdateBanner(version: string) {
  const banner = document.getElementById('update-banner');
  if (!banner) return;

  const label = document.getElementById('update-banner-label');
  if (label) label.textContent = `Update available: v${version}`;

  banner.style.display = 'flex';

  const installBtn = document.getElementById('update-install-btn') as HTMLButtonElement | null;
  installBtn?.addEventListener('click', async () => {
    installBtn.textContent = 'Installing...';
    installBtn.disabled = true;
    try {
      const invoke = getTauriInvoke();
      await invoke?.('install_update');
      if (label) label.textContent = 'Update installed! Restart the app to apply.';
      installBtn.style.display = 'none';
    } catch {
      installBtn.textContent = 'Install Failed';
      installBtn.disabled = false;
    }
  });

  const dismissBtn = document.getElementById('update-banner-dismiss');
  dismissBtn?.addEventListener('click', () => {
    banner.style.display = 'none';
  });
}

export async function checkForUpdate() {
  const invoke = getTauriInvoke();
  if (!invoke) return;

  // Show the "Updates" tab and panel in settings
  const section = document.getElementById('settings-updates-section');
  if (section) section.style.display = '';
  const updatesTab = document.getElementById('settings-tab-updates');
  if (updatesTab) updatesTab.style.display = '';

  // The Rust update check is async and may not have completed yet.
  // Poll a few times with increasing delays to catch it.
  const delays = [0, 3000, 10000];
  for (const delay of delays) {
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
    try {
      const version = (await invoke('get_pending_update')) as string | null;
      if (version !== null && version !== '') {
        showUpdateBanner(version);
        return;
      }
    } catch {
      return;
    }
  }
}

export function showSkillsBanner() {
  const banner = document.getElementById('skills-banner');
  if (!banner) return;
  banner.style.display = 'flex';
  const dismissBtn = document.getElementById('skills-banner-dismiss');
  dismissBtn?.addEventListener('click', () => { banner.style.display = 'none'; });
}

/** Intercept external link clicks and open them via Tauri shell or window.open. */
export function bindExternalLinkHandler() {
  document.addEventListener('click', (e) => {
    const anchor = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null;
    if (!anchor) return;
    const href = anchor.href;
    if (!href.startsWith('http://') && !href.startsWith('https://')) return;
    // Don't intercept links to our own app
    if (href.startsWith(window.location.origin)) return;

    e.preventDefault();
    const invoke = getTauriInvoke();
    if (invoke) {
      // Use Tauri's shell.open via a custom command
      invoke('open_url', { url: href }).catch(() => {
        // Fallback if the command isn't available
        window.open(href, '_blank');
      });
    } else {
      window.open(href, '_blank');
    }
  });
}
