/**
 * Claude permission-request UI. Historically there were two variants: a
 * full-screen overlay for the active project and a compact popup for
 * non-active projects. HS-6536 unified them — every pending permission
 * (active or not) uses the same popup anchored to its project tab.
 *
 * HS-6637: Minimizing the popup drops it into a pulsating blue dot on the
 * owning project's tab; clicking the tab re-shows the same popup. The "No
 * response needed" link at the popup's bottom-left dismisses outright (for
 * cases where the user wants to respond via Claude directly). A minimized
 * popup auto-dismisses after 2 minutes so it can't linger forever.
 *
 * HS-7266: the popup is non-modal — it does NOT dismiss or minimize on
 * outside clicks. Users can interact with the rest of the UI while it is
 * visible. Minimize is an explicit action via the popup's own Minimize link.
 *
 * HS-8384 — pure helpers + types live in `permissionOverlayHelpers.ts`
 * and are re-exported below so existing `from './permissionOverlay.js'`
 * imports (channelStore.ts, channelUI.tsx, the test file) keep working.
 */

import { respondChannelPermission } from '../api/index.js';
import type { SafeHtml } from '../jsx-runtime.js';
import { extractPrimaryValue } from '../permissionAllowRules.js';
import { announcePermission } from './announcerPermissionSpeech.js';
import { buildBashPermissionPreview } from './bashPermissionPreview.js';
import { channelStore } from './channelStore.js';
import { clearProjectAttention, isChannelBusy, setChannelBusy } from './channelUI.js';
import { TIMERS } from './constants/timers.js';
import { toElement } from './dom.js';
import { renderEditDiffPreview } from './editDiffPreview.js';
import { buildAlwaysAllowAffordance } from './permissionAllowListUI.js';
import { openPermissionDialogShell } from './permissionDialogShell.js';
import {
  _inspectLiveCheckoutForTesting,
  _resetLiveCheckoutStateForTesting,
  disconnectActiveLiveTermResizeObserver,
  getActiveCheckout,
  releaseActiveCheckoutIfAny,
  runLiveTermFitWithRetry,
  setActiveCheckout,
  setActiveLiveTermResizeObserver,
} from './permissionLiveCheckout.js';
import {
  extractWriteFields,
  LIVE_CHECKOUT_PREVIEW_CHAR_THRESHOLD,
  type PermissionData,
  shouldUseLiveCheckout,
} from './permissionOverlayHelpers.js';
// HS-8394 Phase 2 — popup state-machine moved to
// `permissionPopupStateMachine.ts`; the shared state slot + dedup
// collections moved to `permissionPopupState.ts`. Imported here AND
// re-exported below for back-compat with existing
// `from './permissionOverlay.js'` consumers (the test file +
// `projectTabs.tsx` etc.).
import {
  dismissedRequestIds,
  freshPermissionOverlayState,
  MINIMIZED_TIMEOUT_MS,
  minimizedRequests,
  permissionState,
  respondedRequestIds,
  setPermissionState,
} from './permissionPopupState.js';
import {
  clearTabPermissionHighlight,
  getMinimizedPermissionSecrets,
  getQueuedPermissionRequestIds,
  initPermissionPopupStateMachine,
  mountNextFromPendingStack,
  type PermissionPollResponse,
  processPermissionPollResponse,
  reopenMinimizedForSecret,
  shouldSkipPermission,
  showPermissionPopup,
  startPermissionPolling,
  stopPermissionPolling,
  syncMinimizedDots,
} from './permissionPopupStateMachine.js';
import { formatEditDiff, formatInputPreview } from './permissionPreview.js';
import { projectsByIdSignal } from './projectsStore.js';
import { type ProjectInfo, state } from './state.js';
import { requestAttention } from './tauriIntegration.js';
import { getProjectDefault, getSessionOverride, resolveAppearance, resolveAppearanceBackground } from './terminalAppearance.js';
import { checkout, peekEntryDims } from './terminalCheckout.js';
import { buildWritePermissionPreview } from './writePermissionPreview.js';

const CHECK_ICON: SafeHtml = <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>;
const X_ICON: SafeHtml = <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>;

