/**
 * HS-8992 — CA + certificate lifecycle for the strong remote-auth (mTLS) epic
 * (HS-8985 / docs/94-strong-remote-auth.md §94.4 + §94.10). This is sub-ticket
 * 1 of 6: the foundation. **Pure crypto + keychain I/O — no wire change yet.**
 *
 * What lives here:
 *   - Generate/load a per-project self-signed **CA** (private key in the OS
 *     keychain, §20 / `keychain.ts`, namespaced per project by data dir).
 *   - Sign a **server cert** from the CA (SANs cover localhost + configured hosts).
 *   - Sign a **client cert** for an enrolled device — either by generating a
 *     keypair for it (the `.p12` enrollment path, sub-ticket 3) or by signing an
 *     externally-generated **CSR** (the QR / import paths).
 *   - Export a password-protected **`.p12`** (PKCS#12) bundle for a client.
 *   - Read a verified cert's **identity** (a stable client id + a human label).
 *   - Verify a client cert against the project CA.
 *
 * ## Library decision (made in this ticket, per §94.10 item 1)
 *
 * Node's built-in `crypto` / `node:tls` can generate keypairs and PARSE X.509
 * (`X509Certificate`), but it CANNOT build/sign a certificate from scratch,
 * generate or sign a CSR, or export PKCS#12 — the three things this module is
 * for. So a library is required. We use **`node-forge`** (`^1.3.1`):
 *   - Single, mature, widely-used pure-JS package that covers ALL of cert
 *     signing + CSR + PKCS#12 in one dependency (vs `@peculiar/x509`, which
 *     needs `@peculiar/asn1-pkcs12` + manual assembly for the `.p12` half).
 *   - Pure JS → bundles cleanly into the server tsup output (no native addon,
 *     no runtime-external juggling like node-pty/pglite).
 *   - Clean `npm audit` (no advisories against `node-forge@1.3.1` as of
 *     2026-06-24). Tracked in `docs/dependency-security.md`.
 *
 * We still use native `crypto.generateKeyPairSync` for the actual keygen (fast,
 * native) and hand the PEM to forge only for cert assembly/signing/PKCS#12.
 */
import { createHash,generateKeyPairSync, X509Certificate } from 'crypto';
import forge from 'node-forge';
import { isAbsolute, resolve } from 'path';

import { keychainDelete, keychainGet, keychainSet } from '../keychain.js';

// --- Types ---

/** A CA key + cert pair, both PEM-encoded. The `caKeyPem` is the secret. */
export interface CaBundle {
  caKeyPem: string;
  caCertPem: string;
}

/** A leaf cert + its private key, both PEM-encoded. */
export interface CertPair {
  certPem: string;
  keyPem: string;
}

/** The identity carried by a client cert: a stable machine id + a human label. */
export interface ClientIdentity {
  /** Stable, machine-generated device id (carried in a SAN URI). */
  clientId: string;
  /** Human-readable device label (carried in the subject CN). */
  label: string;
}

// --- Constants ---

/** Keychain plugin-id namespace the CA secrets live under (`com.hotsheet.plugin.auth`). */
const AUTH_KEYCHAIN_ID = 'auth';

/** SAN URI scheme used to carry the stable client id, e.g.
 *  `hotsheet://client/9f3c…`. Read back by `readIdentity*`. */
const CLIENT_URI_PREFIX = 'hotsheet://client/';

/** Default validity windows (days). CA outlives the certs it signs; clients
 *  re-enroll on rotation (sub-ticket 4 adds revocation for early kill). */
const DEFAULT_CA_DAYS = 3650; // ~10 years
const DEFAULT_SERVER_DAYS = 825; // ~27 months (under the 825-day TLS-server max)
const DEFAULT_CLIENT_DAYS = 365; // 1 year

// node-forge SAN `type` codes (GeneralName tags).
const SAN_DNS = 2;
const SAN_URI = 6;
const SAN_IP = 7;

