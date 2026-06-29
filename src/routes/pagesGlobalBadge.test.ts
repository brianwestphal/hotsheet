import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// HS-8450 — regression guard: every "this is a global setting" indicator
// in the server-rendered settings UI must use the same blue
// `.global-setting-badge` pill. The earlier code shipped two divergent
// styles (blue pill for CLI / Claude-channel rows, gray uppercase chip
// for the Diagnostics subsection) which looked like a design bug. This
// test pins the single canonical class so a future contributor can't
// reintroduce a parallel chip without tripping it.

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES_SRC = readFileSync(resolve(HERE, 'pages.tsx'), 'utf8');

describe('pages.tsx — global-setting badge style is unified (HS-8450)', () => {
  it('uses `global-setting-badge` for every "Global Setting" pill', () => {
    const matches = PAGES_SRC.match(/className="global-setting-badge"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it('does not reintroduce the gray `settings-scope-badge` chip', () => {
    // A bare substring match would trip on the historical-context
    // comment that documents the removal — assert the rendered
    // className specifically.
    expect(PAGES_SRC).not.toMatch(/className="[^"]*\bsettings-scope-badge\b[^"]*"/);
  });

  it('every `.global-setting-badge` span renders the label "Global Setting"', () => {
    const spans = PAGES_SRC.match(/<span className="global-setting-badge"[^>]*>([^<]*)<\/span>/g) ?? [];
    expect(spans.length).toBeGreaterThanOrEqual(3);
    for (const span of spans) {
      const label = span.replace(/^<span [^>]*>/, '').replace(/<\/span>$/, '').trim();
      expect(label).toBe('Global Setting');
    }
  });

  // HS-9199 — the "Experimental" badge (HS-9188, shell integration UI) is a
  // DISTINCT concept and uses its own `.experimental-badge` class, NOT
  // `.global-setting-badge` — so the invariant above stays valid and the two
  // badge types are visually/semantically separable.
  it('renders the "Experimental" badge via the distinct `.experimental-badge` class', () => {
    const spans = PAGES_SRC.match(/<span className="experimental-badge"[^>]*>([^<]*)<\/span>/g) ?? [];
    expect(spans.length).toBeGreaterThanOrEqual(1);
    for (const span of spans) {
      const label = span.replace(/^<span [^>]*>/, '').replace(/<\/span>$/, '').trim();
      expect(label).toBe('Experimental');
    }
  });
});