export {
  clearTabPermissionHighlight,
  dismissedRequestIds,
  extractWriteFields,
  getMinimizedPermissionSecrets,
  getQueuedPermissionRequestIds,
  LIVE_CHECKOUT_PREVIEW_CHAR_THRESHOLD,
  MINIMIZED_TIMEOUT_MS,
  type PermissionData,
  type PermissionPollResponse,
  permissionState,
  processPermissionPollResponse,
  reopenMinimizedForSecret,
  respondedRequestIds,
  shouldSkipPermission,
  shouldUseLiveCheckout,
  showPermissionPopup,
  startPermissionPolling,
  stopPermissionPolling,
};

// Wire the state machine to call back into this module's body-mount.
initPermissionPopupStateMachine({
  mountPopupBody: (secret, perm) => { showPermissionPopupBody(secret, perm); },
});

function showPermissionPopupBody(secret: string, perm: PermissionData) {
  // HS-8781 — verbally announce the permission check (when the global setting is
  // on) so you hear what Claude is asking for while away. Deduped per
  // request_id; coordinates with any active narration so it doesn't talk over a
  // segment. Fire-and-forget. HS-8794 — name the owning project so you hear
  // which one is asking; `''` when the secret isn't in the current list. The
  // Record index is typed non-nullable (no `noUncheckedIndexedAccess`); widen to
  // `| undefined` so an unknown secret safely falls back instead of `undefined.name`.
  const owningProject = projectsByIdSignal.value[secret] as ProjectInfo | undefined;
  announcePermission(perm, owningProject?.name ?? '');
  // A permission request is proof Claude is actively working — extend busy timeout.
  if (permissionState.channelBusyTimeoutModule) {
    clearTimeout(permissionState.channelBusyTimeoutModule);
    permissionState.setChannelBusyTimeoutRefModule(setTimeout(() => {
      if (isChannelBusy()) setChannelBusy(false);
    }, TIMERS.CHANNEL_BUSY_TIMEOUT_MS));
  }
  if (!isChannelBusy()) setChannelBusy(true);

  // Find the tab element to highlight. Anchor positioning happens inside
  // the shared shell (HS-8066 / HS-8069); we still toggle the tab's
  // `.permission-highlight` class for the existing visual cue.
  const tab = document.querySelector<HTMLElement>(`.project-tab[data-secret="${secret}"]`);
  if (tab) tab.classList.add('permission-highlight');

// HS-7951 — when the permission is for an Edit / Write tool with parseable
  // `old_string` / `new_string`, render a color-coded inline unified diff
  // instead of the flat-JSON dump. Falls back to the existing string preview
  // for every other tool + for malformed Edit/Write payloads.
  const editDiff = perm.input_preview !== undefined
    ? formatEditDiff(perm.tool_name, perm.input_preview)
    : null;
  // Format Claude's raw `input_preview` into a human-readable preview — Bash
  // gets just the command line, other known tools get their primary field,
  // generic JSON gets flattened key/value lines (HS-6634).
  const previewText = editDiff === null && perm.input_preview !== undefined
    ? formatInputPreview(perm.tool_name, perm.input_preview)
    : '';
  const hasStringPreview = previewText !== '';

  // HS-8171 v2 + HS-8217 — when the preview is non-trivial the popup
  // body becomes the LIVE project terminal via the §54 checkout
  // mechanism instead of a static `<pre>` / DOM diff. The user can
  // scroll through the real PTY scrollback AND interact with the
  // running `claude` directly from inside the popup. When the popup
  // is dismissed / minimized / responded to, the checkout releases
  // and the previous owner (drawer pane, dashboard tile, etc.) gets
  // the terminal back via the LIFO stack. Pre-fix iterations (HS-7999
  // / HS-8139 / HS-8158 / HS-8171 v1) tried to mount a serialized
  // snapshot — the user reported repeated cases where the snapshot
  // sampled stale or empty content. A real checkout sidesteps the
  // sampling problem entirely. See `shouldUseLiveCheckout` for the
  // pure heuristic — pre-HS-8217 only truncation triggered live; the
  // user reported (HS-8217) that the static color-coded HTML diff
  // was still hard to follow vs the actual claude TUI's colored
  // output, so the gate now also fires for any non-trivial preview
  // (Edit/Write tool with parseable diff, multi-line flat preview,
  // long single-line flat preview).
  // HS-8299 — Bash gets a tool-specific layout: title "Allow Claude to
  // run", body is a scrollable `<pre>` of the command (NOT a live-
  // terminal checkout, NOT the flat-JSON dump), actions are three
  // vertically-stacked buttons (Yes / Yes-and-allow-always / No). The
  // middle button creates a `Bash(<command>)` always-allow rule via the
  // same §47.4 mechanism the existing checkbox uses. We compute the
  // primary value (the bash command) up-front since both the always-
  // affordance default-skipping logic AND the new Bash layout need it.
  const primaryValue = perm.input_preview !== undefined
    ? extractPrimaryValue(perm.tool_name, perm.input_preview)
    : null;
  const isBashCustomLayout = perm.tool_name === 'Bash' && primaryValue !== null;

  // HS-8296 — Write gets a parallel tool-specific layout: title
  // `Allow write to <path>?`, body is a scrollable `<pre>` of the file
  // content (or `Binary Data (NNN bytes)` for non-text), actions are
  // the same three-stacked-button column as Bash. Live-checkout is
  // bypassed entirely (per the user's Q4 = "replace" answer).
  const writeFields = perm.tool_name === 'Write' && perm.input_preview !== undefined
    ? extractWriteFields(perm.input_preview)
    : null;
  const isWriteCustomLayout = writeFields !== null;

  // For Bash / Write, the live-checkout / diff / flat-preview pipeline
  // is bypassed entirely — the tool-specific layouts own their own
  // bodies. For every other tool, the existing HS-8217 heuristic still
  // picks live-checkout for non-trivial previews.
  // HS-8582 — `shouldUseLiveCheckout` now owns the Bash exclusion (Bash never
  // uses the live terminal), so the `!isBashCustomLayout` guard is folded in
  // there. A truncated long-bash command (extractPrimaryValue → null, so
  // `isBashCustomLayout` false) now falls to the flat `<pre>` of the recovered
  // command instead of an empty live-terminal box.
  const useLiveCheckout = !isWriteCustomLayout
    && perm.input_preview !== undefined
    && shouldUseLiveCheckout(perm.tool_name, editDiff, previewText);

  // HS-8069 — body slot: live-terminal checkout container (HS-8171 v2)
  // when truncation fired, else the diff DOM (HS-7951), else the
  // flat-JSON pre-tag preview, else nothing. Build the element first so
  // we can pass it to the shell as a slot.
  // HS-8299 — when Bash, use the dedicated `bashPermissionPreview`
  // helper; the helper returns BOTH the body and the actions slot, so
  // the existing actions block + always-allow affordance below are
  // skipped for this branch.
  let bodyElement: HTMLElement | undefined;
  let liveTermContainer: HTMLElement | null = null;
  let actions: HTMLElement;
  let alwaysAffordance: HTMLElement | null = null;
  let writeCustomTitle: string | null = null;
  if (isBashCustomLayout) {
    const parts = buildBashPermissionPreview({
      command: primaryValue,
      onAllow: () => { respondToPermission('allow'); },
      onAllowAlways: () => { respondToPermission('allow'); },
      onDeny: () => { respondToPermission('deny'); },
    });
    bodyElement = parts.bodyElement;
    actions = parts.actionsElement;
  } else if (isWriteCustomLayout) {
    const parts = buildWritePermissionPreview({
      filePath: writeFields.filePath,
      content: writeFields.content,
      onAllow: () => { respondToPermission('allow'); },
      onAllowAlways: () => { respondToPermission('allow'); },
      onDeny: () => { respondToPermission('deny'); },
    });
    bodyElement = parts.bodyElement;
    actions = parts.actionsElement;
    writeCustomTitle = parts.title;
  } else {
    if (useLiveCheckout) {
      liveTermContainer = toElement(<div className="permission-popup-live-terminal"></div>);
      bodyElement = liveTermContainer;
    } else if (editDiff !== null) {
      bodyElement = renderEditDiffPreview(editDiff);
    } else if (hasStringPreview) {
      bodyElement = toElement(<pre className="permission-popup-preview">{previewText}</pre>);
    }

    // HS-8069 — actions slot: Allow / Deny icon buttons.
    actions = toElement(
      <div className="permission-popup-actions">
        <button className="permission-popup-allow" title="Allow">{CHECK_ICON}</button>
        <button className="permission-popup-deny" title="Deny">{X_ICON}</button>
      </div>
    );

    // HS-7953 / HS-8069 — "Always allow this" affordance. Skipped for
    // non-allow-listable tools (Edit / Write / unknown) and when the
    // primary-field value is empty. Confirming a new rule writes to
    // settings.json then immediately invokes the allow-current-request path.
    if (primaryValue !== null) {
      alwaysAffordance = buildAlwaysAllowAffordance({
        toolName: perm.tool_name,
        primaryValue,
        onCommit: () => { respondToPermission('allow'); },
      });
    }
  }

  // HS-8171 v2 / HS-8182 — the checkout handle (if any) lives at module
  // scope (`permissionState.activeCheckoutHandle`) so the polling-loop's auto-dismiss
  // path can release it too. Every popup-close path inside this scope
  // routes through `releaseActiveCheckoutIfAny()` so the release is
  // idempotent + single-source-of-truth.

  /**
   * HS-8218 — fired from the checkout's `onNoLiveSession` callback when
   * the server returned `noSession: true` (no live PTY existed for
   * `terminalId: 'default'` and `noSpawn: true` prevented a fresh
   * spawn). Release the checkout and swap the popup body from the
   * empty live-terminal container to the same flat / diff preview the
   * non-live code path would have rendered.
   *
   * Pre-fix the popup checked out `terminalId: 'default'` regardless;
   * if the project's claude was running under a different terminal id
   * (and `'default'` had never been started), the server's `attach`
   * spawned a brand-new `claude --dangerously-load-development-channels`
   * PTY into the popup body, which stole the channel-server's MCP
   * connection from the user's actual claude session.
   */
  function fallbackToNonLivePreview(): void {
    if (liveTermContainer === null) return;
    releaseActiveCheckoutIfAny();
    let fallback: HTMLElement;
    if (editDiff !== null) {
      fallback = renderEditDiffPreview(editDiff);
    } else if (hasStringPreview) {
      fallback = toElement(<pre className="permission-popup-preview">{previewText}</pre>);
    } else {
      // Neither preview was buildable — show a minimal explainer so the
      // popup body isn't empty.
      fallback = toElement(
        <pre className="permission-popup-preview">{'(no preview — terminal not live)'}</pre>,
      );
    }
    liveTermContainer.replaceWith(fallback);
    liveTermContainer = null;
  }

  function clearPopupOnly() {
    permissionState.activePopupRequestId = null;
    permissionState.activePopupOwnerSecret = null;
    // HS-8323 — fresh lookup by data-secret instead of using the
    // closure-captured `tab` ref. The tab strip's bindList (HS-8235 /
    // HS-8317) preserves DOM identity per secret in the common case, but
    // a multi → single → multi project-count transition tears down + re-
    // creates rows, leaving the closure-captured ref detached. Fresh
    // lookup targets the LIVE node either way.
    clearTabPermissionHighlight(secret);
  }

  function cleanupAndDismiss() {
    releaseActiveCheckoutIfAny();
    dismissedRequestIds.add(perm.request_id);
    clearPopupOnly();
    // HS-8219 — pop the next queued permission off the stack now that
    // the active slot is free. Without this the user would have to
    // wait up to ~100 ms for the next poll cycle to surface the next
    // pending permission.
    mountNextFromPendingStack();
  }

  function cleanupAndMinimize() {
    releaseActiveCheckoutIfAny();
    clearPopupOnly();
    const timeoutId = setTimeout(() => {
      const rec = minimizedRequests.get(perm.request_id);
      if (!rec) return;
      minimizedRequests.delete(perm.request_id);
      dismissedRequestIds.add(perm.request_id);
      syncMinimizedDots();
    }, MINIMIZED_TIMEOUT_MS);
    minimizedRequests.set(perm.request_id, { secret, perm, timeoutId });
    syncMinimizedDots();
    // HS-8219 — same as cleanupAndDismiss: pop the next queued
    // permission immediately so the user sees it without waiting on a
    // poll round-trip.
    mountNextFromPendingStack();
  }

  function respondToPermission(behavior: 'allow' | 'deny') {
    respondedRequestIds.add(perm.request_id);
    // Send with the OWNING project's secret — not the active project's — so a
    // response initiated from a background-project popup still routes.
    // Include tool/description/input_preview the client already has so that
    // the server-side command-log entry has useful detail even when the
    // respond races ahead of the original permission_request log (HS-6477).
    // HS-8085 — forward the OWNING project's secret (the typed caller's
    // `secret` arg → `apiWithSecret` via the `_runner` transport), so a
    // response initiated from a background-project popup sets
    // `X-Hotsheet-Secret` to the owning project rather than the active one.
    void respondChannelPermission({
      request_id: perm.request_id,
      behavior,
      tool_name: perm.tool_name,
      description: perm.description,
      input_preview: perm.input_preview ?? '',
    }, secret).catch(() => { /* network blip — overlay UI already torn down by clearPopupOnly() below */ });
    clearProjectAttention(secret);
    // Also drop any minimized bookkeeping for this request.
    const rec = minimizedRequests.get(perm.request_id);
    if (rec) { clearTimeout(rec.timeoutId); minimizedRequests.delete(perm.request_id); syncMinimizedDots(); }
    clearPopupOnly();
    // HS-8171 v2 — release the live-terminal checkout BEFORE
    // tearing down the popup DOM so the xterm element reparents
    // cleanly into the previous owner's mountInto rather than being
    // momentarily orphaned in the removed-from-document subtree.
    releaseActiveCheckoutIfAny();
    handle.tearDownDom();
    // HS-8219 — surface the next queued permission immediately
    // (before the next ~100 ms poll tick).
    mountNextFromPendingStack();
  }

  // HS-8069 — chrome (header / anchor / footer-link row / close X) is now
  // owned by `permissionDialogShell.tsx`. Body / actions / always-affordance
  // slots carry the consumer-specific content. The shell's close button maps
  // to "No response needed" semantics (the existing §47 popup didn't have a
  // close X — adding the shell adds one, and the cleanest mapping is "user
  // dismissed without responding").
  // HS-8299 / HS-8296 — Bash + Write use tool-specific dialog headers:
  // - Bash: title "Allow Claude to run", no `toolChip` (the title
  //   carries the verb so a separate `Bash` chip would be redundant)
  // - Write: title `Allow write to <path>?` (computed inside
  //   `writePermissionPreview.tsx`), no `toolChip` for the same reason
  // Every other tool keeps the existing `${tool_name}` chip +
  // description-as-title pairing.
  let dialogTitle = perm.description;
  let dialogToolChip: string | undefined = perm.tool_name;
  let dialogAriaLabel = `Permission request: ${perm.tool_name} — ${perm.description}`;
  if (isBashCustomLayout) {
    dialogTitle = 'Allow Claude to run';
    dialogToolChip = undefined;
    dialogAriaLabel = 'Permission request: Allow Claude to run';
  } else if (isWriteCustomLayout && writeCustomTitle !== null) {
    dialogTitle = writeCustomTitle;
    dialogToolChip = undefined;
    dialogAriaLabel = `Permission request: ${writeCustomTitle}`;
  }

  const handle = openPermissionDialogShell({
    rootClassName: 'permission-popup',
    ariaLabel: dialogAriaLabel,
    toolChip: dialogToolChip,
    title: dialogTitle,
    bodyElement,
    actions,
    alwaysAffordance,
    onClose: () => { cleanupAndDismiss(); },
    onMinimize: () => { cleanupAndMinimize(); },
    onNoResponseNeeded: () => { cleanupAndDismiss(); },
    projectSecret: secret,
  });

  // HS-8299 / HS-8296 — Bash + Write layouts wire their buttons inside
  // their own preview helpers; only the legacy two-icon-button path
  // needs click wiring here.
  if (!isBashCustomLayout && !isWriteCustomLayout) {
    handle.overlay.querySelector('.permission-popup-allow')!.addEventListener('click', (e) => {
      e.stopPropagation();
      respondToPermission('allow');
    });
    handle.overlay.querySelector('.permission-popup-deny')!.addEventListener('click', (e) => {
      e.stopPropagation();
      respondToPermission('deny');
    });
  }

  // HS-8171 v2 — check out the live project terminal into the popup
  // body container. The checkout is synchronous: `checkout()` reparents
  // the live xterm element into `liveTermContainer` in the same JS
  // task as the popup mount, so there is no intermediate render of any
  // truncated preview. The container is already DOM-connected at this
  // point because `openPermissionDialogShell` did `document.body.appendChild`
  // synchronously above. After reparenting, we propose dimensions from
  // the rendered container and resize to fit so Claude's TUI redraws
  // for the popup geometry; on `release()` (popup close / dismiss /
  // respond) the previous owner re-takes the top of the stack and
  // gets its own dims back.
  if (useLiveCheckout && liveTermContainer !== null) {
    // HS-8182 — defensive: if a stale handle survives from a prior
    // popup (e.g. the polling loop's auto-dismiss path was never
    // exercised), release it before claiming a new one. The `checkout`
    // call itself bumps the previous owner down, but releasing the
    // stale handle first keeps `permissionState.activeCheckoutHandle` the single
    // source of truth for "the popup currently owning the live xterm".
    releaseActiveCheckoutIfAny();
    // HS-8207 — pass through the EXISTING entry's dims (when there is
    // one — drawer pane / dashboard tile already mounted) so the
    // checkout's swap-time `applyResizeIfChanged` is a no-op (no
    // SIGWINCH, no TUI redraw). Pre-fix the popup hardcoded
    // `cols: 100, rows: 30`, which fired one redraw at checkout, and
    // then the fit-retry below resized to popup-fit dims firing a
    // second redraw back-to-back. The user perceived the two
    // back-to-back claude TUI redraws as the "shows some content →
    // shows completely different content" multi-phase symptom.
    // Post-fix, only the fit-retry's resize causes a redraw — single
    // visible state change. When NO existing entry exists (popup is
    // first consumer of this terminal), default to (80, 24): a
    // sensible TUI baseline that's closer to popup-fit than (100, 30)
    // so the fit-retry's resize is small or no-op.
    const existingDims = peekEntryDims(secret, 'default');
    const startCols = existingDims?.cols ?? 80;
    const startRows = existingDims?.rows ?? 24;
    // HS-8295 — paint the §54 bumped-down placeholder with the project's
    // resolved theme bg so when the popup releases and the drawer/dashboard
    // tile briefly shows the placeholder mid-restore, the color matches.
    const popupAppearance = resolveAppearance({
      projectDefault: getProjectDefault(secret),
      sessionOverride: getSessionOverride('default'),
    });
    setActiveCheckout(checkout({
      projectSecret: secret,
      terminalId: 'default',
      cols: startCols,
      rows: startRows,
      mountInto: liveTermContainer,
      placeholderBackground: resolveAppearanceBackground(popupAppearance),
      // HS-8301 — embed the live terminal as read-only. The user can scroll
      // the buffer / select / copy, but typed keystrokes are NOT delivered
      // to the PTY while the popup is open. Prevents the user from
      // accidentally injecting characters into Claude's prompt while
      // they're answering the permission dialog. Reset to writable on
      // release() via the new-top's readOnly flag (drawer pane / tile
      // checkout do not pass readOnly).
      readOnly: true,
      // HS-8218 — never spawn a fresh PTY for the popup. Pre-fix when
      // the project's claude was running under a NON-`'default'`
      // terminal id (and `'default'` had no live session), the
      // popup's `attach` call on the server side spawned a brand-new
      // `claude --dangerously-load-development-channels` PTY which
      // stole the channel-server's MCP connection from the user's
      // actual claude session. Symptom (HS-8218 repro): popup briefly
      // shows blank → channel-approval prompt → fresh claude REPL →
      // permission popup auto-dismisses (because the original
      // claude's MCP request was orphaned). With `noSpawn: true` the
      // server returns `noSession: true` instead of spawning, and we
      // fall back to the flat / diff preview via the
      // `onNoLiveSession` callback below.
      noSpawn: true,
      onNoLiveSession: () => { fallbackToNonLivePreview(); },
    }));
    // HS-8206 v2 — `proposeDimensions()` returns undefined when xterm's
    // renderer hasn't measured cell dims for the new layout
    // (`renderService.dimensions.css.cell` is 0×0). Right after the term
    // reparents out of the offscreen 1×1 parking sink, the renderer
    // hasn't yet rendered a frame in the popup container, so cell dims
    // are 0. The HS-8206 v1 ResizeObserver fired once on initial observe
    // + bailed if dims were undefined; with a fixed-CSS-size popup
    // container no further size-change events ever fire, so the term
    // stayed at the initial 100×30 forever. Fix: kick a retry loop that
    // polls `proposeDimensions()` until it returns valid dims (cell
    // metrics measured) or we exhaust the retry budget. The
    // ResizeObserver still installs in case a window resize / DPR change
    // shifts the popup CSS layout mid-popup; same retry path runs from
    // the observer's callback. `pendingFit` coalesces overlapping fit
    // attempts; the proposed-vs-current short-circuit prevents the
    // well-known fit/observe feedback loop.
    disconnectActiveLiveTermResizeObserver();
    {
      const handle = getActiveCheckout();
      if (handle !== null) runLiveTermFitWithRetry(handle);
    }
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        const handle = getActiveCheckout();
        if (handle === null) return;
        runLiveTermFitWithRetry(handle);
      });
      observer.observe(liveTermContainer);
      setActiveLiveTermResizeObserver(observer);
    }
  }

  // Notify via Tauri attention.
  if (state.settings.notify_permission !== 'none') {
    requestAttention(state.settings.notify_permission);
  }

  // HS-7266: no outside-click handler. The popup is non-modal and only
  // closes via Allow / Deny / Minimize / No-response-needed / X.
}

