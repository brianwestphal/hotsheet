// @vitest-environment happy-dom
/**
 * HS-7956 — pure-helper tests for the Phase 3 expanded popover. The
 * DOM-mounting / fetch-flow paths are exercised at e2e; these tests pin
 * the branch-line + ahead/behind-line formatting math.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getGlassboxStatus, getRecentCommits, gitReveal, reviewInGlassbox } from '../api/index.js';
import { toElement } from './dom.js';
import { buildAheadBehindLine, buildBranchLine, commitBodyPreview, paintPopover } from './gitStatusPopover.js';

// HS-9205 / HS-8860 — mock the typed API so the file-row click flow and the
// recent-commits pager can be exercised in happy-dom. vitest hoists `vi.mock`
// above the imports, so the modules resolve to these fns.
vi.mock('../api/index.js', () => ({
  getGitStatusWithFiles: vi.fn(() => Promise.resolve(null)),
  getGlassboxStatus: vi.fn(() => Promise.resolve({ available: false })),
  getPendingCommits: vi.fn(() => Promise.resolve({ commits: [], truncated: false })),
  getRecentCommits: vi.fn(() => Promise.resolve({ commits: [], hasMore: false })),
  gitReveal: vi.fn(() => Promise.resolve({ ok: true })),
  reviewInGlassbox: vi.fn(() => Promise.resolve({ ok: true })),
}));

function status(o: Partial<{
  branch: string;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  lastFetchedAt: number | null;
}>): {
  branch: string;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  lastFetchedAt: number | null;
} {
  return {
    branch: 'main',
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    lastFetchedAt: null,
    ...o,
  };
}

describe('buildBranchLine (HS-7956)', () => {
  it('renders the upstream arrow form when upstream is set', () => {
    expect(buildBranchLine(status({ branch: 'main', upstream: 'origin/main' })))
      .toBe('main → origin/main');
  });

  it('renders the no-upstream form when upstream is null and not detached', () => {
    expect(buildBranchLine(status({ branch: 'feat/x', upstream: null })))
      .toBe('feat/x (no upstream)');
  });

  it('renders the detached form (parens around the SHA-stand-in branch label)', () => {
    expect(buildBranchLine(status({ branch: 'a1b2c3d', detached: true })))
      .toBe('(detached: a1b2c3d)');
  });
});

describe('buildAheadBehindLine (HS-7956)', () => {
  it('returns null when no upstream is set', () => {
    expect(buildAheadBehindLine(status({}))).toBeNull();
  });

  it('returns "up to date" when upstream is set but ahead+behind are zero', () => {
    expect(buildAheadBehindLine(status({ upstream: 'origin/main' }))).toBe('up to date');
  });

  it('returns "N ahead" when only ahead', () => {
    expect(buildAheadBehindLine(status({ upstream: 'origin/main', ahead: 3 }))).toBe('3 ahead');
  });

  it('returns "M behind" when only behind', () => {
    expect(buildAheadBehindLine(status({ upstream: 'origin/main', behind: 1 }))).toBe('1 behind');
  });

  it('joins both with a bullet when both are non-zero', () => {
    expect(buildAheadBehindLine(status({ upstream: 'origin/main', ahead: 3, behind: 1 })))
      .toBe('3 ahead • 1 behind');
  });
});

// HS-7975 follow-up — the bare horizontal separator the user reported was the
// `border-top` on `.git-popover-buckets` showing through whenever the working
// tree was clean (no staged / unstaged / untracked / conflicted files). The
// fix skips appending the buckets element when none of the bucket rows would
// render, so the separator only appears when there's actually file content to
// separate.
describe('paintPopover bucket-strip suppression (HS-7975 follow-up)', () => {
  function mountPopover(): HTMLElement {
    // HS-8467 — TSX fixture instead of `innerHTML = '<html-string>'`.
    const popover = toElement(
      <div className="git-popover">
        <div className="git-popover-header">
          <div className="git-popover-title"></div>
        </div>
        <div className="git-popover-body"></div>
      </div>
    );
    document.body.appendChild(popover);
    return popover;
  }

  it('omits the .git-popover-buckets strip when all four counts are zero', () => {
    const popover = mountPopover();
    paintPopover(popover, status({ upstream: 'origin/main', ahead: 1 }));
    expect(popover.querySelector('.git-popover-buckets')).toBeNull();
    document.body.innerHTML = '';
  });

  it('renders the .git-popover-buckets strip when at least one count is non-zero', () => {
    const popover = mountPopover();
    paintPopover(popover, status({ upstream: 'origin/main', staged: 2 }));
    expect(popover.querySelector('.git-popover-buckets')).not.toBeNull();
    document.body.innerHTML = '';
  });

  it('omits the strip for a clean up-to-date branch (every count zero, no ahead/behind)', () => {
    const popover = mountPopover();
    paintPopover(popover, status({ upstream: 'origin/main' }));
    expect(popover.querySelector('.git-popover-buckets')).toBeNull();
    document.body.innerHTML = '';
  });
});

describe('file-row click → Glassbox diff / Finder fallback (HS-9205)', () => {
  const files = { staged: ['src/a.ts'], unstaged: [], untracked: [], conflicted: [], truncated: { staged: false, unstaged: false, untracked: false, conflicted: false } };
  const withStagedFile = { ...status({ staged: 1 }), files };

  function mount(): HTMLElement {
    const popover = toElement(
      <div className="git-popover">
        <div className="git-popover-header"><div className="git-popover-title"></div></div>
        <div className="git-popover-body"></div>
      </div>
    );
    document.body.appendChild(popover);
    return popover;
  }
  // Let the up-front getGlassboxStatus().then settle so `glassboxAvailable` is set.
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

  beforeEach(() => { vi.clearAllMocks(); document.body.innerHTML = ''; });

  it('opens the file diff in Glassbox (files mode) when Glassbox is installed', async () => {
    vi.mocked(getGlassboxStatus).mockResolvedValue({ available: true });
    const popover = mount();
    paintPopover(popover, withStagedFile);
    await settle();
    popover.querySelector<HTMLElement>('.git-popover-file')!.click();
    expect(reviewInGlassbox).toHaveBeenCalledWith({ mode: 'files', patterns: ['src/a.ts'] });
    expect(gitReveal).not.toHaveBeenCalled();
  });

  it('falls back to reveal-in-Finder when Glassbox is not installed', async () => {
    vi.mocked(getGlassboxStatus).mockResolvedValue({ available: false });
    const popover = mount();
    paintPopover(popover, withStagedFile);
    await settle();
    popover.querySelector<HTMLElement>('.git-popover-file')!.click();
    expect(gitReveal).toHaveBeenCalledWith({ path: 'src/a.ts' });
    expect(reviewInGlassbox).not.toHaveBeenCalled();
  });
});

describe('recent commits section + "Show more" pager (HS-8860)', () => {
  const commit = (h: string) => ({ hash: h.repeat(40), shortHash: h.repeat(7), subject: `subj ${h}`, body: '' });
  function mount(): HTMLElement {
    const popover = toElement(
      <div className="git-popover">
        <div className="git-popover-header"><div className="git-popover-title"></div></div>
        <div className="git-popover-body"></div>
      </div>
    );
    document.body.appendChild(popover);
    return popover;
  }
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
  const rows = (p: HTMLElement) => p.querySelectorAll('.git-popover-recent .git-popover-commit');

  beforeEach(() => { vi.clearAllMocks(); document.body.innerHTML = ''; });

  it('renders the first page and pages in the next batch on "Show more"', async () => {
    vi.mocked(getGlassboxStatus).mockResolvedValue({ available: false });
    vi.mocked(getRecentCommits)
      .mockResolvedValueOnce({ commits: [commit('a'), commit('b')], hasMore: true })
      .mockResolvedValueOnce({ commits: [commit('c')], hasMore: false });

    const popover = mount();
    paintPopover(popover, status({}));
    await settle();

    expect(rows(popover)).toHaveLength(2);
    const moreBtn = popover.querySelector<HTMLButtonElement>('.git-popover-recent-more')!;
    expect(moreBtn.hidden).toBe(false);
    // The pager requests the next page skipping what's already loaded.
    expect(getRecentCommits).toHaveBeenLastCalledWith(5, 0);

    moreBtn.click();
    await settle();
    expect(rows(popover)).toHaveLength(3);
    expect(getRecentCommits).toHaveBeenLastCalledWith(5, 2); // skip past the 2 loaded
    expect(moreBtn.hidden).toBe(true); // hasMore false → pager hidden
  });

  it('mounts nothing for an empty repo (no commits)', async () => {
    vi.mocked(getRecentCommits).mockResolvedValue({ commits: [], hasMore: false });
    const popover = mount();
    paintPopover(popover, status({}));
    await settle();
    expect(popover.querySelector('.git-popover-recent-inner')).toBeNull();
  });
});

describe('commitBodyPreview (HS-8472)', () => {
  it('keeps up to the first 3 non-blank lines', () => {
    expect(commitBodyPreview('line1\nline2\nline3\nline4')).toBe('line1\nline2\nline3');
  });

  it('drops blank lines before capping', () => {
    expect(commitBodyPreview('a\n\n\nb\n\nc\nd')).toBe('a\nb\nc');
  });

  it('returns an empty string for an empty / whitespace-only body', () => {
    expect(commitBodyPreview('')).toBe('');
    expect(commitBodyPreview('   \n  \n')).toBe('');
  });
});
