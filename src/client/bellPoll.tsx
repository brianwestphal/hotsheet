/**
 * Cross-project bell indicator long-poll (HS-6603 Phase 2, docs/24-cross-project-bell.md §24.4.1).
 *
 * The companion server endpoint is `GET /api/projects/bell-state?v=<version>`,
 * which mirrors `/api/projects/permissions`: it aggregates the per-terminal
 * `bellPending` flag for every registered project and returns in one of two
 * ways — immediately when the client's `v` cursor is already behind the
 * server's `bellVersion`, or after a short server-side timeout when no state
 * has changed. We just loop and hand the latest snapshot to every subscriber.
 *
 * Two kinds of subscribers:
 *   - The project-tab indicator (`updateProjectBellIndicators` in projectTabs.tsx).
 *     Rendered from scratch inside this module on every tick so a new tab that
 *     missed earlier ticks still picks up current state.
 *   - Arbitrary consumers registered via `subscribeToBellState`. HS-6640 uses
 *     this to keep the in-drawer per-terminal indicator in sync when bells
 *     arrive while the user is inside the same project.
 */
import { buildAllowRule } from '../shared/terminalPrompt/allowRules.js';
import type { MatchResult } from '../shared/terminalPrompt/parsers.js';
import { api, apiWithSecret } from './api.js';
import { updateProjectBellIndicators } from './projectTabs.js';
import { getActiveProject } from './state.js';
import { fireNativeNotification, isAppBackgrounded } from './tauriIntegration.js';
import { appendAllowRule } from './terminalPrompt/allowRulesStore.js';
import { openTerminalPromptOverlay } from './terminalPromptOverlay.js';
import { showToast } from './toast.js';

export interface BellStateEntry {
  anyTerminalPending: boolean;
  terminalIds: string[];
  /** HS-7264 — map of terminalId → OSC 9 message for terminals whose shell
   *  pushed `\x1b]9;<message>\x07`. Only populated for entries with a message;
   *  bell-only entries (plain `\x07`) are absent from this map even though
   *  their id is in `terminalIds`. */
  notifications?: Record<string, string>;
  /** HS-8034 Phase 2 — map of terminalId → MatchResult for terminals whose
   *  server-side scanner matched a prompt that wasn't auto-allowed. Empty
   *  object when no prompts pending. The client surfaces these via
   *  `dispatchPendingPrompts` (cross-project — opens the overlay anchored
   *  to the affected project's tab). */
  pendingPrompts?: Record<string, MatchResult>;
}

export type BellStateMap = Map<string, BellStateEntry>;

type Subscriber = (state: BellStateMap) => void;

const subscribers = new Set<Subscriber>();
let currentState: BellStateMap = new Map();
let active = false;
let version = 0;

/** Start the long-poll loop (idempotent). Called once from app.tsx boot. */
export function startBellPolling(): void {
  if (active) return;
  active = true;
  void loop();
}

/** Stop the loop — only used by tests / teardown. */
export function stopBellPolling(): void {
  active = false;
}

/** Latest known bell state. Useful for modules that need a one-shot read
 *  rather than subscribing (e.g., a newly-rendered tab strip). */
export function getBellState(): BellStateMap {
  return currentState;
}

/** Register a callback that runs on every poll tick with the latest state.
 *  Returns an unsubscribe function. Also fires immediately with the current
 *  snapshot so late subscribers don't miss the already-known state. */
export function subscribeToBellState(cb: Subscriber): () => void {
  subscribers.add(cb);
  cb(currentState);
  return () => { subscribers.delete(cb); };
}

interface BellStateResponse {
  bells: Record<string, BellStateEntry>;
  v: number;
}

