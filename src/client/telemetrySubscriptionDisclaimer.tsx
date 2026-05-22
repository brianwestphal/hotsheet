/**
 * HS-8543 — shared "cost is an estimate for subscription users"
 * disclaimer notice. Rendered above the cost-overview chips on both
 * the cross-project stats page (§70) and the per-project analytics-
 * dashboard "Claude usage" section (§71).
 *
 * Always shown — unlike the more specific HS-8497
 * `.telemetry-subscription-notice` block that only appears when the
 * global cost mode is `'subscription'`, this disclaimer is a
 * permanent reminder. Users commonly run Claude under Claude Pro /
 * Max, so the dollar amounts the telemetry receiver records (which
 * are the API-equivalent cost the Claude Code OTel exporter emits)
 * don't match what they actually pay — even if the cost mode toggle
 * is in `'api'` mode.
 *
 * Visually: gray rounded card + lucide asterisk icon + a single
 * sentence of copy. The same superscript `*` that appears next to
 * the sidebar widget's today-cost (HS-8543) points at this notice.
 */

import { toElement } from './dom.js';

const ASTERISK_ICON = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16" height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    className="telemetry-subscription-disclaimer-icon"
    aria-hidden="true"
  >
    <path d="M12 6v12"></path>
    <path d="M17.196 9 6.804 15"></path>
    <path d="m6.804 9 10.392 6"></path>
  </svg>
);

/**
 * Build the disclaimer notice element. Pure render — the caller
 * inserts it above its cost-overview chips. Returns a fresh element
 * per call so re-renders never share the same node.
 */
export function renderSubscriptionDisclaimer(): HTMLElement {
  return toElement(
    <div className="telemetry-subscription-disclaimer" role="note">
      {ASTERISK_ICON}
      <span className="telemetry-subscription-disclaimer-text">
        For users with Claude Pro / Max / other subscriptions, the costs shown are estimates only, based on API-equivalent usage.
      </span>
    </div>
  );
}