// ---------------------------------------------------------------------------
// Pure crypto helpers
// ---------------------------------------------------------------------------

/** Generate an RSA-2048 keypair via native `crypto`, returned as PKCS#1 PEM
 *  (the format `node-forge` parses without ambiguity). */
function newKeyPairPem(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  return { privatePem: privateKey, publicPem: publicKey };
}

/** A positive, ~20-byte random serial as hex. The leading `00` byte keeps the
 *  ASN.1 INTEGER positive (a high bit would make it negative). */
function randomSerialHex(): string {
  return '00' + forge.util.bytesToHex(forge.random.getBytesSync(19));
}

function notBeforeNow(): Date {
  // Backdate 5 minutes to tolerate minor clock skew between peers.
  const d = new Date();
  d.setMinutes(d.getMinutes() - 5);
  return d;
}

function notAfterInDays(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

/** Build the SAN `altNames` list for a server cert from a host list. Always
 *  includes loopback (localhost / 127.0.0.1 / ::1); each configured host is
 *  classified as an IP (literal) or a DNS name. */
function serverAltNames(hosts: string[]): forge.pki.CertificateField[] {
  const altNames: { type: number; value?: string; ip?: string }[] = [
    { type: SAN_DNS, value: 'localhost' },
    { type: SAN_IP, ip: '127.0.0.1' },
    { type: SAN_IP, ip: '::1' },
  ];
  for (const host of hosts) {
    const h = host.trim();
    if (h === '' || h === 'localhost' || h === '127.0.0.1' || h === '::1') continue;
    if (isIpLiteral(h)) altNames.push({ type: SAN_IP, ip: h });
    else altNames.push({ type: SAN_DNS, value: h });
  }
  // node-forge's extension shape is loosely typed; the runtime contract is the
  // `{ name: 'subjectAltName', altNames }` object below.
  return altNames as unknown as forge.pki.CertificateField[];
}

function isIpLiteral(host: string): boolean {
  // IPv4 dotted-quad or anything containing a colon (IPv6).
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/**
 * Generate a fresh self-signed CA. Pure — no I/O. The returned `caKeyPem` is the
 * project root secret; persist it in the keychain (see `loadOrCreateProjectCa`).
 */
export function generateCa(opts?: { commonName?: string; validityDays?: number }): CaBundle {
  const { privatePem, publicPem } = newKeyPairPem();
  const privateKey = forge.pki.privateKeyFromPem(privatePem);
  const publicKey = forge.pki.publicKeyFromPem(publicPem);

  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = randomSerialHex();
  cert.validity.notBefore = notBeforeNow();
  cert.validity.notAfter = notAfterInDays(opts?.validityDays ?? DEFAULT_CA_DAYS);

  const attrs = [{ name: 'commonName', value: opts?.commonName ?? 'Hot Sheet Project CA' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // self-signed: issuer === subject
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
  ]);
  cert.sign(privateKey, forge.md.sha256.create());

  return { caKeyPem: privatePem, caCertPem: forge.pki.certificateToPem(cert) };
}

/**
 * Sign a server cert from the CA. SANs always cover loopback; `hosts` adds the
 * configured bind address/hostname(s) so the exposed (Tier-1) listener presents
 * a matching cert.
 */
export function signServerCert(ca: CaBundle, opts?: { hosts?: string[]; commonName?: string; validityDays?: number }): CertPair {
  const { privatePem, publicPem } = newKeyPairPem();
  const caKey = forge.pki.privateKeyFromPem(ca.caKeyPem);
  const caCert = forge.pki.certificateFromPem(ca.caCertPem);

  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicPem);
  cert.serialNumber = randomSerialHex();
  cert.validity.notBefore = notBeforeNow();
  cert.validity.notAfter = notAfterInDays(opts?.validityDays ?? DEFAULT_SERVER_DAYS);
  cert.setSubject([{ name: 'commonName', value: opts?.commonName ?? 'localhost' }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: serverAltNames(opts?.hosts ?? []) },
  ]);
  cert.sign(caKey, forge.md.sha256.create());

  return { certPem: forge.pki.certificateToPem(cert), keyPem: privatePem };
}

