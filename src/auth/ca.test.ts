/**
 * HS-8992 — CA + cert lifecycle. Pure-crypto round-trips (cert chains validate,
 * identity round-trips, `.p12` re-imports) + an end-to-end Node `tls` mTLS
 * handshake using the generated certs (de-risks the sub-ticket-2 listener) +
 * keychain-backed persistence with an in-memory keychain stub.
 */
import { generateKeyPairSync } from 'crypto';
import type { AddressInfo } from 'net';
import forge from 'node-forge';
import * as tls from 'tls';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory keychain so no real OS keychain is touched. `available` flips the
// "keychain unavailable" failure path.
const store = new Map<string, string>();
let available = true;
vi.mock('../keychain.js', () => ({
  keychainSet: vi.fn((plugin: string, account: string, value: string) => {
    if (!available) return Promise.resolve(false);
    store.set(`${plugin}/${account}`, value);
    return Promise.resolve(true);
  }),
  keychainGet: vi.fn((plugin: string, account: string) =>
    Promise.resolve(available ? store.get(`${plugin}/${account}`) ?? null : null)),
  keychainDelete: vi.fn((plugin: string, account: string) => {
    store.delete(`${plugin}/${account}`);
    return Promise.resolve(true);
  }),
}));

const {
  generateCa, signServerCert, signClientCert, signClientCsr,
  exportClientP12, readP12, readIdentity, readIdentityFromPeerCertificate,
  verifyClientCert, projectCaId, loadProjectCa, loadOrCreateProjectCa, clearProjectCa,
} = await import('./ca.js');

/** A CSR signed by a fresh device keypair (the QR / import enrollment path). */
function makeCsr(cn = 'device'): string {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = forge.pki.publicKeyFromPem(publicKey);
  csr.setSubject([{ name: 'commonName', value: cn }]);
  csr.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());
  return forge.pki.certificationRequestToPem(csr);
}

// One CA shared across the pure-crypto tests (keygen is the slow part).
let ca: { caKeyPem: string; caCertPem: string };
beforeAll(() => { ca = generateCa(); });

describe('generateCa', () => {
  it('produces a self-signed CA cert with the CA basic constraint', () => {
    const cert = forge.pki.certificateFromPem(ca.caCertPem);
    // node-forge types `getField()` as `any`; pull `.value` through an unknown.
    const cn = (field: unknown): unknown =>
      field != null && typeof field === 'object' && 'value' in field ? (field as { value?: unknown }).value : undefined;
    expect(cn(cert.subject.getField('CN'))).toBe('Hot Sheet Project CA');
    // Self-signed: issuer === subject.
    expect(cn(cert.issuer.getField('CN'))).toBe('Hot Sheet Project CA');
    const bc = cert.getExtension('basicConstraints');
    expect(bc).toMatchObject({ cA: true });
    // The CA cert validates against itself.
    expect(verifyClientCert(ca.caCertPem, ca.caCertPem)).toBe(true);
  });

  it('each CA is distinct (random keypair + serial)', () => {
    const other = generateCa();
    expect(other.caKeyPem).not.toBe(ca.caKeyPem);
    expect(verifyClientCert(ca.caCertPem, other.caCertPem)).toBe(false);
  });
});

describe('signServerCert', () => {
  it('chains to the CA and carries loopback + configured-host SANs', () => {
    const { certPem, keyPem } = signServerCert(ca, { hosts: ['hotsheet.example.com', '10.0.0.5'] });
    expect(keyPem).toContain('PRIVATE KEY');
    expect(verifyClientCert(ca.caCertPem, certPem)).toBe(true);

    const cert = forge.pki.certificateFromPem(certPem);
    const san = cert.getExtension('subjectAltName') as { altNames: { type: number; value?: string; ip?: string }[] };
    const dnsNames = san.altNames.filter(a => a.type === 2).map(a => a.value);
    const ips = san.altNames.filter(a => a.type === 7).map(a => a.ip);
    expect(dnsNames).toContain('localhost');
    expect(dnsNames).toContain('hotsheet.example.com');
    expect(ips).toContain('127.0.0.1');
    expect(ips).toContain('10.0.0.5');
    // serverAuth EKU.
    expect(cert.getExtension('extKeyUsage')).toMatchObject({ serverAuth: true });
  });
});

