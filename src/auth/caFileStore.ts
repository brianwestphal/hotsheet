/**
 * HS-9019 — encrypted-file fallback for the per-project CA secret when no OS
 * keychain is available (headless Linux without a keyring daemon, Windows, or a
 * temp HOME). The exposed-server (Tier-1) path needs a *durable* CA — a CA that
 * regenerates on restart would invalidate every enrolled client cert — but the
 * keychain is exactly what a headless box usually lacks (see HS-9019 / docs/97).
 *
 * The CA private key is the project **trust anchor**: anyone who can read it can
 * mint client certs the mTLS listener trusts (i.e. impersonate any device). So
 * the fallback never writes it in plaintext. It is encrypted at rest with
 * **AES-256-GCM** under a key derived (**scrypt**) from an operator-supplied
 * passphrase in the `HOTSHEET_CA_PASSPHRASE` environment variable. With no
 * passphrase we refuse to persist (the caller fails startup) rather than fall
 * back to plaintext or an ephemeral CA — the maintainer-chosen posture (HS-9019).
 *
 * The file lives at `<dataDir>/auth-ca.enc`, gitignored (the HS-8989 rule ignores
 * everything under `.hotsheet/` except `settings.json`), machine-local, and
 * per-project (the dataDir is the project). Written 0600.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';

import type { CaBundle } from './ca.js';

/** Env var carrying the operator passphrase that wraps the CA key on disk. */
export const CA_PASSPHRASE_ENV = 'HOTSHEET_CA_PASSPHRASE';

/** scrypt cost parameters. N=2^15 keeps the derivation a few hundred ms while
 *  staying under Node's default 32 MB scrypt memory cap (128*N*r ≈ 32 MB at
 *  r=8 would exceed it, so r=8/N=2^15 is sized with headroom via maxmem). */
const SCRYPT_N = 1 << 15; // 32768
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32; // AES-256
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const CA_ENC_FILENAME = 'auth-ca.enc';

/** On-disk envelope. All binary fields are base64. `v` guards format evolution. */
const EncFileSchema = z.object({
  v: z.literal(1),
  kdf: z.literal('scrypt'),
  n: z.number().int().positive(),
  r: z.number().int().positive(),
  p: z.number().int().positive(),
  salt: z.string(),
  iv: z.string(),
  tag: z.string(),
  ct: z.string(),
});

export function caEncFilePath(dataDir: string): string {
  return join(dataDir, CA_ENC_FILENAME);
}

export function caEncFileExists(dataDir: string): boolean {
  return existsSync(caEncFilePath(dataDir));
}

/** The operator passphrase from the environment, or undefined when unset/blank. */
export function caPassphrase(): string | undefined {
  const v = process.env[CA_PASSPHRASE_ENV];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed === '' ? undefined : trimmed;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM,
  });
}

/**
 * Encrypt + write the CA bundle to `<dataDir>/auth-ca.enc` (0600). Overwrites any
 * existing file. The plaintext is the JSON `{caKeyPem, caCertPem}`.
 */
export function writeEncryptedCa(dataDir: string, ca: CaBundle, passphrase: string): void {
  const salt = randomBytes(16);
  const iv = randomBytes(12); // 96-bit nonce, the GCM standard
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify({ caKeyPem: ca.caKeyPem, caCertPem: ca.caCertPem }), 'utf-8');
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope = {
    v: 1, kdf: 'scrypt', n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  };
  const path = caEncFilePath(dataDir);
  // mode on writeFileSync only applies on create; chmod unconditionally so a
  // pre-existing world-readable file is tightened too.
  writeFileSync(path, JSON.stringify(envelope) + '\n', { encoding: 'utf-8', mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort on platforms without POSIX perms */ }
}

/**
 * Read + decrypt the CA bundle from `<dataDir>/auth-ca.enc`. Throws on a missing
 * file, a malformed envelope, or a wrong passphrase (GCM auth-tag mismatch) — the
 * caller must NOT regenerate on failure (that would orphan every enrolled cert).
 */
export function readEncryptedCa(dataDir: string, passphrase: string): CaBundle {
  const raw: unknown = JSON.parse(readFileSync(caEncFilePath(dataDir), 'utf-8'));
  const env = EncFileSchema.parse(raw);
  const salt = Buffer.from(env.salt, 'base64');
  const iv = Buffer.from(env.iv, 'base64');
  const tag = Buffer.from(env.tag, 'base64');
  const ct = Buffer.from(env.ct, 'base64');
  const key = scryptSync(passphrase, salt, SCRYPT_KEYLEN, {
    N: env.n, r: env.r, p: env.p, maxmem: SCRYPT_MAXMEM,
  });
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error(`Cannot decrypt the project CA: wrong ${CA_PASSPHRASE_ENV} or the file is corrupt.`);
  }
  const parsed: unknown = JSON.parse(plaintext.toString('utf-8'));
  const bundle = z.object({ caKeyPem: z.string(), caCertPem: z.string() }).parse(parsed);
  return { caKeyPem: bundle.caKeyPem, caCertPem: bundle.caCertPem };
}

/** Remove the encrypted CA file (reset / teardown). No-op if absent. */
export function removeEncryptedCa(dataDir: string): void {
  try { rmSync(caEncFilePath(dataDir), { force: true }); } catch { /* ignore */ }
}
