import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// HS-6799 regression: the Tauri production bundle shipped a `dist/client/styles.css`
// that was missing `@xterm/xterm/css/xterm.css`. The xterm stylesheet is what
// positions xterm's render layers absolutely and hides the IME helper textarea
// via `opacity: 0` — without it, a visible resizable <textarea> appeared inside
// the terminal pane and stray glyphs leaked out at the top of the pane.
//
// The bug was a split between `npm run build:client` (which cat'd xterm.css into
// styles.css) and `npm run build` / tsup (which didn't). `build-sidecar.sh` uses
// `npm run build`, so the Tauri resource bundle inherited the broken CSS.
//
// These tests guard against two regressions:
//   1. `@xterm/xterm` dropping the helper-textarea / viewport positioning rules.
//   2. Someone removing the xterm-css append step from the tsup client bundle
//      (or the `build:client` npm script).
describe('xterm stylesheet inclusion (HS-6799)', () => {
  const repoRoot = process.cwd();
  const xtermCssPath = join(repoRoot, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css');

  it('xterm source CSS contains the critical hide/position rules', () => {
    expect(existsSync(xtermCssPath)).toBe(true);
    const css = readFileSync(xtermCssPath, 'utf8');
    // The helper textarea MUST be hidden — otherwise it renders as a visible,
    // user-resizable box inside the terminal pane.
    expect(css).toMatch(/\.xterm-helper-textarea/);
    expect(css).toMatch(/opacity:\s*0/);
    // The viewport MUST be absolutely positioned — otherwise xterm's render
    // layers misalign and stray glyphs leak through.
    expect(css).toMatch(/\.xterm-viewport/);
    expect(css).toMatch(/position:\s*absolute/);
  });

  it('tsup.config.ts appends xterm.css to the client bundle stylesheet', () => {
    const cfg = readFileSync(join(repoRoot, 'tsup.config.ts'), 'utf8');
    // Must read the packaged xterm stylesheet and append it to the built CSS.
    // If someone removes this, the Tauri sidecar bundle breaks the terminal UI.
    expect(cfg).toContain('@xterm/xterm/css/xterm.css');
    expect(cfg).toMatch(/appendFileSync\s*\(\s*['"]dist\/client\/styles\.css['"]/);
  });

  it('package.json build:client script appends xterm.css', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const script = pkg.scripts['build:client'];
    expect(script).toBeDefined();
    expect(script).toContain('@xterm/xterm/css/xterm.css');
    expect(script).toContain('>> dist/client/styles.css');
  });

  it('if a built styles.css exists, it includes the xterm helper-textarea rule', () => {
    const builtCss = join(repoRoot, 'dist', 'client', 'styles.css');
    if (!existsSync(builtCss)) return; // Build not run in this environment — skip.
    const css = readFileSync(builtCss, 'utf8');
    expect(css).toMatch(/\.xterm-helper-textarea/);
    expect(css).toMatch(/opacity:\s*0/);
    expect(css).toMatch(/\.xterm-viewport/);
  });
});
