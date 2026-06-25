/**
 * HS-8993 — mTLS listener helpers. Pure host-selection + peer-identity reads,
 * plus a real in-process HTTPS server built from `buildMtlsServeConfig` that
 * accepts a CA-signed client cert (identity readable off the live socket) and
 * rejects a connection with no / foreign client cert.
 */
import { request as httpsRequest } from 'https';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory keychain so the CA round-trips without touching the OS keychain.
const store = new Map<string, string>();
vi.mock('../keychain.js', () => ({
  isKeychainAvailable: vi.fn(() => Promise.resolve(true)),
  keychainSet: vi.fn((p: string, a: string, v: string) => { store.set(`${p}/${a}`, v); return Promise.resolve(true); }),
  keychainGet: vi.fn((p: string, a: string) => Promise.resolve(store.get(`${p}/${a}`) ?? null)),
  keychainDelete: vi.fn((p: string, a: string) => { store.delete(`${p}/${a}`); return Promise.resolve(true); }),
}));

const { collectServerCertHosts, buildMtlsServeConfig, peerIdentityFromEnv, peerCertInfoFromRequest } = await import('./tlsListener.js');
const { loadOrCreateProjectCa, signClientCert } = await import('./ca.js');

describe('collectServerCertHosts', () => {
  it('includes a concrete bind + plain trustedOrigins + tlsServerHosts, deduped', () => {
    const hosts = collectServerCertHosts('10.0.0.5', ['hotsheet.example.com', '10.0.0.5'], ['vpn.local']);
    expect(hosts).toEqual(['10.0.0.5', 'hotsheet.example.com', 'vpn.local']);
  });

  it('skips a wildcard bind and non-host trustedOrigins (CIDR / origin URL / keyword)', () => {
    const hosts = collectServerCertHosts('0.0.0.0', ['tailscale', '192.168.0.0/16', 'https://app.example.com', 'box.lan'], []);
    expect(hosts).toEqual(['box.lan']);
    expect(collectServerCertHosts('::', [], [])).toEqual([]);
  });
});

describe('peerIdentityFromEnv', () => {
  it('returns null for absent env / a non-TLS socket', () => {
    expect(peerIdentityFromEnv(undefined)).toBeNull();
    expect(peerIdentityFromEnv({})).toBeNull();
    expect(peerIdentityFromEnv({ incoming: { socket: {} } })).toBeNull(); // no getPeerCertificate → plain TCP
  });

  it('reads the identity off a TLS-socket-shaped object', () => {
    const env = {
      incoming: {
        socket: {
          getPeerCertificate: () => ({ subject: { CN: 'My Device' }, subjectaltname: 'URI:hotsheet://client/dev-9' }),
        },
      },
    };
    expect(peerIdentityFromEnv(env)).toEqual({ clientId: 'dev-9', label: 'My Device' });
  });
});

describe('peerCertInfoFromRequest (HS-9025)', () => {
  it('returns null for a non-TLS socket', () => {
    expect(peerCertInfoFromRequest({ socket: {} } as never)).toBeNull();
  });

  it('reads clientId + cert expiry off a TLS-socket-shaped request', () => {
    const req = {
      socket: {
        getPeerCertificate: () => ({
          subject: { CN: 'Phone' },
          subjectaltname: 'URI:hotsheet://client/dev-42',
          valid_to: 'Jan  1 00:00:00 2099 GMT',
        }),
      },
    };
    expect(peerCertInfoFromRequest(req as never)).toEqual({
      clientId: 'dev-42',
      notAfterMs: Date.parse('Jan  1 00:00:00 2099 GMT'),
    });
  });

  it('uses Infinity when the cert has no parseable expiry', () => {
    const req = { socket: { getPeerCertificate: () => ({ subjectaltname: 'URI:hotsheet://client/x' }) } };
    expect(peerCertInfoFromRequest(req as never)?.notAfterMs).toBe(Infinity);
  });
});

describe('buildMtlsServeConfig', () => {
  beforeEach(() => store.clear());

  it('returns the HTTPS createServer + mTLS serverOptions (requestCert + rejectUnauthorized)', async () => {
    await loadOrCreateProjectCa('/proj/.hotsheet');
    const cfg = await buildMtlsServeConfig('/proj/.hotsheet', []);
    expect(typeof cfg.createServer).toBe('function');
    expect(cfg.serverOptions.requestCert).toBe(true);
    expect(cfg.serverOptions.rejectUnauthorized).toBe(true);
    expect(cfg.serverOptions.key).toContain('PRIVATE KEY');
    expect(cfg.serverOptions.cert).toContain('CERTIFICATE');
    expect(Array.isArray(cfg.serverOptions.ca)).toBe(true);
  });
});

describe('end-to-end mTLS listener', () => {
  beforeEach(() => store.clear());
  afterEach(() => store.clear());

  it('accepts a CA-signed client (identity readable) and rejects a no-cert / foreign client', async () => {
    const ca = await loadOrCreateProjectCa('/proj/.hotsheet');
    const cfg = await buildMtlsServeConfig('/proj/.hotsheet', []);
    const client = signClientCert(ca, { clientId: 'dev-1', label: 'Test Device' });

    let seenIdentity: { clientId: string; label: string } | null = null;
    const server = cfg.createServer(cfg.serverOptions, (req, res) => {
      seenIdentity = peerIdentityFromEnv({ incoming: req });
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    // Authorized client connects + the handler reads its identity.
    const body = await new Promise<string>((resolve, reject) => {
      const r = httpsRequest(
        { host: '127.0.0.1', port, method: 'GET', ca: [ca.caCertPem], cert: client.certPem, key: client.keyPem, servername: 'localhost' },
        (res) => { let d = ''; res.on('data', (chunk: Buffer) => { d += chunk.toString(); }); res.on('end', () => resolve(d)); },
      );
      r.on('error', reject);
      r.end();
    });
    expect(body).toBe('ok');
    expect(seenIdentity).toEqual({ clientId: 'dev-1', label: 'Test Device' });

    // No client cert → rejected at the TLS layer (client sees a connection error).
    await expect(new Promise<void>((resolve, reject) => {
      const r = httpsRequest(
        { host: '127.0.0.1', port, method: 'GET', ca: [ca.caCertPem], servername: 'localhost' },
        (res) => { res.on('data', () => { /* drain */ }); res.on('end', resolve); },
      );
      r.on('error', reject);
      r.end();
    })).rejects.toThrow();

    // Foreign-CA client cert → rejected.
    const foreignCa = await (async () => { store.clear(); return loadOrCreateProjectCa('/other/.hotsheet'); })();
    const foreign = signClientCert(foreignCa, { clientId: 'evil', label: 'Attacker' });
    await expect(new Promise<void>((resolve, reject) => {
      const r = httpsRequest(
        { host: '127.0.0.1', port, method: 'GET', ca: [ca.caCertPem], cert: foreign.certPem, key: foreign.keyPem, servername: 'localhost' },
        (res) => { res.on('data', () => { /* drain */ }); res.on('end', resolve); },
      );
      r.on('error', reject);
      r.end();
    })).rejects.toThrow();

    await new Promise<void>(resolve => server.close(() => resolve()));
  });
});
