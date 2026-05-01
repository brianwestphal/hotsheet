import { raw } from '../jsx-runtime.js';
import { TIMERS } from './constants/timers.js';
import { toElement } from './dom.js';
import { getActiveProject } from './state.js';
import { getTauriInvoke, openExternalUrl } from './tauriIntegration.js';

/** Rewrite <img> src attributes that point to GitHub domains to go through
 *  the /api/plugins/github-issues/image-proxy endpoint. Includes the project
 *  secret as a query param so the server resolves the correct project context
 *  (img tags can't send custom headers). */
export function proxyGitHubImages(container: HTMLElement) {
  const GITHUB_HOSTS = new Set([
    'github.com',
    'raw.githubusercontent.com',
    'user-images.githubusercontent.com',
    'private-user-images.githubusercontent.com',
    'objects.githubusercontent.com',
  ]);
  const projectParam = getActiveProject()?.secret;
  for (const img of container.querySelectorAll('img')) {
    try {
      const url = new URL(img.src);
      if (!GITHUB_HOSTS.has(url.hostname)) continue;
      let proxyUrl = `/api/plugins/github-issues/image-proxy?url=${encodeURIComponent(img.src)}`;
      if (projectParam != null && projectParam !== '') proxyUrl += `&project=${encodeURIComponent(projectParam)}`;
      img.src = proxyUrl;
    } catch { /* ignore invalid URLs */ }
  }
}

/** For notes containing images, append a list of clickable download links
 *  below the note content. Extracts filenames from alt text or URL path. */
export function appendImageDownloadLinks(entry: HTMLElement) {
  const imgs = entry.querySelectorAll('.note-text img');
  if (imgs.length === 0) return;

  const links = toElement(<div className="note-image-links"></div>);
  for (const img of imgs) {
    const src = (img as HTMLImageElement).src;
    const alt = (img as HTMLImageElement).alt;
    // Derive a display name: prefer alt text, fall back to filename from URL path.
    let name = alt && alt !== 'Image' ? alt : '';
    if (!name) {
      try {
        const path = new URL(src).pathname;
        const lastSegment = path.split('/').pop() ?? '';
        // Strip timestamp prefix (e.g. "mnwdok95-") from Hot Sheet uploads.
        name = lastSegment.replace(/^[a-z0-9]+-/i, '') || lastSegment || 'image';
      } catch { name = 'image'; }
    }
    const link = toElement(
      <button className="note-image-link" title={`Download ${name}`}>
        {raw('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>')}
        <span>{name}</span>
      </button>
    );
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      void downloadImage(src, name);
    });
    links.appendChild(link);
  }
  entry.appendChild(links);
}

/** Download an image — works in both web browsers and Tauri's webview. */
async function downloadImage(src: string, name: string) {
  const invoke = getTauriInvoke();
  if (invoke) {
    // Tauri: WKWebView doesn't support <a download>. Open the image in the
    // system browser where the user can save-as.
    const fullUrl = src.startsWith('/') ? window.location.origin + src : src;
    try { await invoke('open_url', { url: fullUrl }); } catch { /* ignore */ }
    return;
  }
  // Web: fetch the image as a blob and trigger a download via a temporary <a>.
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`${res.status}`);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = toElement(<a href={blobUrl} download={name} style="display:none"></a>) as HTMLAnchorElement;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(blobUrl); }, TIMERS.IMAGE_DOWNLOAD_CLEANUP_MS);
  } catch {
    // HS-8094 — last-resort fallback. CLAUDE.md bans bare `window.open`
    // in client code (silently no-ops in Tauri WKWebView while passing
    // in Playwright/Chromium); route through `openExternalUrl` which
    // tries `invoke('open_url', ...)` first and only falls back to
    // `window.open` when not running under Tauri.
    openExternalUrl(src);
  }
}