describe('signClientCert / identity', () => {
  it('chains to the CA, sets clientAuth, and round-trips the identity', () => {
    const { certPem, keyPem } = signClientCert(ca, { clientId: 'dev-abc-123', label: "Brian's laptop" });
    expect(keyPem).toContain('PRIVATE KEY');
    expect(verifyClientCert(ca.caCertPem, certPem)).toBe(true);
    expect(forge.pki.certificateFromPem(certPem).getExtension('extKeyUsage')).toMatchObject({ clientAuth: true });

    expect(readIdentity(certPem)).toEqual({ clientId: 'dev-abc-123', label: "Brian's laptop" });
  });

  it('readIdentity returns null for a cert with no Hot Sheet client URI', () => {
    expect(readIdentity(ca.caCertPem)).toBeNull();
    expect(readIdentity('not a pem')).toBeNull();
  });
});

describe('signClientCsr', () => {
  it('signs a valid CSR with OUR identity (not the requester subject)', () => {
    const certPem = signClientCsr(ca, makeCsr('untrusted-cn'), { clientId: 'phone-9', label: 'iPhone' });
    expect(verifyClientCert(ca.caCertPem, certPem)).toBe(true);
    // The embedded identity is what the server chose, not the CSR's CN.
    expect(readIdentity(certPem)).toEqual({ clientId: 'phone-9', label: 'iPhone' });
  });

  it('rejects a malformed CSR', () => {
    expect(() => signClientCsr(ca, 'garbage', { clientId: 'x', label: 'y' })).toThrow();
  });

  it('rejects a CSR whose signature does not verify', () => {
    // Tamper: re-sign the body region so the self-signature is invalid.
    const good = makeCsr();
    const tampered = good.replace(/M/, 'N'); // flip a base64 char in the body
    expect(() => signClientCsr(ca, tampered, { clientId: 'x', label: 'y' })).toThrow();
  });
});

describe('exportClientP12 / readP12', () => {
  it('round-trips a client cert + key through a password-protected .p12', () => {
    const { certPem, keyPem } = signClientCert(ca, { clientId: 'dev-1', label: 'Desktop' });
    const p12 = exportClientP12({ certPem, keyPem, caCertPem: ca.caCertPem, password: 'hunter2' });
    expect(Buffer.isBuffer(p12)).toBe(true);
    expect(p12.length).toBeGreaterThan(0);

    const back = readP12(p12, 'hunter2');
    // The leaf cert re-imports and its identity is intact.
    expect(readIdentity(back.certPem)).toEqual({ clientId: 'dev-1', label: 'Desktop' });
    // The CA cert travels in the bundle.
    expect(back.caCertPems.length).toBe(1);
    expect(verifyClientCert(ca.caCertPem, back.certPem)).toBe(true);
    // The re-imported key matches the original (same modulus).
    expect(forge.pki.privateKeyToPem(forge.pki.privateKeyFromPem(back.keyPem)))
      .toBe(forge.pki.privateKeyToPem(forge.pki.privateKeyFromPem(keyPem)));
  });

  it('rejects the wrong password', () => {
    const { certPem, keyPem } = signClientCert(ca, { clientId: 'd', label: 'l' });
    const p12 = exportClientP12({ certPem, keyPem, caCertPem: ca.caCertPem, password: 'right' });
    expect(() => readP12(p12, 'wrong')).toThrow();
  });
});

describe('readIdentityFromPeerCertificate', () => {
  it('parses the SAN URI + CN from a Node getPeerCertificate-shaped object', () => {
    expect(readIdentityFromPeerCertificate({
      subject: { CN: 'My Laptop' },
      subjectaltname: 'URI:hotsheet://client/abc-123, DNS:localhost',
    })).toEqual({ clientId: 'abc-123', label: 'My Laptop' });
  });

  it('returns null when no Hot Sheet client URI is present', () => {
    expect(readIdentityFromPeerCertificate({ subject: { CN: 'x' }, subjectaltname: 'DNS:localhost' })).toBeNull();
    expect(readIdentityFromPeerCertificate({})).toBeNull();
  });
});

