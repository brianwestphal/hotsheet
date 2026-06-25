/**
 * HS-9033 — the device (phone) side of mTLS QR pairing (docs/94 §94.4.2 Phase 2):
 * the in-browser crypto that turns a scanned pairing payload into an installable
 * client credential. Kept DOM-free + pure so it unit-tests without a camera or a
 * page, and so the same `node-forge` the server signs with also *generates* here
 * — guaranteeing the CSR parses + verifies on the server (`signClientCsr`) and the
 * `.p12` re-imports identically to a server-minted one (`readP12`).
 *
 * Flow: `generateDeviceCsr(label)` (the private key NEVER leaves the device) →
 * POST `completePairing({ token, csrPem, label })` → `buildClientP12(...)` from
 * the device key + the returned cert + CA → install (platform-specific, manual).
 */
import forge from 'node-forge';

/** A freshly-generated device keypair: the CSR to send for signing, and the
 *  PKCS#1 private-key PEM the device keeps (paired later with the signed cert in
 *  the `.p12`). */
export interface DeviceCsr {
  csrPem: string;
  privateKeyPem: string;
}

/**
 * Generate an RSA-2048 keypair and a self-signed PKCS#10 CSR for `commonName`,
 * signed SHA-256 — the exact shape the server's `signClientCsr` expects (it
 * re-derives identity, so the CN here is cosmetic). Async + chunked so 2048-bit
 * keygen doesn't freeze the phone's UI; resolves with the CSR + the private key
 * PEM to retain. Rejects only on an internal forge failure.
 */
export function generateDeviceCsr(commonName: string): Promise<DeviceCsr> {
  return new Promise((resolve, reject) => {
    // No `workers` option: forge's worker path needs a separately-hosted worker
    // script URL (awkward in a bundled IIFE); the plain async path already yields
    // to the event loop between rounds, keeping the page responsive.
    // forge's typings declare the callback as `(err: Error, keypair: KeyPair)`
    // (both non-null), but at runtime a failure passes an error + no keypair —
    // widen the params to nullable so the guard below is real, not dead code.
    forge.pki.rsa.generateKeyPair({ bits: 2048 }, (err: Error | null, keypair?: forge.pki.rsa.KeyPair) => {
      if (err != null || keypair == null) {
        reject(err ?? new Error('Key generation failed'));
        return;
      }
      try {
        const csr = forge.pki.createCertificationRequest();
        csr.publicKey = keypair.publicKey;
        csr.setSubject([{ name: 'commonName', value: commonName }]);
        csr.sign(keypair.privateKey, forge.md.sha256.create());
        resolve({
          csrPem: forge.pki.certificationRequestToPem(csr),
          privateKeyPem: forge.pki.privateKeyToPem(keypair.privateKey),
        });
      } catch (e) {
        reject(e instanceof Error ? e : new Error('CSR construction failed'));
      }
    });
  });
}

/**
 * Assemble a password-protected PKCS#12 (`.p12`) from the device's private key,
 * the server-signed client cert, and the project CA — returned base64 for a
 * download link. Mirrors the server's `exportClientP12` (3DES, cert + CA bag
 * order) so a paired device's bundle is byte-compatible with a loopback-minted
 * one and re-imports via `readP12`. Throws on a malformed PEM input.
 */
export function buildClientP12(args: {
  privateKeyPem: string;
  certPem: string;
  caCertPem: string;
  password: string;
  friendlyName?: string;
}): string {
  const key = forge.pki.privateKeyFromPem(args.privateKeyPem);
  const cert = forge.pki.certificateFromPem(args.certPem);
  const caCert = forge.pki.certificateFromPem(args.caCertPem);
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(key, [cert, caCert], args.password, {
    friendlyName: args.friendlyName ?? 'Hot Sheet Client',
    algorithm: '3des',
  });
  const der = forge.asn1.toDer(p12Asn1).getBytes();
  return forge.util.encode64(der);
}