async function loop(): Promise<void> {
  while (active) {
    try {
      const data = await api<BellStateResponse>(`/projects/bell-state?v=${version}`);
      version = data.v;
      currentState = toMap(data.bells);
      dispatchOsc9Toasts(currentState);
      // HS-8034 Phase 2 — surface server-side scanner matches as overlays
      // anchored to the affected project's tab. Cross-project: a prompt
      // can fire from a non-active project and the overlay still appears.
      dispatchPendingPrompts(currentState);
      updateProjectBellIndicators(currentState);
      for (const cb of subscribers) {
        try { cb(currentState); } catch { /* subscriber errors shouldn't kill the loop */ }
      }
    } catch {
      // Network hiccup / server restart — pause before retrying to match the
      // permissions-poll pattern. Keeps the browser quiet during real outages.
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

/**
 * HS-7264 — fire a transient toast for each NEW OSC 9 desktop-notification
 * payload that arrives in a tick. Dedupe key is `{secret}::{terminalId}::{message}`
 * so a static unchanging message doesn't re-toast every 3-second long-poll
 * cycle, but repeated-but-different messages from the same terminal DO surface
 * (build server emits successive "stage X done" updates).
 *
 * Scope for v1: active project only. Cross-project notifications still set
 * the project-tab bell glyph so the user knows which project wanted attention;
 * the message surfaces in a toast the moment they switch projects (via
 * `fireToastsForActiveProject()` below, invoked from loadAndRenderTerminalTabs
 * on the /terminal/list seed). Rationale: an OSC 9 fired from a background
 * project should not yank the user out of what they're doing with a toast
 * unless they've chosen to look at that project.
 */
const recentlyToasted = new Map<string, string>();

function dispatchOsc9Toasts(state: BellStateMap): void {
  const active = getActiveProject();
  if (active === null) return;
  const entry = state.get(active.secret);
  const notes = entry?.notifications ?? {};
  for (const [terminalId, message] of Object.entries(notes)) {
    maybeFireNotificationToast(active.secret, terminalId, message);
  }
  gcRecentlyToasted(state);
}

/** Called from `terminal.tsx` on /terminal/list seed (project switch / first
 *  drawer open / settings save) so OSC 9 messages set while the client was
 *  disconnected or viewing another project still surface on return. */
export function fireToastsForActiveProject(
  entries: Array<{ id: string; notificationMessage?: string | null }>,
): void {
  const active = getActiveProject();
  if (active === null) return;
  for (const e of entries) {
    const msg = e.notificationMessage;
    if (typeof msg !== 'string' || msg === '') continue;
    maybeFireNotificationToast(active.secret, e.id, msg);
  }
}

function maybeFireNotificationToast(secret: string, terminalId: string, message: string): void {
  const key = `${secret}::${terminalId}`;
  if (recentlyToasted.get(key) === message) return;
  recentlyToasted.set(key, message);
  // 6 s default — OSC 9 messages are user-readable ("Build done", "Tests passed",
  // "Deploy failed — see logs"), longer than the 3 s plugin-action toast.
  showToast(message, { durationMs: 6000 });
  // HS-7272 — also surface a native OS notification when the Hot Sheet window
  // is backgrounded (hidden tab or another app focused). The toast is enough
  // when the user is already looking at Hot Sheet; when they aren't, the toast
  // will auto-fade before they return and they'd never see it. In a browser
  // context `fireNativeNotification` silently resolves false — the toast
  // alone carries the message. Dedupe is shared with the toast via the
  // `recentlyToasted` check above so a build server emitting the same message
  // on every long-poll tick doesn't spam the Notification Center either.
  if (isAppBackgrounded()) {
    const projectName = getActiveProject()?.name ?? 'Hot Sheet';
    void fireNativeNotification(projectName, message);
  }
}

/** Drop dedupe entries for terminals whose OSC 9 was cleared (bell ack) so a
 *  subsequent notification with the same text fires a fresh toast. */
function gcRecentlyToasted(state: BellStateMap): void {
  for (const key of [...recentlyToasted.keys()]) {
    const sep = key.indexOf('::');
    if (sep < 0) { recentlyToasted.delete(key); continue; }
    const secret = key.slice(0, sep);
    const terminalId = key.slice(sep + 2);
    const entry = state.get(secret);
    const stillPending = entry?.notifications?.[terminalId] === recentlyToasted.get(key);
    if (!stillPending) recentlyToasted.delete(key);
  }
}

function toMap(obj: Record<string, BellStateEntry>): BellStateMap {
  const m: BellStateMap = new Map();
  for (const [secret, entry] of Object.entries(obj)) {
    m.set(secret, entry);
  }
  return m;
}

/**
 * HS-8034 Phase 2 — dispatch a `terminalPromptOverlay` for every fresh
 * server-side prompt match the long-poll surfaces. "Fresh" means the
 * `(secret, terminalId, signature)` triple wasn't dispatched by the
 * previous tick — repeated ticks of the same unanswered prompt don't
 * re-mount the overlay.
 *
 * The dispatcher runs cross-project: a prompt fired from a non-active
 * project still surfaces the overlay anchored below that project's tab
 * (HS-8012's `projectSecret` parameter routes the anchor). The user can
 * answer without first switching projects.
 *
 * Generic-shape matches don't auto-overlay (low confidence — would
 * interrupt other-project work for a possible false positive); they're
 * left in `pendingPrompts` for future per-project surfacing logic to
 * decide on (out of scope for v1; see HS-8034 docs).
 *
 * HS-8047 follow-up — overlays now serialize through `activeOverlayKey`.
 * Pre-fix, when multiple projects had pending prompts on the same tick
 * (e.g. on app launch with several `claude` instances all parked at the
 * same WARNING prompt), the dispatcher called `openTerminalPromptOverlay`
 * once per project in the same iteration. That helper REMOVES every
 * `.terminal-prompt-overlay` from the document before mounting the new
 * one (intentional — it uses the same DOM class for every overlay), so
 * each subsequent project's overlay obliterated the previous project's
 * overlay without going through `onClose`. The user saw popups flash by
 * one after another and only the final project's overlay survived; the
 * earlier overlays' signatures stayed in `lastDispatchedPromptSignatures`,
 * so they never re-surfaced in subsequent ticks. Cross-project
 * `permission-popup` handles this by holding `activePopupRequestId` and
 * skipping replacement until the active popup closes — we mirror that
 * pattern here.
 */
const lastDispatchedPromptSignatures = new Map<string, string>();
let activeOverlayKey: string | null = null;

/**
 * HS-8067 — minimized terminal-prompt overlays. Mirrors §47's
 * `permissionOverlay::minimizedRequests`. When the user clicks the
 * overlay's `Minimize` link, the overlay tears down its DOM but the
 * server-side pending entry stays alive (the project tab's bell dot
 * keeps showing); clicking the tab re-mounts the overlay via
 * `reopenMinimizedTerminalPromptForSecret`. Auto-dismiss after 2 minutes
 * so a forgotten minimized prompt doesn't linger forever — matches §47's
 * `MINIMIZED_TIMEOUT_MS`.
 */
type MinimizedTerminalPrompt = {
  secret: string;
  terminalId: string;
  match: MatchResult;
  sig: string;
  timeoutId: ReturnType<typeof setTimeout>;
};
const minimizedTerminalPrompts = new Map<string, MinimizedTerminalPrompt>();
const MINIMIZED_TIMEOUT_MS = 2 * 60 * 1000;

/** HS-8067 — keys (`${secret}::${terminalId}`) the user explicitly
 *  said "No response needed" for. Dispatcher skips re-firing the
 *  overlay for these even when the server-side pending entry is still
 *  alive (the long-poll bell-state still reports it). Cleared when the
 *  server clears the pending entry. */
const dismissedTerminalPromptKeys = new Set<string>();

/**
 * HS-8071 — short-TTL guard against a same-prompt re-fire after the
 * user just answered. The user reported clicking a Claude-numbered
 * choice, then seeing the "same" popup again moments later — except
 * the second popup's question hash had drifted (Claude's TUI status-
 * bar rendering, e.g. `▶▶ accept edits on (shift+tab to cycle)` /
 * `• high • /effort`, contaminated the captured question region) so
 * the existing exact-signature dedup in `lastDispatchedPromptSignatures`
 * didn't catch it. This guard captures the JUST-ANSWERED prompt's
 * `(parser_id, choice-labels)` shape with a wall-clock timestamp, and
 * the dispatcher skips any new candidate that matches the shape within
 * `RECENTLY_ANSWERED_TTL_MS`. Choice labels are normalised (trim +
 * lowercase) so trivial whitespace/case differences in re-detected
 * choices don't defeat the match. The TTL is short enough that a
 * legitimate follow-up prompt with the same shape (e.g. Claude asks
 * the SAME question again 5 s later) still surfaces — but long enough
 * that the post-response redraw window (≤ a few hundred ms in
 * practice) reliably falls inside it.
 */
const recentlyAnsweredPrompts = new Map<string, {
  parserId: string;
  choiceShape: string; // pipe-joined normalised choice labels
  answeredAtMs: number;
}>();
const RECENTLY_ANSWERED_TTL_MS = 3000;

function buildChoiceShape(match: MatchResult): string {
  if (match.shape === 'numbered') {
    return match.choices.map(c => c.label.trim().toLowerCase()).join('|');
  }
  if (match.shape === 'yesno') {
    return `yesno:${match.yesIsCapital ? 'Y' : 'y'}/${match.noIsCapital ? 'N' : 'n'}`;
  }
  return ''; // generic shape — can't dedup by choices
}

function dispatchPendingPrompts(state: BellStateMap): void {
  // Walk every project's pendingPrompts. Build the set of currently-live
  // (secret, terminalId) keys so we can prune entries from
  // `lastDispatchedPromptSignatures` for prompts the server cleared
  // (auto-allowed, responded to from another client, terminal restarted),
  // and collect the candidates that haven't been dispatched yet (or whose
  // signature changed since the last dispatch).
  const liveKeys = new Set<string>();
  const candidates: Array<{ secret: string; terminalId: string; match: MatchResult; key: string; sig: string }> = [];
  for (const [secret, entry] of state.entries()) {
    const prompts = entry.pendingPrompts ?? {};
    for (const [terminalId, match] of Object.entries(prompts)) {
      const key = `${secret}::${terminalId}`;
      liveKeys.add(key);
      // Generic-fallback matches NEVER auto-surface an overlay — too high
      // a false-positive risk to interrupt cross-project work with. The
      // user gets the prompt the next time they switch into that project
      // (a future tick will re-fire when the active-project gate matches).
      if (match.shape === 'generic') continue;
      const sig = match.signature;
      if (lastDispatchedPromptSignatures.get(key) === sig) continue;
      // HS-8071 — same-shape re-fire guard. If the user answered a
      // (parser_id, choice-labels)-equivalent prompt for this terminal
      // within the last `RECENTLY_ANSWERED_TTL_MS`, skip — a transient
      // post-response redraw can re-detect the same question with a
      // contaminated hash (Claude TUI status-bar bleed) and surface a
      // duplicate popup the user has effectively already answered.
      const recentlyAnswered = recentlyAnsweredPrompts.get(key);
      if (recentlyAnswered !== undefined) {
        if (Date.now() - recentlyAnswered.answeredAtMs >= RECENTLY_ANSWERED_TTL_MS) {
          recentlyAnsweredPrompts.delete(key);
        } else if (
          recentlyAnswered.parserId === match.parserId
          && recentlyAnswered.choiceShape === buildChoiceShape(match)
          && recentlyAnswered.choiceShape !== '' // never match generic shape
        ) {
          continue;
        }
      }
      // HS-8067 — user explicitly clicked "No response needed" for this
      // (secret, terminalId). Skip the overlay even though the server-
      // side pending entry is still alive. The dismissal is cleared when
      // the server clears its pending entry (the prune loop below).
      if (dismissedTerminalPromptKeys.has(key)) continue;
      // HS-8067 — currently minimized. Don't re-fire the overlay; the
      // user clicks the project tab to bring it back. The minimized
      // bookkeeping is cleared on tab-click-restore + auto-dismiss
      // timeout + server-clears-pending.
      if (minimizedTerminalPrompts.has(key)) continue;
      candidates.push({ secret, terminalId, match, key, sig });
    }
  }
  // Prune dispatched signatures whose pendingPrompt was cleared on the
  // server — so a fresh prompt with the same signature later (rare but
  // possible after a /restart) re-fires.
  for (const key of [...lastDispatchedPromptSignatures.keys()]) {
    if (!liveKeys.has(key)) lastDispatchedPromptSignatures.delete(key);
  }
  // HS-8067 — same prune for `dismissedTerminalPromptKeys` and
  // `minimizedTerminalPrompts` so a freshly-bellable prompt after a
  // /restart re-fires the overlay.
  for (const key of [...dismissedTerminalPromptKeys]) {
    if (!liveKeys.has(key)) dismissedTerminalPromptKeys.delete(key);
  }
  for (const [key, rec] of [...minimizedTerminalPrompts]) {
    if (!liveKeys.has(key)) {
      clearTimeout(rec.timeoutId);
      minimizedTerminalPrompts.delete(key);
    }
  }
  // If the active overlay's underlying server-side prompt was cleared
  // (user responded via the terminal directly, another client answered,
  // server auto-allowed), tear down the now-stale overlay so the next
  // pending prompt can take its place. Tearing the DOM element doesn't
  // route through `onClose`, so we also clear `activeOverlayKey` here.
  if (activeOverlayKey !== null && !liveKeys.has(activeOverlayKey)) {
    document.querySelectorAll('.terminal-prompt-overlay').forEach(el => el.remove());
    activeOverlayKey = null;
  }
  // Serialize: at most one overlay visible at a time. The next tick after
  // the active overlay closes (via send / cancel / dismiss / server clear)
  // picks up the next candidate. Sort by key so the surfacing order is
  // deterministic instead of hash-table-walk order.
  if (activeOverlayKey !== null) return;
  if (candidates.length === 0) return;
  candidates.sort((a, b) => a.key.localeCompare(b.key));
  const next = candidates[0];
  lastDispatchedPromptSignatures.set(next.key, next.sig);
  activeOverlayKey = next.key;
  openCrossProjectOverlay(next.secret, next.terminalId, next.match);
}

/** Test-only: reset all dispatcher state between cases. */
export function _resetDispatchStateForTesting(): void {
  lastDispatchedPromptSignatures.clear();
  activeOverlayKey = null;
  for (const rec of minimizedTerminalPrompts.values()) clearTimeout(rec.timeoutId);
  minimizedTerminalPrompts.clear();
  dismissedTerminalPromptKeys.clear();
  recentlyAnsweredPrompts.clear();
}

/** Test-only: peek the recently-answered bookkeeping. */
export function _recentlyAnsweredPromptsForTesting(): ReadonlyMap<string, { parserId: string; choiceShape: string; answeredAtMs: number }> {
  return new Map(recentlyAnsweredPrompts);
}

/** Test-only: stamp a recently-answered entry directly. Bypass `onSend`
 *  so unit tests can drive the dispatch-skip behaviour without spinning
 *  up the full overlay. */
export function _markRecentlyAnsweredForTesting(secret: string, terminalId: string, match: MatchResult, answeredAtMs: number): void {
  recentlyAnsweredPrompts.set(`${secret}::${terminalId}`, {
    parserId: match.parserId,
    choiceShape: buildChoiceShape(match),
    answeredAtMs,
  });
}

/** Test-only: peek the minimized-prompt bookkeeping for assertions. */
export function _minimizedTerminalPromptsForTesting(): ReadonlyMap<string, { secret: string; terminalId: string }> {
  const out = new Map<string, { secret: string; terminalId: string }>();
  for (const [k, v] of minimizedTerminalPrompts) out.set(k, { secret: v.secret, terminalId: v.terminalId });
  return out;
}

/** Test-only: peek the dismissed-prompt bookkeeping. */
export function _dismissedTerminalPromptKeysForTesting(): ReadonlySet<string> {
  return new Set(dismissedTerminalPromptKeys);
}

/** Test-only: peek the current `activeOverlayKey`. */
export function _activeOverlayKeyForTesting(): string | null {
  return activeOverlayKey;
}

/** Test-only: invoke the dispatcher directly without spinning up the loop. */
export function _dispatchPendingPromptsForTesting(state: BellStateMap): void {
  dispatchPendingPrompts(state);
}

/** HS-8034 Phase 2 — open the overlay for one (secret, terminalId, match)
 *  triple. Wires onSend → POST /terminal/prompt-respond, onClose → POST
 *  /terminal/prompt-dismiss, onAddAllowRule → appendAllowRule (writes to
 *  the affected project's settings.json so the next match auto-allows
 *  server-side). The auth header on each POST carries the affected
 *  project's secret via `apiWithSecret`. */
function openCrossProjectOverlay(secret: string, terminalId: string, match: MatchResult): void {
  const key = `${secret}::${terminalId}`;
  openTerminalPromptOverlay({
    match,
    projectSecret: secret,
    onSend(payload) {
      void apiWithSecret('/terminal/prompt-respond', secret, {
        method: 'POST',
        body: { terminalId, payload },
      }).catch(() => { /* network blip — overlay stays open via the false return */ });
      // HS-8071 — record the answered prompt's shape so the dispatcher
      // can skip any same-shape re-fire within the TTL window. Generic
      // matches set an empty `choiceShape` (which `buildChoiceShape`
      // produces for the `'generic'` case) so they don't gate any
      // future prompt — generic-shape detection is heuristic enough
      // that a wider suppression would be risky.
      recentlyAnsweredPrompts.set(key, {
        parserId: match.parserId,
        choiceShape: buildChoiceShape(match),
        answeredAtMs: Date.now(),
      });
      // We optimistically return true so the overlay closes immediately;
      // any real failure surfaces as a follow-up no-response. This
      // matches the prior client-detector behaviour (`onSend` was wired to
      // `ws.send()` which doesn't error-report either). The next long-
      // poll tick will re-surface the overlay if the server didn't
      // actually clear pendingPrompt.
      return true;
    },
    onClose() {
      // Drop the dispatched-signature so a follow-up identical prompt
      // (e.g. user dismissed and the program re-asks) re-surfaces.
      lastDispatchedPromptSignatures.delete(key);
      // HS-8047 follow-up — clear the serialization gate so the next
      // tick can surface the next queued cross-project prompt.
      if (activeOverlayKey === key) activeOverlayKey = null;
      void apiWithSecret('/terminal/prompt-dismiss', secret, {
        method: 'POST',
        body: { terminalId },
      }).catch(() => { /* swallow — overlay UI already closed */ });
    },
    onAddAllowRule(choiceIndex, choiceLabel) {
      try {
        const rule = buildAllowRule(match, choiceIndex, choiceLabel);
        // HS-8057: the prompt is from `secret` (which may not be the
        // active project — cross-project surfacing). The rule has to
        // persist into THAT project's settings.json so the server-side
        // scanner gate (`registry.ts::findMatchingRuleForProject`) finds
        // it on the next match. Pre-fix `appendAllowRule(rule)` routed
        // through `api()` which reads the active project's secret from
        // the global store; the rule was written to the wrong project's
        // settings and the next prompt re-surfaced. Pass `secret`
        // explicitly so the write hits the originating project.
        void appendAllowRule(rule, secret);
      } catch { /* generic shape would throw; we never pass the cb for generic */ }
    },
    onMinimize() {
      // HS-8067 — overlay closed via Minimize. Clear the active-overlay
      // gate so other projects' pending prompts can dispatch, but KEEP
      // the dispatched-signature so the dispatcher won't auto-re-fire
      // this same prompt while it's minimized. Track in
      // `minimizedTerminalPrompts` so a tab-click on this project's
      // tab re-mounts the overlay (mirrors §47's
      // `permissionOverlay::reopenMinimizedForSecret`). Auto-dismiss
      // after 2 minutes — same window as §47.
      if (activeOverlayKey === key) activeOverlayKey = null;
      const sig = match.signature;
      const timeoutId = setTimeout(() => {
        // 2-min timeout fired without the user coming back. Treat as
        // permanent dismissal: clear bookkeeping AND post the
        // server-side dismiss so the bell stops re-bringing this entry
        // back on the next chunk. Mirrors §47's auto-dismiss path.
        const rec = minimizedTerminalPrompts.get(key);
        if (rec === undefined) return;
        minimizedTerminalPrompts.delete(key);
        dismissedTerminalPromptKeys.add(key);
        lastDispatchedPromptSignatures.delete(key);
        void apiWithSecret('/terminal/prompt-dismiss', secret, {
          method: 'POST',
          body: { terminalId },
        }).catch(() => { /* swallow — bookkeeping already updated */ });
      }, MINIMIZED_TIMEOUT_MS);
      minimizedTerminalPrompts.set(key, { secret, terminalId, match, sig, timeoutId });
    },
    onNoResponseNeeded() {
      // HS-8067 — overlay closed via "No response needed". The user is
      // saying "I'll handle this in the terminal directly". Clear the
      // active-overlay gate AND post the server-side dismiss so the
      // server stops bell-ing on this same prompt. Add to
      // `dismissedTerminalPromptKeys` as belt-and-braces in case the
      // server's pending-clear races with the next dispatch tick.
      if (activeOverlayKey === key) activeOverlayKey = null;
      lastDispatchedPromptSignatures.delete(key);
      dismissedTerminalPromptKeys.add(key);
      void apiWithSecret('/terminal/prompt-dismiss', secret, {
        method: 'POST',
        body: { terminalId },
      }).catch(() => { /* swallow */ });
    },
  });
}

/**
 * HS-8067 — re-open a minimized terminal-prompt overlay for the given
 * project. Returns true if a popup was re-opened. Called from
 * `projectTabs.tsx` after a tab click, mirroring §47's
 * `reopenMinimizedForSecret`. When multiple terminals in the same
 * project have minimized prompts, the FIRST one we find is restored —
 * subsequent tab clicks restore the next.
 */
export function reopenMinimizedTerminalPromptForSecret(secret: string): boolean {
  for (const [key, rec] of minimizedTerminalPrompts) {
    if (rec.secret !== secret) continue;
    clearTimeout(rec.timeoutId);
    minimizedTerminalPrompts.delete(key);
    // Clear the dispatched-signature so the next dispatch tick can
    // re-mount via the standard path (which also restores the
    // active-overlay gate).
    lastDispatchedPromptSignatures.delete(key);
    openCrossProjectOverlay(rec.secret, rec.terminalId, rec.match);
    activeOverlayKey = key;
    lastDispatchedPromptSignatures.set(key, rec.sig);
    return true;
  }
  return false;
}