// --- Test-only exports (HS-8183) -------------------------------------------

/** **TEST ONLY** — reset every module-level state slot back to its boot
 *  default so consecutive tests don't leak. Mirrors the convention in
 *  `terminalCheckout.tsx::_resetForTesting` + `bellPoll.ts::_resetDispatchStateForTesting`.
 *  Stops any in-flight polling loop too.
 *
 *  HS-8190 — runs disposers BEFORE assigning a fresh state so an in-flight
 *  resize observer or fit-retry timer doesn't leak past the swap. The
 *  collection-typed state (responded / dismissed / minimized / pending
 *  stack) is cleared explicitly because those are separate const Set/Map/
 *  Array containers, not part of the bundled state object. */
export function _resetStateForTesting(): void {
  _resetLiveCheckoutStateForTesting();
  respondedRequestIds.clear();
  dismissedRequestIds.clear();
  for (const rec of minimizedRequests.values()) clearTimeout(rec.timeoutId);
  minimizedRequests.clear();
  // HS-8320 — `pendingPermissions` + `minimizedSecrets` now live in
  // `channelStore`; clear them explicitly so consecutive tests don't
  // leak. Other channelStore fields (alive / busy / busySecrets / etc.)
  // are NOT touched here — they're outside this file's reset scope; a
  // test that depends on them should reset the channelStore directly.
  channelStore.actions.retainPendingPermissions(new Set<string>());
  channelStore.actions.setMinimizedSecrets(new Set<string>());
  setPermissionState(freshPermissionOverlayState());
}

