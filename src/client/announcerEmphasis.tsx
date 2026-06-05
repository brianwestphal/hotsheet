/**
 * §78 Announcer (HS-8749, §78.5 tier 1 "text + emphasis") — render a spoken
 * script with its key phrase(s) visually emphasized.
 *
 * The summarizer (`summarize.ts`) returns, per entry, an optional `emphasis`
 * array of short phrases that are each a VERBATIM substring of the script. The
 * PIP renders those substrings wrapped in `<strong class="announcer-em">`; the
 * spoken text is unaffected (the player still narrates the plain `script`).
 *
 * Split out from `announcerPip.tsx` so the range math is unit-testable without
 * dragging in the PIP's client-only dependencies.
 */
import type { SafeHtml } from '../jsx-runtime.js';
import { toElement } from './dom.js';

/** Non-overlapping `[start, end)` ranges in `script` covered by any emphasis
 *  phrase. Phrases are matched case-sensitively at every occurrence (they're
 *  verbatim substrings), then sorted and merged so overlapping/adjacent hits
 *  render as one `<strong>`. */
export function emphasisRanges(script: string, phrases: readonly string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const phrase of phrases) {
    if (phrase === '') continue;
    let from = 0;
    for (;;) {
      const idx = script.indexOf(phrase, from);
      if (idx < 0) break;
      ranges.push([idx, idx + phrase.length]);
      from = idx + phrase.length;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged.length > 0 ? merged[merged.length - 1] : null;
    if (last !== null && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** Render `script` into `el`, wrapping each emphasized phrase in
 *  `<strong class="announcer-em">`. Falls back to plain `textContent` when
 *  there's no emphasis, so legacy/curated entries render exactly as before. */
export function renderScript(el: HTMLElement, script: string, emphasis: readonly string[]): void {
  const ranges = emphasisRanges(script, emphasis);
  if (ranges.length === 0) { el.textContent = script; return; }
  const children: Array<string | SafeHtml> = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) children.push(script.slice(cursor, start));
    children.push(<strong className="announcer-em">{script.slice(start, end)}</strong>);
    cursor = end;
  }
  if (cursor < script.length) children.push(script.slice(cursor));
  // Wrap in a single span so toElement gets one root element (a bare fragment
  // of mixed text/strong nodes isn't an Element); the span is transparent.
  el.replaceChildren(toElement(<span className="announcer-script-inner">{children}</span>));
}
