// HS-9330 (docs/114 §114.5) — the shared, OPTION-DRIVEN permission model.
//
// The §47 permission overlay is being generalized (maintainer, 2026-07-12: "generalize
// the permissions support and don't worry about backwards compatibility — the current
// impl isn't great and is seldom used") so ONE overlay serves both drive transports:
//   - Claude / MCP-hooks (docs/12, docs/115): the decision is a binary `allow`/`deny`;
//     the overlay SYNTHESIZES the standard option triple (`standardClaudeOptions`) and
//     maps the chosen option's `kind` back to that wire (`optionKindToBehavior`).
//   - ACP (docs/114): the agent SUPPLIES its own `PermissionOption[]` (via
//     `session/request_permission`); the overlay renders them and returns the chosen
//     `optionId`, which `acpMapping.ts::pickAllow/RejectOptionId` also select by `kind`.
//
// This module is the shared vocabulary — pure (no DOM, no IO), so it's unit-testable in
// isolation and importable by both the client overlay and any server-side adapter. The
// `PermissionOption` shape mirrors `src/acp/acpMapping.ts::AcpPermissionOption` (same
// `{ optionId, name, kind }`) so an ACP request's options pass straight through.

/** ACP `PermissionOptionKind` (v1). `kind` is typed as a plain string on the option so
 *  an unknown kind from a newer agent still renders (it just won't auto-map). */
export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

/** One choice the overlay offers. Mirrors ACP's `AcpPermissionOption`. */
export interface PermissionOption {
  optionId: string;
  /** Button label. (ACP calls this `name`.) */
  name: string;
  /** An `PermissionOptionKind`, but tolerate unknown kinds from newer agents. */
  kind: string;
}

/** True when a kind grants the action (either allow variant). */
export function isAllowKind(kind: string): boolean {
  return kind === 'allow_once' || kind === 'allow_always';
}

/** True when a kind is a "remember my choice" variant (…_always). */
export function isRememberKind(kind: string): boolean {
  return kind === 'allow_always' || kind === 'reject_always';
}

/**
 * Map a chosen option's `kind` onto the legacy binary `behavior` the Claude/MCP-hooks
 * permission wire speaks (`src/routes/validation.ts::PermissionRespondSchema`). Any
 * allow variant → `allow`; anything else (reject variants + unknown) → `deny`
 * (fail-closed: an unrecognized kind never silently grants).
 */
export function optionKindToBehavior(kind: string): 'allow' | 'deny' {
  return isAllowKind(kind) ? 'allow' : 'deny';
}

/** The standard option triple the Claude/MCP-hooks path synthesizes so it shares the
 *  same option-driven overlay. `allow_always` corresponds to the "always allow this"
 *  affordance; `reject_once` to Deny. */
export function standardClaudeOptions(): PermissionOption[] {
  return [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
  ];
}

/** Look up an option by id, or null when absent. */
export function optionById(options: readonly PermissionOption[], optionId: string): PermissionOption | null {
  return options.find(o => o.optionId === optionId) ?? null;
}

/** The first allow option (preferring the exact remember-ness), or null when none is
 *  offered. Mirrors `acpMapping.ts::pickAllowOptionId` for the client side. */
export function firstAllowOption(options: readonly PermissionOption[], remember = false): PermissionOption | null {
  const preferred: PermissionOptionKind = remember ? 'allow_always' : 'allow_once';
  return options.find(o => o.kind === preferred) ?? options.find(o => isAllowKind(o.kind)) ?? null;
}

/** The first reject option (preferring reject_once), or null when none is offered. */
export function firstRejectOption(options: readonly PermissionOption[], remember = false): PermissionOption | null {
  const preferred: PermissionOptionKind = remember ? 'reject_always' : 'reject_once';
  return options.find(o => o.kind === preferred)
    ?? options.find(o => o.kind === 'reject_once' || o.kind === 'reject_always')
    ?? null;
}
