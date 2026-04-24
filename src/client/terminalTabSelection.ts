/**
 * Pick the terminal tab id to activate after one or more tabs have been closed.
 *
 * Given the tab-strip ordering before the close (left-to-right) and the set of
 * ids that were closed, return the id of the nearest surviving tab. The anchor
 * is the position of the first closed id in the snapshot — we walk rightward
 * from there looking for a surviving id, then leftward if no survivor is found
 * to the right. Returns `null` when no terminal tab survives the close, in
 * which case the caller should fall back to the commands-log tab (HS-7275).
 */
export function pickNearestTerminalTabId(
  orderBeforeClose: readonly string[],
  closedIds: readonly string[],
): string | null {
  if (closedIds.length === 0) return null;
  const closed = new Set(closedIds);

  const firstIdx = orderBeforeClose.findIndex(id => closed.has(id));
  if (firstIdx < 0) return null;

  for (let i = firstIdx + 1; i < orderBeforeClose.length; i++) {
    const id = orderBeforeClose[i];
    if (!closed.has(id)) return id;
  }
  for (let i = firstIdx - 1; i >= 0; i--) {
    const id = orderBeforeClose[i];
    if (!closed.has(id)) return id;
  }
  return null;
}