/** Shared extension set + subject for a client (leaf) cert carrying an identity. */
function buildClientCert(
  caCert: forge.pki.Certificate,
  publicKey: forge.pki.PublicKey,
  identity: ClientIdentity,
  validityDays: number,
): forge.pki.Certificate {
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = randomSerialHex();
  cert.validity.notBefore = notBeforeNow();
  cert.validity.notAfter = notAfterInDays(validityDays);
  // CN = human label; the stable id rides in a SAN URI (read back by readIdentity).
  cert.setSubject([{ name: 'commonName', value: identity.label }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', clientAuth: true },
    {
      name: 'subjectAltName',
      altNames: [{ type: SAN_URI, value: CLIENT_URI_PREFIX + identity.clientId }],
    },
  ]);
  return cert;
}

/**
 * Sign a client cert for an enrolled device, generating the keypair here. Used
 * by the `.p12` enrollment path (sub-ticket 3) where Hot Sheet mints both halves.
 * Returns the cert AND the private key.
 */
export function signClientCert(ca: CaBundle, identity: ClientIdentity, opts?: { validityDays?: number }): CertPair {
  const { privatePem, publicPem } = newKeyPairPem();
  const caKey = forge.pki.privateKeyFromPem(ca.caKeyPem);
  const caCert = forge.pki.certificateFromPem(ca.caCertPem);
  const cert = buildClientCert(caCert, forge.pki.publicKeyFromPem(publicPem), identity, opts?.validityDays ?? DEFAULT_CLIENT_DAYS);
  cert.sign(caKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: privatePem };
}

/**
 * Sign a client cert from an externally-generated **CSR** (the device keeps its
 * own private key — never sent to the server). Used by the QR-pairing + import
 * enrollment paths (sub-tickets 3 + 5). Returns the cert PEM only.
 *
 * Throws if the CSR is malformed or its self-signature doesn't verify.
 */
export function signClientCsr(ca: CaBundle, csrPem: string, identity: ClientIdentity, opts?: { validityDays?: number }): string {
  const csr = forge.pki.certificationRequestFromPem(csrPem);
  if (csr.publicKey == null || !csr.verify()) {
    throw new Error('CSR signature verification failed');
  }
  const caKey = forge.pki.privateKeyFromPem(ca.caKeyPem);
  const caCert = forge.pki.certificateFromPem(ca.caCertPem);
  // Use the CSR's public key but OUR identity attributes — the server, not the
  // requester, decides the embedded client id + label.
  const cert = buildClientCert(caCert, csr.publicKey, identity, opts?.validityDays ?? DEFAULT_CLIENT_DAYS);
  cert.sign(caKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}

/**
 * Export a password-protected PKCS#12 (`.p12`) bundle containing a client cert,
 * its private key, and the CA cert (so the bundle is self-contained for import).
 * Binary `Buffer` ready to write to disk / hand to a Tauri save-file command.
 */
export function exportClientP12(args: {
  certPem: string;
  keyPem: string;
  caCertPem: string;
  password: string;
  friendlyName?: string;
}): Buffer {
  const key = forge.pki.privateKeyFromPem(args.keyPem);
  const cert = forge.pki.certificateFromPem(args.certPem);
  const caCert = forge.pki.certificateFromPem(args.caCertPem);
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(key, [cert, caCert], args.password, {
    friendlyName: args.friendlyName ?? 'Hot Sheet Client',
    algorithm: '3des',
  });
  const der = forge.asn1.toDer(p12Asn1).getBytes();
  return Buffer.from(der, 'binary');
}

/**
 * Read a `.p12` back into PEMs (the test round-trip + the import path). Returns
 * the leaf cert + key + any CA certs in the bundle. Throws on a wrong password
 * or malformed bundle.
 */
export function readP12(p12: Buffer, password: string): { certPem: string; keyPem: string; caCertPems: string[] } {
  const asn1 = forge.asn1.fromDer(forge.util.createBuffer(p12.toString('binary')));
  const parsed = forge.pkcs12.pkcs12FromAsn1(asn1, password);

  const keyBags = parsed.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const keyBag = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0];
  if (keyBag?.key == null) throw new Error('PKCS#12 bundle has no private key');

  const certBags = parsed.getBags({ bagType: forge.pki.oids.certBag });
  const certs = certBags[forge.pki.oids.certBag] ?? [];
  const certPems: string[] = [];
  let leafPem: string | null = null;
  for (const bag of certs) {
    if (bag.cert == null) continue;
    const pem = forge.pki.certificateToPem(bag.cert);
    const isCa = bag.cert.getExtension('basicConstraints');
    if (isCa != null && hasCaFlag(isCa)) certPems.push(pem);
    else leafPem = leafPem ?? pem;
  }
  if (leafPem == null) throw new Error('PKCS#12 bundle has no client certificate');

  return {
    keyPem: forge.pki.privateKeyToPem(keyBag.key),
    certPem: leafPem,
    caCertPems: certPems,
  };
}

