/**
 * HS-9538 — detect `morph()` calls that re-render to exactly what was already there.
 *
 * ## Why this exists
 *
 * kerf ships two diagnostics for this question — `valueOnlyRerender` and
 * `staleBinding` — and both are invoked from `mount.ts` only. `morph.ts` calls no
 * dev hook at all. Hot Sheet renders through `morph()` and never calls `mount()`,
 * so neither can fire here under any load (HS-9537, which spent a whole harness
 * discovering that the instrument was not wired to the thing it was measuring).
 *
 * This is the smallest thing that answers the question we actually have: for each
 * `morph()` target, did the incoming template match the previous one byte for
 * byte? If it did, the render function ran, produced a tree, serialized it, and
 * reconciled it against a DOM that already agreed — all of it wasted.
 *
 * ## What "wasted" does and does not mean here
 *
 * A redundant render is **not** a bug, and a nonzero count is not automatically
 * worth fixing. `morph` is cheap when nothing differs — that is the point of the
 * byte-equal fast path. What the count identifies is a *candidate* for conversion
 * to `bindText`/`bindAttr`: a site whose render runs constantly and changes
 * nothing is paying serialization for no reason. Treat this as a ranking signal,
 * not a defect list.
 *
 * ## Cost, and why it is opt-in
 *
 * Serializing the template to compare it is precisely the cost `morph` exists to
 * avoid, so this must never run in production. It is off unless
 * `enableMorphAudit()` is called, which only the dev entry does — the same shape
 * as kerf's own `kerfjs/dev` opt-in (docs/60), and for the same reason.
 */

/** Per-target counters. */
export interface MorphAuditEntry {
  /** Renders where the template was byte-identical to the previous one. */
  redundant: number;
  /** Total renders observed for this target. */
  total: number;
  /** A label for the target, for reporting. */
  label: string;
}

let enabled = false;

/** Last-seen serialized template per target. `WeakMap` so a removed element's
 *  entry is collectable — a long session must not accumulate detached nodes. */
const lastTemplate = new WeakMap<Element, string>();
/** Counters, keyed by the same label used in the report. Kept separately from the
 *  WeakMap because the report has to enumerate, and a WeakMap cannot. */
const counters = new Map<string, MorphAuditEntry>();

/**
 * Identify a morph target for reporting.
 *
 * Deliberately structural (tag + id + first class) rather than a unique handle:
 * the useful grouping is "this surface re-renders redundantly", and a per-node
 * identity would split one list's rows into hundreds of rows in the report.
 */
export function targetLabel(el: Element): string {
  const id = el.id === '' ? '' : `#${el.id}`;
  const cls = el.classList.length > 0 ? `.${el.classList[0]}` : '';
  return `${el.tagName.toLowerCase()}${id}${cls}`;
}

/**
 * Serialize a morph template for comparison.
 *
 * `morph` accepts an `Element`, a `SafeHtml`, or a string. All three have a
 * string form; normalizing to it is what makes the comparison meaningful across
 * call sites that build their trees differently.
 */
export function serializeTemplate(template: Element | { toString(): string } | string): string {
  if (typeof template === 'string') return template;
  if (template instanceof Element) return template.outerHTML;
  return String(template);
}

/**
 * Record one morph. Returns whether it was redundant, so callers (and tests) can
 * assert on a single call without reading the aggregate.
 */
export function recordMorph(liveRoot: Element, template: Element | { toString(): string } | string): boolean {
  if (!enabled) return false;
  const serialized = serializeTemplate(template);
  const previous = lastTemplate.get(liveRoot);
  const isRedundant = previous !== undefined && previous === serialized;
  lastTemplate.set(liveRoot, serialized);

  const label = targetLabel(liveRoot);
  const entry = counters.get(label) ?? { redundant: 0, total: 0, label };
  entry.total += 1;
  if (isRedundant) entry.redundant += 1;
  counters.set(label, entry);
  return isRedundant;
}

/** Turn auditing on. Called only from a dev entry — never from `app.tsx`. */
export function enableMorphAudit(): void {
  enabled = true;
}

export function isMorphAuditEnabled(): boolean {
  return enabled;
}

/** Every target seen, worst offenders first. */
export function morphAuditReport(): MorphAuditEntry[] {
  return [...counters.values()].sort((a, b) => b.redundant - a.redundant);
}

/** Drop all state. Exported for tests and for a "measure from here" reset. */
export function resetMorphAudit(): void {
  counters.clear();
  enabled = false;
}
