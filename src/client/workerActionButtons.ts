/**
 * HS-9068 — the "Worker pool" + "In-flight work" entry points, moved out of
 * the git-status popover onto the sidebar as two iconic buttons on a single
 * row (`#sidebar-worker-actions`, just above the "Auto worker pool" switch).
 *
 * Both panels are lazy-imported on click so they stay out of the initial
 * bundle. Visibility of the row follows the play/auto section and is toggled
 * in `channelUI.tsx` alongside `#sidebar-worker-auto`.
 */

/** Wire the sidebar worker-pool + in-flight-work buttons. Call once at boot. */
export function initWorkerActionButtons(): void {
  const poolBtn = document.getElementById('sidebar-worker-pool-btn');
  if (poolBtn !== null) {
    poolBtn.addEventListener('click', () => {
      void import('./workerPoolPanel.js').then(m => m.openWorkerPoolPanel());
    });
  }
  const inflightBtn = document.getElementById('sidebar-inflight-btn');
  if (inflightBtn !== null) {
    inflightBtn.addEventListener('click', () => {
      void import('./inflightPanel.js').then(m => m.openInflightPanel());
    });
  }
}
