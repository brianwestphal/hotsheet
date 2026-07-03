// HS-9314 — stage / unstage the desktop mTLS device identity in the OS keychain
// for `validate-mtls.sh`, using the REAL Node writer (`writeMtlsIdentity`) so the
// harness validates the Node-write ↔ Rust-read keychain contract end-to-end.
//
//   npx tsx scripts/mtls-stage-identity.mts write  <origin> <certDir>
//   npx tsx scripts/mtls-stage-identity.mts delete <origin>
import { readFileSync } from 'fs';

import { deleteMtlsIdentity, writeMtlsIdentity } from '../src/auth/mtlsIdentityStore.js';

const [action, origin, certDir] = process.argv.slice(2);

if (action === 'write') {
  const ok = await writeMtlsIdentity(origin, {
    cert: readFileSync(`${certDir}/client.crt`, 'utf8'),
    key: readFileSync(`${certDir}/client.key`, 'utf8'),
    ca: readFileSync(`${certDir}/ca.crt`, 'utf8'),
  });
  // eslint-disable-next-line no-console
  console.log(ok ? 'staged mTLS identity in the keychain' : 'keychain unavailable — keychain test will skip');
} else if (action === 'delete') {
  await deleteMtlsIdentity(origin);
}
