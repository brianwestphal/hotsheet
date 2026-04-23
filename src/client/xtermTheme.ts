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
 */
export function readXtermTheme(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const getColor = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: getColor('--bg', '#ffffff'),
    foreground: getColor('--text', '#000000'),
    cursor: getColor('--accent', '#3b82f6'),
  };
}
