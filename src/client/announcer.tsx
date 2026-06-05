/**
 * §78 Announcer (HS-8747) — the header "Listen" affordance and the
 * generate→play flow that ties the typed API callers (`src/api/announcer.ts`)
 * to the transcript PIP (`announcerPip.tsx`).
 *
 * The button is hidden unless the project has opted in AND has an API key
 * configured (`getAnnouncerStatus`). Clicking it generates a fresh batch of
 * announcements since the listened cursor, then plays the full active reel;
 * the listened cursor advances when the PIP closes so the next session only
 * narrates new work.
 */
import { advanceAnnouncerCursor, generateAnnouncements, getAnnouncerEntries, getAnnouncerStatus } from '../api/index.js';
import { closeAnnouncerPip, openAnnouncerPip } from './announcerPip.js';
import { byIdOrNull } from './dom.js';
import { showToast } from './toast.js';

function listenButton(): HTMLButtonElement | null {
  return byIdOrNull<HTMLButtonElement>('announcer-listen-btn');
}

/** Show/hide the Listen button based on the per-project opt-in + key state.
 *  Called at init, after settings changes, and on project switch. */
export async function refreshAnnouncerVisibility(): Promise<void> {
  const btn = listenButton();
  if (btn === null) return;
  try {
    const status = await getAnnouncerStatus();
    btn.style.display = status.enabled && status.hasKey ? '' : 'none';
  } catch {
    btn.style.display = 'none';
  }
}

async function startListening(btn: HTMLButtonElement): Promise<void> {
  if (btn.classList.contains('is-busy')) return;
  btn.classList.add('is-busy');
  btn.disabled = true;
  try {
    // Generate the latest batch (may produce 0 if nothing new — that's fine,
    // the existing reel still plays). Surface a hard failure but keep going to
    // play whatever is already persisted.
    try {
      await generateAnnouncements();
    } catch {
      showToast('Announcer: could not generate new entries (check your API key).', { variant: 'warning', durationMs: 5000 });
    }
    const entries = await getAnnouncerEntries();
    if (entries.length === 0) {
      showToast('Nothing new to announce yet — do some work and try again.', { durationMs: 4000 });
      return;
    }
    openAnnouncerPip(entries, {
      onClose: () => {
        // Mark "listened up to now" so the next generate doesn't re-cover this.
        advanceAnnouncerCursor().catch(() => { /* best-effort */ });
        void refreshAnnouncerVisibility();
      },
    });
  } finally {
    btn.classList.remove('is-busy');
    btn.disabled = false;
  }
}

/** Bind the header Listen button + set its initial visibility. */
export function initAnnouncer(): void {
  const btn = listenButton();
  if (btn === null) return;
  btn.addEventListener('click', () => { void startListening(btn); });
  void refreshAnnouncerVisibility();
}

/** Tear down any open PIP — call on project switch before reloading state. */
export function teardownAnnouncer(): void {
  closeAnnouncerPip();
}
