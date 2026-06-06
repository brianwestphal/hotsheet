/**
 * HS-8781 — verbally announce permission checks (the "live should be more live"
 * permission half).
 *
 * When the global `announcerSpeakPermissions` preference is on (default), a new
 * permission popup is read aloud so you know what Claude is asking for while
 * you're away — independent of whether you're actively listening to a reel.
 *
 * **Arbitration (per the ticket's UX call):**
 *  - Never interrupt a narration segment that's already speaking. If the
 *    announcer PIP is mid-segment, the permission waits for the segment boundary
 *    (`AnnouncerPlayer.runAtNextBoundary`) and speaks BEFORE the next segment —
 *    pre-empting upcoming narration, not the current one.
 *  - If nothing is narrating (no PIP, or the player is idle/paused), speak now.
 *  - Skip a permission that's already been resolved (allowed/denied/dismissed)
 *    by the time its turn to speak arrives — no point announcing a closed gate.
 *
 * Uses its own `SpeechEngine` (the OS/browser voice) so it works with no PIP
 * open; coordination via the player guarantees the two never talk over each
 * other (the player isn't speaking during a boundary gap).
 */
import { getAnnouncerSpeakPermissions } from './announcerPermissionPref.js';
import { getActiveAnnouncerPlayer } from './announcerPip.js';
import { getAnnouncerSpeechRate } from './announcerSpeechRate.js';
import type { PermissionData } from './permissionOverlayHelpers.js';
import { dismissedRequestIds, respondedRequestIds } from './permissionPopupState.js';
import { createSpeechEngine, type SpeechEngine } from './tts.js';

/** Max spoken length before we trim the description to a short summary. */
const MAX_SPEECH_LEN = 160;

/**
 * The text spoken for a permission check (HS-8781). "Permission needed" + the
 * popup's human description, trimmed at a word boundary to a short summary when
 * it's long. Falls back to a tool-name sentence when there's no description.
 *
 * HS-8794 — when the owning project's name is known, it's named in the prefix
 * ("Permission needed in <project>: …") so that, listening away from the screen
 * with several projects registered, you hear *which* project Claude is asking
 * about. An empty/missing name falls back to the un-prefixed phrasing.
 *
 * Pure + exported for unit testing.
 */
export function permissionSpeechText(perm: PermissionData, projectName = '', maxLen = MAX_SPEECH_LEN): string {
  const desc = perm.description.trim();
  const base = desc === '' ? `Claude needs permission to use ${perm.tool_name}.` : desc;
  const summarized = base.length > maxLen
    ? base.slice(0, maxLen - 1).replace(/\s+\S*$/, '').trimEnd() + '…'
    : base;
  const name = projectName.trim();
  const prefix = name === '' ? 'Permission needed' : `Permission needed in ${name}`;
  return `${prefix}: ${summarized}`;
}

interface PlayerLike {
  runAtNextBoundary(task: () => void | Promise<void>): void;
}

interface QueueItem {
  text: string;
  isStale: () => boolean;
}

// --- Injectable seams (overridable in tests; default to the real wiring). ---
let engine: SpeechEngine | null = null;
let getPlayer: () => PlayerLike | null = getActiveAnnouncerPlayer;
let isEnabled: () => boolean = getAnnouncerSpeakPermissions;
let getRate: () => number = getAnnouncerSpeechRate;
let makeStalePredicate: (requestId: string) => () => boolean =
  (id) => () => respondedRequestIds.has(id) || dismissedRequestIds.has(id);

const queue: QueueItem[] = [];
const announced = new Set<string>();
let draining = false;
let scheduled = false;

/** Lazily build the voice engine. Returns null if it's unavailable or its
 *  construction throws — TTS must never break the permission popup. */
function ensureEngine(): SpeechEngine | null {
  if (engine === null) {
    try { engine = createSpeechEngine(); }
    catch { return null; }
  }
  return engine;
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    const eng = ensureEngine();
    if (eng === null || eng.backend === 'none') { queue.length = 0; return; }
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) break;
      if (item.isStale()) continue; // closed before we got to it — skip
      try { await eng.speak(item.text, getRate()); }
      catch { /* a TTS failure must not break the permission popup */ }
    }
  } finally {
    draining = false;
  }
}

function scheduleDrain(): void {
  if (scheduled || draining) return;
  scheduled = true;
  const run = (): void => { scheduled = false; void drain(); };
  const player = getPlayer();
  // `runAtNextBoundary` runs `run` immediately when nothing is speaking, or
  // defers it to the gap after the current segment otherwise.
  if (player !== null) player.runAtNextBoundary(run);
  else run();
}

/**
 * Queue a spoken announcement of a permission check. Gated on the global
 * preference; deduped per `request_id` (the popup can re-mount). Fire-and-forget.
 * `projectName` (HS-8794) is spoken so you hear which project is asking; pass ''
 * when it can't be resolved.
 */
export function announcePermission(perm: PermissionData, projectName = ''): void {
  if (!isEnabled()) return;
  if (announced.has(perm.request_id)) return;
  announced.add(perm.request_id);
  queue.push({ text: permissionSpeechText(perm, projectName), isStale: makeStalePredicate(perm.request_id) });
  scheduleDrain();
}

/** **TEST ONLY** — override the wiring (engine/player/pref/rate/staleness). */
export function _configureAnnouncerPermissionSpeechForTesting(deps: {
  engine?: SpeechEngine;
  getPlayer?: () => PlayerLike | null;
  isEnabled?: () => boolean;
  getRate?: () => number;
  makeStalePredicate?: (requestId: string) => () => boolean;
}): void {
  if (deps.engine !== undefined) engine = deps.engine;
  if (deps.getPlayer !== undefined) getPlayer = deps.getPlayer;
  if (deps.isEnabled !== undefined) isEnabled = deps.isEnabled;
  if (deps.getRate !== undefined) getRate = deps.getRate;
  if (deps.makeStalePredicate !== undefined) makeStalePredicate = deps.makeStalePredicate;
}

/** **TEST ONLY** — clear queue + dedup + restore real wiring. */
export function _resetAnnouncerPermissionSpeechForTesting(): void {
  queue.length = 0;
  announced.clear();
  draining = false;
  scheduled = false;
  engine = null;
  getPlayer = getActiveAnnouncerPlayer;
  isEnabled = getAnnouncerSpeakPermissions;
  getRate = getAnnouncerSpeechRate;
  makeStalePredicate = (id) => () => respondedRequestIds.has(id) || dismissedRequestIds.has(id);
}
