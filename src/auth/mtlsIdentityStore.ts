// HS-9314 (docs/112 §112.5.1) — store/read the desktop mTLS DEVICE identity (the
// cert this machine presents to CONNECT to a remote server) in the OS keychain.
//
// This is the WRITE counterpart to the Rust reader (`src-tauri/src/mtls_keychain.rs`,
// HS-9312): both address the SAME keychain entry — service `com.hotsheet.plugin.mtls`
// (via `keychain.ts`'s `com.hotsheet.plugin.<pluginId>` scheme), account = the
// remote `origin`, value = a JSON `{cert,key,ca}` blob — so a cert written here is
// exactly what the loopback proxy reads back. Keeping the private key in the
// keychain (never in a file or the WebView) is the point of the HS-9312 "(b)" design.
//
// NOTE: distinct from the §94 `.p12`-DOWNLOAD flow (which mints certs for OTHER
// devices to install). This is the LOCAL device consuming a cert to connect —
// written when the user imports a `.p12` for a remote server (decrypt via
// `readP12` → `{certPem,keyPem,caCertPems}`) or completes enrollment.

import { z } from 'zod';

import { keychainDelete, keychainGet, keychainSet } from '../keychain.js';
import { parseJsonOrNull } from '../schemas.js';

/** Keychain plugin-id → service `com.hotsheet.plugin.mtls`. MUST match the Rust
 *  reader's `MTLS_PLUGIN_ID`. */
const MTLS_PLUGIN_ID = 'mtls';

/** The stored device identity: the three PEMs the loopback proxy needs. */
export const StoredMtlsIdentitySchema = z.object({
  cert: z.string().min(1),
  key: z.string().min(1),
  ca: z.string().min(1),
});
export type StoredMtlsIdentity = z.infer<typeof StoredMtlsIdentitySchema>;

/** Store the device mTLS identity for `origin`. Returns false if the keychain is
 *  unavailable (e.g. Windows / no Secret Service). */
export async function writeMtlsIdentity(origin: string, identity: StoredMtlsIdentity): Promise<boolean> {
  return keychainSet(MTLS_PLUGIN_ID, origin, JSON.stringify(identity));
}

/** Read the device mTLS identity for `origin`, or null when absent / malformed /
 *  keychain unavailable. */
export async function readMtlsIdentity(origin: string): Promise<StoredMtlsIdentity | null> {
  const raw = await keychainGet(MTLS_PLUGIN_ID, origin);
  return parseJsonOrNull(StoredMtlsIdentitySchema, raw);
}

/** Remove the stored device identity for `origin` (e.g. on disconnect / revoke). */
export async function deleteMtlsIdentity(origin: string): Promise<boolean> {
  return keychainDelete(MTLS_PLUGIN_ID, origin);
}
