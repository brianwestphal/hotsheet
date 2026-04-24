/**
 * Shared xterm theme — reads the app's CSS custom properties so xterm canvases
 * (drawer terminal, dashboard tiles, dashboard dedicated view) all pick up the
 * same background / foreground / cursor colors as the rest of the UI.
 *
 * HS-6866: the drawer terminal has always used `theme: readXtermTheme()` so it
 * picks up `--bg` (white in light mode, dark in dark mode). The dashboard
 * tiles and dedicated view used to instantiate xterm without a theme, which
 * left them on xterm's default black palette. Sharing this helper keeps all
 * xterm instances visually consistent.
 *
 * HS-7330: we also derive selectionBackground / selectionInactiveBackground
 * from --accent. xterm's default selection fill is a near-white translucent
 * colour; on the app's white `--bg` that's effectively invisible and users
 * reported "can't select text in terminals" even though the selection range
 * was being recorded correctly. Hard-coding a hex value with an alpha suffix
 * (8-digit hex: RRGGBBAA) keeps the fill semi-transparent over any background
 * without needing a colour-parsing dependency at runtime.
 */
export function readXtermTheme(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const getColor = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const accent = getColor('--accent', '#3b82f6');
  return {
    background: getColor('--bg', '#ffffff'),
    foreground: getColor('--text', '#000000'),
    cursor: accent,
    selectionBackground: withAlpha(accent, 0x66),
    selectionInactiveBackground: withAlpha(accent, 0x33),
  };
}

/** Append an 8-bit alpha to a hex colour (#rgb or #rrggbb). Non-hex inputs
 *  (rgb(), hsl(), named colours) pass through unchanged — callers fall back
 *  to a hard-coded blue above in that case via the selectionBackground
 *  branch, since xterm ignores unrecognised colour strings. */
export function withAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(255, Math.round(alpha)));
  const hex = a.toString(16).padStart(2, '0');
  if (/^#[0-9a-fA-F]{3}$/.test(color)) {
    const r = color[1];
    const g = color[2];
    const b = color[3];
    return `#${r}${r}${g}${g}${b}${b}${hex}`;
  }
  if (/^#[0-9a-fA-F]{6}$/.test(color)) {
    return `${color}${hex}`;
  }
  // Non-hex input — return a safe fallback that's visible on both light
  // and dark backgrounds (accent blue at the requested alpha).
  return `#3b82f6${hex}`;
}
