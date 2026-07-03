// HS-9303 (docs/112 §112.6) — parse + normalize a user-entered remote-server URL
// into a canonical origin (`https://host:port`). Pure + exhaustively testable; the
// "Add remote server" modal calls it on every keystroke to validate + on submit to
// persist. A remote Hot Sheet server is mTLS (https); we default a scheme-less
// entry to `https://` (the common case) but accept an explicit `http://` for a
// localhost/tunnel dev server.

export type NormalizeResult =
  | { ok: true; origin: string }
  | { ok: false; error: string };

/**
 * Normalize `input` to a canonical origin. Accepts `host:port`,
 * `https://host:port`, trailing slashes/paths (stripped), and mixed case host.
 * Rejects empty input, non-http(s) schemes, and anything `URL` can't parse.
 */
export function normalizeServerUrl(input: string): NormalizeResult {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, error: 'Enter a server URL.' };

  // Default a scheme-less entry to https (a remote server is mTLS).
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: 'That doesn’t look like a valid URL.' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: 'Use an https:// (or http:// for localhost) URL.' };
  }
  if (url.hostname === '') {
    return { ok: false, error: 'Missing a host.' };
  }
  // `url.origin` is the canonical `scheme://host[:port]` — no path, query, or
  // trailing slash, host already lowercased, default ports elided.
  return { ok: true, origin: url.origin };
}

/** True when `origin` points at the local machine (loopback) — an `http://`
 *  origin here is fine; a non-loopback `http://` origin is a likely mistake (a
 *  remote server should be mTLS/https). Used to nudge, not to block. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const h = new URL(origin).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
}