function hasCaFlag(ext: object): boolean {
  return 'cA' in ext && ext.cA === true;
}

/** Cert metadata the enrolled-device registry stores for later revocation +
 *  expiry display (HS-8994). `serial` + `fingerprint` are the two stable keys a
 *  revocation check (sub-ticket 4 / HS-8995) can match a connecting cert on. */
export interface CertMeta {
  serial: string;
  fingerprint: string;
  notAfter: string;
  identity: ClientIdentity | null;
}

/**
 * Read serial / SHA-256 fingerprint / expiry / identity from a cert PEM, via
 * Node's native `X509Certificate` (parses + exposes these directly). Returns
 * null on a malformed PEM.
 */
export function readCertMeta(certPem: string): CertMeta | null {
  try {
    const x = new X509Certificate(certPem);
    return {
      serial: x.serialNumber,
      fingerprint: x.fingerprint256,
      notAfter: new Date(x.validTo).toISOString(),
      identity: readIdentity(certPem),
    };
  } catch {
    return null;
  }
}

/**
 * Read the identity (client id + label) out of a client cert PEM. The stable id
 * comes from the SAN URI; the label from the subject CN. Returns null if the
 * cert carries no Hot Sheet client URI.
 */
export function readIdentity(certPem: string): ClientIdentity | null {
  let cert: forge.pki.Certificate;
  try {
    cert = forge.pki.certificateFromPem(certPem);
  } catch {
    return null;
  }
  const san: unknown = cert.getExtension('subjectAltName');
  const clientId = extractClientUri(san);
  if (clientId == null) return null;
  // node-forge types `getField()` as `any`; narrow its `.value` to a string.
  const cn = cert.subject.getField('CN') as { value?: unknown } | null;
  return { clientId, label: typeof cn?.value === 'string' ? cn.value : '' };
}

function extractClientUri(san: unknown): string | null {
  if (san == null || typeof san !== 'object' || !('altNames' in san)) return null;
  const altNames: unknown = (san as { altNames?: unknown }).altNames;
  if (!Array.isArray(altNames)) return null;
  // node-forge's altNames entries are typed `any`; treat each as unknown + narrow.
  for (const entry of altNames as unknown[]) {
    if (entry == null || typeof entry !== 'object') continue;
    const e = entry as { type?: unknown; value?: unknown };
    if (e.type === SAN_URI && typeof e.value === 'string' && e.value.startsWith(CLIENT_URI_PREFIX)) {
      return e.value.slice(CLIENT_URI_PREFIX.length);
    }
  }
  return null;
}

/**
 * Read the identity from a Node TLS peer-certificate object (what the mTLS
 * listener in sub-ticket 2 gets from `socket.getPeerCertificate()`). The SAN URI
 * lands in `subjectaltname` as a comma-separated string like
 * `"URI:hotsheet://client/abc, DNS:..."`; the label is `subject.CN`.
 */
