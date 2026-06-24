// HS-7940 — trusted-origin + bind helpers for opt-in non-localhost serving
// (docs/46-service-client-decoupling.md §46.5). Pure, dependency-free network
// primitives shared by the `/api/*` access middleware (`src/server.ts`), the
// access-decision helper (`src/routes/apiAccess.ts`), and the terminal/sync
// WebSocket auth audits. No I/O — every input is passed in.
//
// The trust model: localhost is ALWAYS trusted (today's single-machine
// default). Anything else is trusted only when the user opts in by listing it
// in `~/.hotsheet/config.json:trustedOrigins` — a host, IP, full origin URL,
// an IPv4 CIDR, or the keyword `tailscale` (= the 100.64.0.0/10 CGNAT block
// Tailscale hands out). This keeps the default deployment closed and makes
// remote exposure an explicit, auditable choice.

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** An IPv4 CIDR literal (`a.b.c.d/n`) — distinguishes a CIDR allow-list entry
 *  from a host or full origin URL (whose `//` would otherwise look like a `/`). */
const CIDR_RE = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;

/** Strip the `[...]` brackets a URL parser puts around an IPv6 literal. */
function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** Extract the hostname from a bare host, `host:port`, or a full origin/URL.
 *  Returns null when the value can't be parsed. */
function hostnameOf(value: string): string | null {
  const v = value.trim();
  if (v === '') return null;
  try {
    const url = v.includes('://') ? new URL(v) : new URL(`http://${v}`);
    return stripBrackets(url.hostname);
  } catch {
    return null;
  }
}

/** Parse an IPv4 dotted-quad into its four octets, or null if it isn't one. */
function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    octets.push(n);
  }
  return [octets[0], octets[1], octets[2], octets[3]];
}

function ipv4ToInt(o: [number, number, number, number]): number {
  return (o[0] * 0x1000000 + (o[1] << 16) + (o[2] << 8) + o[3]) >>> 0;
}

/** True when `host` (an IPv4 literal) falls inside the given `a.b.c.d/n` CIDR. */
export function ipv4InCidr(host: string, cidr: string): boolean {
  const [net, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const netO = parseIpv4(net);
  const hostO = parseIpv4(host);
  if (netO === null || hostO === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (bits === 32 ? 0xffffffff : ~((1 << (32 - bits)) - 1)) >>> 0;
  return ((ipv4ToInt(netO) & mask) >>> 0) === ((ipv4ToInt(hostO) & mask) >>> 0);
}

/** The RFC 6598 CGNAT block (100.64.0.0/10) Tailscale assigns to tailnet peers. */
export function isCgnatIpv4(host: string): boolean {
  return ipv4InCidr(host, '100.64.0.0/10');
}

/** localhost / 127.0.0.1 / ::1 — always trusted. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(stripBrackets(host).toLowerCase());
}

/** Is the given Origin/Referer value trusted, given the configured allow-list?
 *  `value` may be a full origin (`https://host:port`) or a bare host. */
export function isTrustedOrigin(value: string | undefined, trustedOrigins: string[]): boolean {
  if (value === undefined || value === '') return false;
  const host = hostnameOf(value);
  if (host === null) return false;
  const h = host.toLowerCase();
  if (isLoopbackHost(h)) return true;

  for (const raw of trustedOrigins) {
    const entry = raw.trim();
    if (entry === '') continue;
    // `tailscale` keyword → the CGNAT block. (`100.64.0.0/10` written out is
    // handled by the generic CIDR branch below.)
    if (entry.toLowerCase() === 'tailscale') {
      if (isCgnatIpv4(h)) return true;
      continue;
    }
    // An IPv4 CIDR (`a.b.c.d/n`) — matched precisely so a URL's `//` doesn't
    // get mistaken for a CIDR delimiter.
    if (CIDR_RE.test(entry)) {
      if (ipv4InCidr(h, entry)) return true;
      continue;
    }
    // Otherwise a host / IP / full origin URL — compare by hostname.
    const entryHost = hostnameOf(entry);
    if (entryHost !== null && entryHost.toLowerCase() === h) return true;
  }
  return false;
}

/** Convenience: trust the request if EITHER its Origin or Referer is trusted
 *  (mirrors the existing same-origin OR-check). */
export function isRequestTrusted(
  origin: string | undefined,
  referer: string | undefined,
  trustedOrigins: string[],
): boolean {
  return isTrustedOrigin(origin, trustedOrigins) || isTrustedOrigin(referer, trustedOrigins);
}

/** Is the server bound to a non-loopback address (i.e. reachable off-box)?
 *  Drives whether the GET-secret enforcement kicks in. `0.0.0.0`, `::`, and any
 *  specific LAN/tailnet IP are exposed; loopback / empty are not. */
export function isExposedBind(bind: string): boolean {
  const b = bind.trim().toLowerCase();
  return !(b === '' || b === '127.0.0.1' || b === 'localhost' || b === '::1');
}
