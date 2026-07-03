// HS-9310 (docs/114 §114.4-114.6) — the PURE ACP → Hot Sheet mapping layer.
//
// These operate only on the ACP v1 protocol shapes (fixed, from
// agentclientprotocol.com) — NO `@zed-industries/agent-client-protocol` SDK, no
// spawned agent, no connection. That's deliberate: the SDK connection + agent
// spawn + the permission-overlay wiring are the spike-gated client (`src/acp/client.ts`,
// HS-8008), but the message → busy/done/permission mapping is spec-level logic the
// client will consume, and is unit-testable in isolation (docs/114 §114.10). Keeping
// it pure means the risky, real-agent-dependent parts stay small.

/** ACP `StopReason` (v1) — the value on a completed `session/prompt` result. */
export type AcpStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

/** ACP `session/update` notification kinds (v1) that stream during a turn. */
export const ACP_UPDATE_KINDS = [
  'plan',
  'agent_message_chunk',
  'tool_call',
  'tool_call_update',
  'usage_update',
] as const;

/** ACP `PermissionOptionKind` (v1). */
export type AcpPermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

/** One option the agent offers on a `session/request_permission` (v1). */
export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: string; // an AcpPermissionOptionKind, but tolerate unknown kinds from newer agents
}

/**
 * §114.6 — any `session/update` during a turn means the agent is working, so the
 * channel is BUSY. We only recognize the known update kinds (an unknown kind still
 * means activity, but we surface recognition so callers can log surprises). Returns
 * true whenever an update arrived (activity == busy); `known` reports whether the
 * kind is one we model.
 */
export function classifyUpdate(sessionUpdateKind: string): { busy: true; known: boolean } {
  return { busy: true, known: (ACP_UPDATE_KINDS as readonly string[]).includes(sessionUpdateKind) };
}

/**
 * §114.6 — a `stopReason` on the `session/prompt` result ends the turn: the channel
 * clears busy + signals done regardless of which reason. The classification is for
 * the UI/log (did it finish, get stopped, or error out?), mirroring how the Claude
 * channel distinguishes a clean done from a cancel.
 */
export function turnEndOutcome(stopReason: string): 'completed' | 'stopped' | 'error' {
  switch (stopReason) {
    case 'end_turn':
      return 'completed';
    case 'cancelled':
      return 'stopped';
    case 'max_tokens':
    case 'max_turn_requests':
    case 'refusal':
      return 'error';
    default:
      // An unrecognized terminal reason still ends the turn — treat as completed so
      // busy always clears (never leave the channel stuck busy on a new ACP reason).
      return 'completed';
  }
}

/**
 * §114.5 — the auto-allow gate mapping. Given the agent's offered `options` and a
 * decision to allow (`remember` = the `allow_always` vs `allow_once` distinction
 * that `permission_allow_rules` implies), return the `optionId` to reply with — the
 * exact-kind match first, then any `allow*` option, else null (no allow option
 * offered → the popup must be shown). This is what lets a matched allow-rule
 * auto-respond WITHOUT rendering the popup, exactly as the Claude channel does today.
 */
export function pickAllowOptionId(options: readonly AcpPermissionOption[], remember: boolean): string | null {
  const preferred: AcpPermissionOptionKind = remember ? 'allow_always' : 'allow_once';
  const exact = options.find(o => o.kind === preferred);
  if (exact !== undefined) return exact.optionId;
  const anyAllow = options.find(o => o.kind === 'allow_once' || o.kind === 'allow_always');
  return anyAllow?.optionId ?? null;
}

/**
 * §114.5 — the reject mapping (a matched deny-rule, or an explicit reject click).
 * Prefers `reject_once` (a proxy shouldn't silently remember a denial unless asked);
 * falls back to any `reject*`, else null.
 */
export function pickRejectOptionId(options: readonly AcpPermissionOption[], remember: boolean): string | null {
  const preferred: AcpPermissionOptionKind = remember ? 'reject_always' : 'reject_once';
  const exact = options.find(o => o.kind === preferred);
  if (exact !== undefined) return exact.optionId;
  const anyReject = options.find(o => o.kind === 'reject_once' || o.kind === 'reject_always');
  return anyReject?.optionId ?? null;
}