export function readIdentityFromPeerCertificate(peer: {
  // Node's `getPeerCertificate()` types each DN field as `string | string[]`.
  subject?: { CN?: string | string[] };
  subjectaltname?: string;
}): ClientIdentity | null {
  const san = peer.subjectaltname ?? '';
  for (const part of san.split(',')) {
    const trimmed = part.trim();
    if (trimmed.startsWith('URI:' + CLIENT_URI_PREFIX)) {
      const cn = peer.subject?.CN;
      const label = Array.isArray(cn) ? cn[0] ?? '' : cn ?? '';
      return { clientId: trimmed.slice(('URI:' + CLIENT_URI_PREFIX).length), label };
    }
  }
  return null;
}

/**
 * Verify a client (or server) cert chains to the project CA. Returns true on a
 * valid chain (signature + validity window), false on any failure — never throws.
 */
export function verifyClientCert(caCertPem: string, clientCertPem: string): boolean {
  try {
    const caStore = forge.pki.createCaStore([caCertPem]);
    const cert = forge.pki.certificateFromPem(clientCertPem);
    return forge.pki.verifyCertificateChain(caStore, [cert]);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Per-project persistence (keychain-backed)
// ---------------------------------------------------------------------------

/** A stable, short per-project id derived from the absolute data dir, so the CA
 *  secrets are namespaced per project in the shared keychain service. */
export function projectCaId(dataDir: string): string {
  const abs = isAbsolute(dataDir) ? dataDir : resolve(dataDir);
  return createHash('sha256').update(abs).digest('hex').slice(0, 16);
}

function caKeyAccount(projectId: string): string {
  return `ca-key:${projectId}`;
}

function caCertAccount(projectId: string): string {
  return `ca-cert:${projectId}`;
}

/**
 * Load the project CA from the keychain, or null if not yet generated (or the
 * keychain is unavailable). The private key + cert are stored as two keychain
 * entries namespaced by the project data dir.
 */
export async function loadProjectCa(dataDir: string): Promise<CaBundle | null> {
  const projectId = projectCaId(dataDir);
  const caKeyPem = await keychainGet(AUTH_KEYCHAIN_ID, caKeyAccount(projectId));
  const caCertPem = await keychainGet(AUTH_KEYCHAIN_ID, caCertAccount(projectId));
  if (caKeyPem == null || caCertPem == null) return null;
  return { caKeyPem, caCertPem };
}

/**
 * Load the project CA, generating + persisting a fresh one on first use. Throws
 * if the keychain is unavailable and so the generated CA can't be persisted —
 * an mTLS deployment requires a durable CA, so silently using an ephemeral one
 * (which would invalidate every enrolled cert on restart) would be worse.
 */
export async function loadOrCreateProjectCa(dataDir: string): Promise<CaBundle> {
  const existing = await loadProjectCa(dataDir);
  if (existing != null) return existing;

  const ca = generateCa();
  const projectId = projectCaId(dataDir);
  const wroteKey = await keychainSet(AUTH_KEYCHAIN_ID, caKeyAccount(projectId), ca.caKeyPem);
  const wroteCert = await keychainSet(AUTH_KEYCHAIN_ID, caCertAccount(projectId), ca.caCertPem);
  if (!wroteKey || !wroteCert) {
    // Roll back a partial write so a later load doesn't see a half-CA.
    await clearProjectCa(dataDir);
    throw new Error('Cannot persist project CA: OS keychain unavailable. mTLS requires a durable CA.');
  }
  return ca;
}

/** Remove the project CA from the keychain (reset / teardown). */
export async function clearProjectCa(dataDir: string): Promise<void> {
  const projectId = projectCaId(dataDir);
  await keychainDelete(AUTH_KEYCHAIN_ID, caKeyAccount(projectId));
  await keychainDelete(AUTH_KEYCHAIN_ID, caCertAccount(projectId));
}
