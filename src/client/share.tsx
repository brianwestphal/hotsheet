import type { GlobalConfig } from '../global-config.js';
import { api } from './api.js';
import { byIdOrNull } from './dom.js';

const SHARE_URL = 'https://www.npmjs.com/package/hotsheet';
const SHARE_TEXT = 'A fast, local ticket tracker that feeds your AI coding tools.';

const SESSION_ACCUMULATE_INTERVAL = 30_000; // 30 seconds
const MIN_TOTAL_SECONDS = 300; // 5 minutes total usage
const MIN_SESSION_SECONDS = 60; // 1 minute in current session
const REPROMPT_DAYS = 30;

let sessionStart: number;
let intervalId: ReturnType<typeof setInterval> | undefined;
let lastAccumulatedAt: number;

/** Trigger the Web Share API, falling back to clipboard copy. */
async function triggerShare(): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- navigator.share is not available in all browsers at runtime
    if (navigator.share !== undefined) {
      await navigator.share({ title: 'Hot Sheet', text: SHARE_TEXT, url: SHARE_URL });
    } else {
      await navigator.clipboard.writeText(`${SHARE_TEXT}\n${SHARE_URL}`);
    }
  } catch {
    // User cancelled share dialog — not an error
  }
}

/** Accumulate session time into the global config and optionally show the prompt. */
async function accumulateAndCheck(): Promise<void> {
  const now = Date.now();
  const elapsed = Math.round((now - lastAccumulatedAt) / 1000);
  lastAccumulatedAt = now;

  try {
    const config = await api<GlobalConfig>('/global-config');
    const newTotal = (config.shareTotalSeconds ?? 0) + elapsed;
    await api('/global-config', { method: 'PATCH', body: { shareTotalSeconds: newTotal } });

    // Check if we should show the prompt
    if (config.shareAccepted === true) return;
    if (newTotal < MIN_TOTAL_SECONDS) return;
    if ((now - sessionStart) < MIN_SESSION_SECONDS * 1000) return;

    if (config.shareLastPrompted !== undefined && config.shareLastPrompted !== '') {
      const lastPrompted = new Date(config.shareLastPrompted).getTime();
      const daysSince = (now - lastPrompted) / (1000 * 60 * 60 * 24);
      if (daysSince < REPROMPT_DAYS) return;
    }

    showShareBanner();
  } catch {
    // Silently ignore — non-critical feature
  }
}

/** Show the share prompt banner. */
function showShareBanner(): void {
  const banner = byIdOrNull('share-banner');
  if (!banner || banner.style.display !== 'none') return;
  banner.style.display = 'flex';

  // Stop the interval — no need to keep accumulating once prompted
  if (intervalId !== undefined) {
    clearInterval(intervalId);
    intervalId = undefined;
  }
}

/** Dismiss the banner and record the timestamp. */
async function dismissBanner(): Promise<void> {
  const banner = byIdOrNull('share-banner');
  if (banner) banner.style.display = 'none';
  try {
    await api('/global-config', { method: 'PATCH', body: { shareLastPrompted: new Date().toISOString() } });
  } catch { /* ignore */ }
}

/** Handle the share action from the banner. */
async function handleBannerShare(): Promise<void> {
  await triggerShare();
  const banner = byIdOrNull('share-banner');
  if (banner) banner.style.display = 'none';
  try {
    await api('/global-config', {
      method: 'PATCH',
      body: { shareAccepted: true, shareLastPrompted: new Date().toISOString() },
    });
  } catch { /* ignore */ }
}

/** Initialize the share feature: session tracking, banner prompts, and footer share link. */
export function initShare(): void {
  sessionStart = Date.now();
  lastAccumulatedAt = sessionStart;

  // Accumulate time periodically and check prompt criteria
  intervalId = setInterval(() => { void accumulateAndCheck(); }, SESSION_ACCUMULATE_INTERVAL);

  // Footer share link — always triggers share directly
  const shareLink = byIdOrNull('share-link');
  if (shareLink) {
    shareLink.addEventListener('click', (e) => {
      e.preventDefault();
      void triggerShare();
    });
  }

  // Banner buttons
  byIdOrNull('share-banner-share')?.addEventListener('click', () => { void handleBannerShare(); });
  byIdOrNull('share-banner-dismiss')?.addEventListener('click', () => { void dismissBanner(); });
}
