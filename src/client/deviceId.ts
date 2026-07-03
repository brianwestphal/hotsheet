// HS-9191 (docs/109-multi-client-terminals.md §109.3/§109.6) — a stable
// per-browser/Tauri-instance device id for the active-device multi-client
// terminal model. On Tier-1 (mTLS) the server uses the cert `clientId` as the
// authoritative device id; on Tier-0 (localhost) there is no per-client
// identity, so the client mints a synthetic UUID once and persists it in
// `localStorage` (survives reload; distinct per browser profile / device).
//
// This is the id the client sends on the terminal WS handshake (`?device=`) and
// in the `claim-active` lease request. Small namespaced-key + try/catch module,
// matching the `settingsLastTab.ts` localStorage-helper pattern.

const KEY = 'hotsheet:deviceId';

let cached: string | null = null;

/** Mint a fresh UUID. Prefers `crypto.randomUUID()`; falls back to a
 *  timestamp-free random string for environments lacking it (older webviews,
 *  non-secure contexts) so we never throw. */
function mintId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch { /* fall through to the manual generator */ }
  // Fallback: 32 hex chars from crypto.getRandomValues, or Math.random as the
  // last resort. Uniqueness (not cryptographic quality) is all that's needed —
  // this id only distinguishes devices for the active-lease.
  const bytes = new Uint8Array(16);
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The stable device id for this browser/Tauri instance — read from
 *  `localStorage`, lazily minted + persisted on first use. Cached in-memory so
 *  repeat calls don't re-hit storage. */
export function getOrCreateDeviceId(): string {
  if (cached !== null) return cached;
  try {
    const existing = localStorage.getItem(KEY);
    if (existing !== null && existing !== '') {
      cached = existing;
      return existing;
    }
  } catch { /* storage unavailable — fall through to a per-session id */ }
  const minted = mintId();
  try { localStorage.setItem(KEY, minted); } catch { /* best-effort persistence */ }
  cached = minted;
  return minted;
}

/** TEST hook — drop the in-memory cache so a test that clears localStorage
 *  starts fresh. */
export function _resetDeviceIdCacheForTesting(): void {
  cached = null;
}
