/**
 * Pure helpers for the OSC 7 shell-CWD tracking feature (HS-7262,
 * docs/29-osc7-cwd-tracking.md). Extracted from `terminal.tsx` so they can be
 * unit-tested without spinning up xterm.
 */

/**
 * Parse the payload of an OSC 7 sequence (`file://HOST/PATH`). Returns the
 * decoded filesystem path or null if the payload is not a valid file URL.
 *
 * Real-world emitters: starship, zsh `chpwd`, fish's interactive setup,
 * VS Code's / iTerm2's shell-integration rc files. All share the same
 * format — `file://` + hostname + `/` + percent-encoded path.
 *
 * Empty host (`file:///path`) is accepted. We don't validate the hostname
 * matches the local machine — a remote session (SSH into a VM) pushes the
 * remote hostname but the path may still resolve locally if the OS mounts
 * it; in practice the server-side existence check rejects unresolvable
 * paths on the "open" click, which is the right failure point.
 */
export function parseOsc7Payload(payload: string): string | null {
  if (typeof payload !== 'string' || payload === '') return null;
  const FILE_PREFIX = 'file://';
  if (!payload.startsWith(FILE_PREFIX)) return null;
  const rest = payload.slice(FILE_PREFIX.length);
  // First `/` after the host begins the path; empty host (`file:///`) puts
  // the `/` at index 0, which is fine — the path is everything from there.
  const pathStart = rest.indexOf('/');
  if (pathStart < 0) return null;
  const rawPath = rest.slice(pathStart);
  try {
    return decodeURIComponent(rawPath);
  } catch {
    // Malformed percent encoding — reject rather than surface garbled text.
    return null;
  }
}

/**
 * Compute a human-friendly display form of a CWD for the terminal toolbar
 * chip. Tildifies paths under the provided $HOME so `/Users/me/x` renders
 * as `~/x`, and truncates long paths to the last two segments when the full
 * string would overflow the chip (the full path is always available via the
 * chip's `title` attribute on hover).
 *
 * When `home` is null (unknown $HOME), no tildification happens.
 */
export function formatCwdLabel(cwd: string, home: string | null): string {
  let display = cwd;
  if (home !== null && home !== '' && (cwd === home || cwd.startsWith(home + '/'))) {
    display = '~' + cwd.slice(home.length);
  }
  const segs = display.split('/').filter(s => s !== '');
  if (display.length > 32 && segs.length > 2) {
    const tail = segs.slice(-2).join('/');
    return display.startsWith('~') ? `~/…/${tail}` : `…/${tail}`;
  }
  return display;
}