describe('end-to-end mTLS handshake (de-risks the sub-ticket-2 listener)', () => {
  it('a CA-signed client cert connects and its identity reads off the live socket; an unsigned client is rejected', async () => {
    const server = signServerCert(ca, { hosts: [] });
    const client = signClientCert(ca, { clientId: 'live-42', label: 'Live Device' });

    let peerIdentity: { clientId: string; label: string } | null = null;
    const srv = tls.createServer(
      {
        key: server.keyPem,
        cert: server.certPem,
        ca: [ca.caCertPem],
        requestCert: true,
        rejectUnauthorized: true,
      },
      (socket) => {
        peerIdentity = readIdentityFromPeerCertificate(socket.getPeerCertificate());
        socket.end('ok');
      },
    );
    await new Promise<void>(res => srv.listen(0, '127.0.0.1', res));
    const port = (srv.address() as AddressInfo).port;

    // Trusted client connects + completes the handshake.
    await new Promise<void>((res, rej) => {
      const sock = tls.connect(
        { host: '127.0.0.1', port, key: client.keyPem, cert: client.certPem, ca: [ca.caCertPem], servername: 'localhost' },
        () => { sock.on('data', () => { /* drain */ }); sock.on('end', () => { sock.end(); res(); }); },
      );
      sock.on('error', rej);
    });
    expect(peerIdentity).toEqual({ clientId: 'live-42', label: 'Live Device' });

    // A client with a foreign cert (different CA) is rejected by the server. In
    // TLS 1.3 `secureConnect` may fire before the post-handshake rejection, so
    // success is defined as actually completing the `ok` data exchange — which
    // an unauthorized client never does (the server resets → client errors).
    const foreignCa = generateCa();
    const foreign = signClientCert(foreignCa, { clientId: 'evil', label: 'Attacker' });
    await expect(new Promise<void>((res, rej) => {
      const sock = tls.connect(
        { host: '127.0.0.1', port, key: foreign.keyPem, cert: foreign.certPem, ca: [ca.caCertPem], servername: 'localhost' },
        () => {
          let got = '';
          sock.on('data', d => { got += d.toString(); });
          sock.on('end', () => {
            sock.end();
            if (got.includes('ok')) res();
            else rej(new Error('rejected: no data exchanged'));
          });
        },
      );
      sock.on('error', rej);
    })).rejects.toThrow();

    await new Promise<void>(res => srv.close(() => res()));
  });
});

describe('per-project persistence (keychain-backed)', () => {
  beforeEach(() => { store.clear(); available = true; });
  afterEach(() => { available = true; });

  it('projectCaId is stable per data dir and differs across dirs', () => {
    expect(projectCaId('/a/b/.hotsheet')).toBe(projectCaId('/a/b/.hotsheet'));
    expect(projectCaId('/a/b/.hotsheet')).not.toBe(projectCaId('/a/c/.hotsheet'));
    // Relative paths resolve to the same id as their absolute form.
    expect(projectCaId('.hotsheet')).toBe(projectCaId(`${process.cwd()}/.hotsheet`));
  });

  it('loadProjectCa returns null before generation', async () => {
    expect(await loadProjectCa('/proj/.hotsheet')).toBeNull();
  });

  it('loadOrCreateProjectCa generates + persists once, then loads the same CA', async () => {
    const first = await loadOrCreateProjectCa('/proj/.hotsheet');
    expect(first.caKeyPem).toContain('PRIVATE KEY');
    const second = await loadOrCreateProjectCa('/proj/.hotsheet');
    expect(second).toEqual(first); // loaded, not regenerated
    expect(await loadProjectCa('/proj/.hotsheet')).toEqual(first);
  });

  it('separate projects get separate CAs', async () => {
    const a = await loadOrCreateProjectCa('/proj-a/.hotsheet');
    const b = await loadOrCreateProjectCa('/proj-b/.hotsheet');
    expect(a.caKeyPem).not.toBe(b.caKeyPem);
  });

  it('clearProjectCa removes the persisted CA', async () => {
    await loadOrCreateProjectCa('/proj/.hotsheet');
    await clearProjectCa('/proj/.hotsheet');
    expect(await loadProjectCa('/proj/.hotsheet')).toBeNull();
  });

  it('throws (and rolls back) when the keychain cannot persist the CA', async () => {
    available = false;
    await expect(loadOrCreateProjectCa('/proj/.hotsheet')).rejects.toThrow(/keychain unavailable/i);
    available = true;
    expect(await loadProjectCa('/proj/.hotsheet')).toBeNull(); // no half-CA left behind
  });
});
