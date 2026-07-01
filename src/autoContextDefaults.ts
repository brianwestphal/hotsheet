// HS-9247 — built-in default auto-context text for the standard categories.
//
// Auto-context (`auto_context` setting) is per-category / per-tag preamble text
// prepended to each ticket in the worklist export (see `src/sync/markdown.ts`).
// Historically it defaulted to empty; these are sensible starting defaults so a
// fresh project gets useful guidance without the user having to write it.
//
// Applied as a READ-TIME fallback (never written to disk), exactly like
// `getCategories()` falls back to `DEFAULT_CATEGORIES`: the effective list is the
// defaults with the user's saved entries layered on top per `type:key`. A user
// entry always wins — including an explicit EMPTY-text entry, which suppresses
// the default (the injection skips empty text). The Settings → Context editor
// surfaces these as placeholders and pre-fills them on edit so users can
// customize from the default rather than retype it.

import type { AutoContextEntry } from './schemas.js';

/** Built-in default auto-context, keyed by category id. Covers the six software
 *  built-ins (`DEFAULT_CATEGORIES`) plus the design/creative preset categories.
 *  Categories without an entry here (product / marketing / personal specifics)
 *  ship with no default. All entries are `type: 'category'`. */
export const DEFAULT_AUTO_CONTEXT: AutoContextEntry[] = [
  {
    type: 'category',
    key: 'issue',
    text: 'Clarify the problem and its impact before acting. If it turns out to be a defect, add a test that guards against regressions; if it needs a larger change, file follow-up tickets for the work.',
  },
  {
    type: 'category',
    key: 'bug',
    text: 'Reproduce the bug first, then fix the root cause — not just the symptom. Add tests that would have caught it, covering BOTH the positive case (the fix behaves correctly) AND the negative / edge cases (bad input, error paths, boundaries) where applicable. Prefer both a unit test and an automated end-to-end test.',
  },
  {
    type: 'category',
    key: 'feature',
    text: 'Understand the existing architecture and conventions before implementing (read any overview / summary docs first). Add or update documentation for the new behavior. Add tests covering it. Ask clarifying questions if anything is ambiguous, and file follow-up tickets for anything left out of scope.',
  },
  {
    type: 'category',
    key: 'requirement_change',
    text: 'Update the requirements / spec docs to match the new behavior in the same change. New or updated tests may be required as well — add them where the behavior change warrants it. Ask clarifying questions if the desired behavior is ambiguous.',
  },
  {
    type: 'category',
    key: 'task',
    text: 'Make sure you understand the surrounding context before starting. Note anything left incomplete as a follow-up ticket.',
  },
  {
    type: 'category',
    key: 'investigation',
    text: "Investigate and write up your findings; recommend concrete next steps. Don't implement the change yet — file follow-up tickets for the work you'd propose.",
  },
  // Design / creative preset categories (docs: CATEGORY_PRESETS 'design').
  {
    type: 'category',
    key: 'concept',
    text: 'Explore multiple directions before converging. Align with the existing design language and brand. Include rationale for the chosen concept, and ask clarifying questions on ambiguous requirements.',
  },
  {
    type: 'category',
    key: 'revision',
    text: "Align with the existing design language and patterns. Address the specific requested changes; confirm you've understood the request before making them.",
  },
  {
    type: 'category',
    key: 'feedback',
    text: 'Make sure you understand the specific feedback and its intent before acting. Address each point, and ask clarifying questions if any point is ambiguous.',
  },
  {
    type: 'category',
    key: 'asset',
    text: 'Produce the asset to the required specs and formats. Follow the existing style and naming conventions; confirm dimensions / format before delivering.',
  },
  {
    type: 'category',
    key: 'research',
    text: "Investigate and write up your findings with concrete recommendations. Don't start production work yet — file follow-up tickets for the work you'd propose.",
  },
  // Marketing preset's design category id.
  {
    type: 'category',
    key: 'design',
    text: 'Align with the existing design language and brand before proposing changes. Include mockups and rationale, and ask clarifying questions on ambiguous requirements.',
  },
];

/** Stable identity for an auto-context entry (matches `file-settings` idOf). */
function idOf(e: AutoContextEntry): string {
  return `${e.type}:${e.key}`;
}

/** The built-in default text for a category id, or `null` if none ships. */
export function defaultAutoContextFor(categoryId: string): string | null {
  const found = DEFAULT_AUTO_CONTEXT.find((e) => e.type === 'category' && e.key === categoryId);
  return found ? found.text : null;
}

/**
 * Merge the user's saved auto-context entries over the built-in defaults, keyed
 * by `type:key`. User entries win (including an explicit empty-text entry, which
 * intentionally suppresses the default). Returns the effective list used for
 * worklist injection — defaults first (in their declared order), then any
 * user-only entries appended.
 */
export function resolveAutoContextWithDefaults(userEntries: AutoContextEntry[]): AutoContextEntry[] {
  const byKey = new Map<string, AutoContextEntry>();
  for (const d of DEFAULT_AUTO_CONTEXT) byKey.set(idOf(d), d);
  for (const u of userEntries) byKey.set(idOf(u), u);
  return [...byKey.values()];
}
