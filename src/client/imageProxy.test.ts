// @vitest-environment happy-dom
// HS-9144 — branch coverage for the note-image proxy + download-link helpers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appendImageDownloadLinks, proxyGitHubImages } from './imageProxy.js';
import { getActiveProject, type ProjectInfo } from './state.js';
import { getTauriInvoke, openExternalUrl } from './tauriIntegration.js';

vi.mock('./state.js', async (orig) => ({ ...(await orig<object>()), getActiveProject: vi.fn() }));
vi.mock('./tauriIntegration.js', () => ({ getTauriInvoke: vi.fn(), openExternalUrl: vi.fn() }));

const mockProject = vi.mocked(getActiveProject);
const mockInvoke = vi.mocked(getTauriInvoke);
const mockOpenExternal = vi.mocked(openExternalUrl);

function imgHtml(srcs: string[]): HTMLElement {
  const div = document.createElement('div');
  div.innerHTML = srcs.map(s => `<img src="${s}" />`).join('');
  return div;
}

beforeEach(() => {
  mockProject.mockReturnValue({ secret: 'proj-secret', origin: '' } as ProjectInfo);
  mockInvoke.mockReturnValue(null);
  mockOpenExternal.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

describe('proxyGitHubImages', () => {
  it('rewrites a GitHub image src through the proxy endpoint with the project param', () => {
    const c = imgHtml(['https://raw.githubusercontent.com/o/r/main/a.png']);
    proxyGitHubImages(c);
    const src = c.querySelector('img')!.getAttribute('src')!;
    expect(src).toContain('/api/plugins/github-issues/image-proxy?url=');
    expect(src).toContain('&project=proj-secret');
  });

  it('leaves non-GitHub images untouched', () => {
    const c = imgHtml(['https://example.com/pic.png']);
    proxyGitHubImages(c);
    expect(c.querySelector('img')!.src).toBe('https://example.com/pic.png');
  });

  it('omits the project param when there is no active secret', () => {
    mockProject.mockReturnValue({ secret: '', origin: '' } as ProjectInfo);
    const c = imgHtml(['https://github.com/o/r/x.png']);
    proxyGitHubImages(c);
    expect(c.querySelector('img')!.getAttribute('src')).not.toContain('&project=');
  });

  it('prefixes a remote project origin onto the proxy URL (HS-9302)', () => {
    mockProject.mockReturnValue({ secret: 's', origin: 'https://remote:4174' } as ProjectInfo);
    const c = imgHtml(['https://objects.githubusercontent.com/o/r/y.png']);
    proxyGitHubImages(c);
    expect(c.querySelector('img')!.getAttribute('src')!).toMatch(/^https:\/\/remote:4174\/api\/plugins\/github-issues\/image-proxy/);
  });

  it('skips an unparseable img src without throwing', () => {
    const c = document.createElement('div');
    const img = document.createElement('img');
    img.setAttribute('src', 'http://%%%bad');
    c.appendChild(img);
    expect(() => proxyGitHubImages(c)).not.toThrow();
  });
});

describe('appendImageDownloadLinks', () => {
  function noteEntry(imgsHtml: string): HTMLElement {
    const entry = document.createElement('div');
    entry.innerHTML = `<div class="note-text">${imgsHtml}</div>`;
    return entry;
  }

  it('does nothing when the note has no images', () => {
    const entry = noteEntry('<p>no images here</p>');
    appendImageDownloadLinks(entry);
    expect(entry.querySelector('.note-image-links')).toBeNull();
  });

  it('uses meaningful alt text as the download name', () => {
    const entry = noteEntry('<img src="https://x/y.png" alt="My Diagram" />');
    appendImageDownloadLinks(entry);
    expect(entry.querySelector('.note-image-link span')!.textContent).toBe('My Diagram');
  });

  it('falls back to the URL filename, stripping the Hot Sheet timestamp prefix, when alt is "Image"', () => {
    const entry = noteEntry('<img src="https://x/uploads/mnwdok95-report.png" alt="Image" />');
    appendImageDownloadLinks(entry);
    expect(entry.querySelector('.note-image-link span')!.textContent).toBe('report.png');
  });

  it('clicking a link triggers the Tauri open path when running under Tauri', async () => {
    const invoke = vi.fn((_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => Promise.resolve(undefined));
    mockInvoke.mockReturnValue(invoke);
    // An absolute src (happy-dom resolves any relative src to absolute anyway).
    const entry = noteEntry('<img src="https://cdn.example/pic.png" alt="pic" />');
    appendImageDownloadLinks(entry);
    (entry.querySelector('.note-image-link') as HTMLElement).click();
    // downloadImage is a fire-and-forget async call off the click handler.
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('open_url', { url: 'https://cdn.example/pic.png' }));
  });

  it('clicking a link in the browser fetches the blob and triggers a download', async () => {
    mockInvoke.mockReturnValue(null); // web context
    const blob = new Blob(['x'], { type: 'image/png' });
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, blob: () => Promise.resolve(blob) } as unknown as Response));
    vi.stubGlobal('fetch', fetchMock);
    const entry = noteEntry('<img src="https://cdn.example/pic.png" alt="pic" />');
    appendImageDownloadLinks(entry);
    (entry.querySelector('.note-image-link') as HTMLElement).click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith('https://cdn.example/pic.png'));
  });

  it('falls back to openExternalUrl when the browser fetch fails', async () => {
    mockInvoke.mockReturnValue(null);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network'))));
    const entry = noteEntry('<img src="https://cdn.example/pic.png" alt="pic" />');
    appendImageDownloadLinks(entry);
    (entry.querySelector('.note-image-link') as HTMLElement).click();
    await vi.waitFor(() => expect(mockOpenExternal).toHaveBeenCalledWith('https://cdn.example/pic.png'));
  });
});
