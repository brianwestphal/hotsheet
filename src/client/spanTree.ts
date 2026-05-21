/**
 * HS-8475 / §68.4 — pure tree-assembly helper that turns the flat
 * `SpanRow[]` returned by `getPromptTimeline` into a parent-child
 * tree the §68.5.1 drilldown renders as nested rows.
 *
 * No DOM, no side effects. Trivially unit-testable.
 *
 * Algorithm: single pass over the input rows building a
 * `Map<spanId, SpanTreeNode>`; second pass attaches each node to
 * its parent if the parent is in the map, otherwise treats it as a
 * root. Each level is sorted by `start_ts ASC` then `span_id` as a
 * stable tiebreaker.
 *
 * Roots are spans whose `parentSpanId` is `null` OR whose parent is
 * not in the input rows — the latter handles session-scoped parent
 * spans that live outside the prompt's span boundary gracefully
 * (per §68.4).
 */

import type { SpanRow } from '../db/otelQueries.js';

export interface SpanTreeNode {
  row: SpanRow;
  children: SpanTreeNode[];
  depth: number;
}

function compareByStartTs(a: SpanTreeNode, b: SpanTreeNode): number {
  if (a.row.startTs < b.row.startTs) return -1;
  if (a.row.startTs > b.row.startTs) return 1;
  if (a.row.spanId < b.row.spanId) return -1;
  if (a.row.spanId > b.row.spanId) return 1;
  return 0;
}

/**
 * HS-8476 / §68.5.1 — fold an event into the deepest span that
 * encloses its timestamp. Used by the drilldown renderer to nest
 * `claude_code.tool_result` / `claude_code.api_request` / etc.
 * events under the span they ran inside. When multiple spans
 * contain `eventTs`, the one with the latest `startTs` (= deepest /
 * most-specific) wins. Returns `null` when no span contains the
 * timestamp; the renderer floats such events to the top of the
 * body as orphan leaves.
 */
export function findEnclosingSpanId(eventTs: string, spans: SpanRow[]): string | null {
  const t = new Date(eventTs).getTime();
  let bestSpanId: string | null = null;
  let bestStart = -Infinity;
  for (const span of spans) {
    const start = new Date(span.startTs).getTime();
    const end = new Date(span.endTs).getTime();
    if (t >= start && t <= end && start > bestStart) {
      bestSpanId = span.spanId;
      bestStart = start;
    }
  }
  return bestSpanId;
}

export function assembleSpanTree(rows: SpanRow[]): SpanTreeNode[] {
  const byId = new Map<string, SpanTreeNode>();
  for (const row of rows) {
    byId.set(row.spanId, { row, children: [], depth: 0 });
  }

  const roots: SpanTreeNode[] = [];
  for (const node of byId.values()) {
    const parentId = node.row.parentSpanId;
    if (parentId !== null && byId.has(parentId)) {
      const parent = byId.get(parentId);
      if (parent !== undefined) {
        parent.children.push(node);
        continue;
      }
    }
    roots.push(node);
  }

  function sortAndDepth(node: SpanTreeNode, depth: number): void {
    node.depth = depth;
    node.children.sort(compareByStartTs);
    for (const child of node.children) sortAndDepth(child, depth + 1);
  }
  roots.sort(compareByStartTs);
  for (const root of roots) sortAndDepth(root, 0);

  return roots;
}
