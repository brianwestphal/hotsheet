/**
 * HS-9033 — the device-side pairing crypto. The point of these tests is
 * cross-compatibility: a CSR generated in the browser by `generateDeviceCsr`
 * must parse + verify through the SAME server path that signs it
 * (`signClientCsr`), and a `.p12` assembled by `buildClientP12` must re-import
 * through `readP12` and chain to the CA exactly like a server-minted one. A
 * single shared keypair is generated once (2048-bit keygen is slow) and reused.
 */
import forge from 'node-forge';
import { beforeAll, describe, expect, it } from 'vitest';

import { generateCa, readIdentity, readP12, signClientCsr, verifyClientCert } from '../../auth/ca.js';
import { buildClientP12, type DeviceCsr,generateDeviceCsr } from './devicePairing.js';

describe('device pairing crypto (HS-9033)', () => {
  const ca = generateCa({ commonName: 'Test Project CA' });
  let device: DeviceCsr;

  beforeAll(async () => {
    device = await generateDeviceCsr('My Phone');
  }, 20_000);

  it('generates a forge-parseable CSR whose self-signature verifies', () => {
    const csr = forge.pki.certificationRequestFromPem(device.csrPem);
    expect(csr.verify()).toBe(true);
    expect(device.privateKeyPem).toContain('RSA PRIVATE KEY');
  });

  it('produces a CSR the server signs into a CA-chained client cert', () => {
    const certPem = signClientCsr(ca, device.csrPem, { clientId: 'cid-1', label: 'My Phone' });
    expect(verifyClientCert(ca.caCertPem, certPem)).toBe(true);
    // The server stamps ITS identity (clientId/label), not the CSR's CN.
    expect(readIdentity(certPem)).toEqual({ clientId: 'cid-1', label: 'My Phone' });
  });

  it('assembles a .p12 that re-imports with the device key + signed cert + CA', () => {
    const certPem = signClientCsr(ca, device.csrPem, { clientId: 'cid-2', label: 'My Phone' });
    const p12Base64 = buildClientP12({
      privateKeyPem: device.privateKeyPem,
      certPem,
      caCertPem: ca.caCertPem,
      password: 'pairpw',
      friendlyName: 'My Phone',
    });
    const back = readP12(Buffer.from(p12Base64, 'base64'), 'pairpw');
    expect(verifyClientCert(ca.caCertPem, back.certPem)).toBe(true);
    expect(readIdentity(back.certPem)).toEqual({ clientId: 'cid-2', label: 'My Phone' });
    // The CA travelled in the bundle so the import is self-contained.
    expect(back.caCertPems.length).toBeGreaterThanOrEqual(1);
    // The re-imported private key is the device's original (paired with the cert).
    expect(back.keyPem).toBe(device.privateKeyPem);
  });

  it('rejects a wrong .p12 password on re-import', () => {
    const certPem = signClientCsr(ca, device.csrPem, { clientId: 'cid-3', label: 'X' });
    const p12Base64 = buildClientP12({ privateKeyPem: device.privateKeyPem, certPem, caCertPem: ca.caCertPem, password: 'right' });
    expect(() => readP12(Buffer.from(p12Base64, 'base64'), 'wrong')).toThrow();
  });
});
