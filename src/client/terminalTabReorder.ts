/**
 * HS-7827 — pure helpers for the drawer-terminal-tab drag-to-reorder flow.
 *
 * Drag-and-drop reorders the strip in the DOM immediately. The persisted
 * `terminals[]` array in `.hotsheet/settings.json` is a configured-only
 * subset of the strip — dynamic terminals (`dyn-*` ids) live in memory
 * only — so the helpers split the strip's full id order into the two
 * subsets, reorder the configured slice, and reassemble.
 *
 * Per the HS-7827 ticket: "the relative order should, for configured
 * terminals at least, be persisted across app launches". Dynamic-tab
 * relative position on the strip moves visually for the session but
 * isn't written back; on next reload, dynamic tabs follow the configured
 * tabs in the order the server returns them (typically registration
 * order).
 */

/** Reorder a flat list of ids by moving `fromId` to the position currently
 *  occupied by `toId`. Returns the new array. No-op when either id is
 *  missing or when from === to. Pure: no DOM, no network.
 *
 *  Semantics match the existing `terminalsSettings.tsx` row-drag flow:
 *  splice the moved id out of its current position and re-insert at the
 *  target's CURRENT index. This puts the moved id at the target's slot
 *  and shifts the target rightward (when dragging forward) or leftward
 *  (when dragging backward). Adjacent left-right swap behaves intuitively. */
export function reorderIds(currentOrder: readonly string[], fromId: string, toId: string): string[] {
  if (fromId === toId) return [...currentOrder];
  const fromIdx = currentOrder.indexOf(fromId);
  const toIdx = currentOrder.indexOf(toId);
  if (fromIdx === -1 || toIdx === -1) return [...currentOrder];
  const next = [...currentOrder];
  const [moved] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, moved);
  return next;
}

/**
 * Given the new full strip order (configured + dynamic ids interleaved)
 * AND the canonical configured-id list, return the reordered configured
 * subset to write back to `terminals[]` in settings. Configured ids
 * appear in the strip's order (relative to each other); ids that are in
 * the canonical list but missing from the strip are appended at the end
 * (defense in depth — should be impossible in practice since /terminal/list
 * authoritatively builds the strip from the same canonical list).
 */
export function configuredSubsetInStripOrder(
  stripOrder: readonly string[],
  canonicalConfiguredIds: readonly string[],
): string[] {
  const canonical = new Set(canonicalConfiguredIds);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of stripOrder) {
    if (canonical.has(id) && !seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  // Defense in depth: anything in canonical but missing from the strip
  // gets appended at the end (preserves the user's other configured
  // entries even if a transient strip rebuild dropped one).
  for (const id of canonicalConfiguredIds) {
    if (!seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  return out;
}

/**
 * Reorder a list of `TerminalConfig`-shaped objects by id list. Used after
 * `configuredSubsetInStripOrder` returns the new id order so the persisted
 * `terminals[]` array carries the full config objects in the new sequence.
 * Generic in the config shape so the caller's exact type passes through.
 */
export function reorderConfigsById<T extends { id: string }>(
  configs: readonly T[],
  idOrder: readonly string[],
): T[] {
  const byId = new Map<string, T>();
  for (const c of configs) byId.set(c.id, c);
  const out: T[] = [];
  const seen = new Set<string>();
  for (const id of idOrder) {
    const c = byId.get(id);
    if (c !== undefined && !seen.has(id)) {
      out.push(c);
      seen.add(id);
    }
  }
  // Append any configs whose id wasn't in the order list (shouldn't
  // happen if caller passed the strip-derived id order, but tolerate).
  for (const c of configs) {
    if (!seen.has(c.id)) {
      out.push(c);
      seen.add(c.id);
    }
  }
  return out;
}