/** **TEST ONLY** — read-only snapshot of the module-level bookkeeping for
 *  assertions. Returns a plain object so test code can spread / compare
 *  without holding live references. */
export function _inspectStateForTesting(): {
  activePopupRequestId: string | null;
  activePopupOwnerSecret: string | null;
  activeCheckoutHandle: boolean;
  activeLiveTermResizeObserver: boolean;
  respondedRequestIds: string[];
  dismissedRequestIds: string[];
  minimizedRequestIds: string[];
  /** HS-8219 — request_ids of permissions queued behind the active popup. */
  pendingPermissionStackIds: string[];
  permissionVersion: number;
  autoDismissMissCount: number;
} {
  const live = _inspectLiveCheckoutForTesting();
  return {
    activePopupRequestId: permissionState.activePopupRequestId,
    activePopupOwnerSecret: permissionState.activePopupOwnerSecret,
    activeCheckoutHandle: live.activeCheckoutHandle,
    activeLiveTermResizeObserver: live.activeLiveTermResizeObserver,
    respondedRequestIds: [...respondedRequestIds],
    dismissedRequestIds: [...dismissedRequestIds],
    minimizedRequestIds: [...minimizedRequests.keys()],
    pendingPermissionStackIds: channelStore.state.value.pendingPermissions.map(e => e.perm.request_id),
    permissionVersion: permissionState.permissionVersion,
    autoDismissMissCount: permissionState.autoDismissMissCount,
  };
}
