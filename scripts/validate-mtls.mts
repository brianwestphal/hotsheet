// HS-9309 Phase-A — the mTLS validation harness for the desktop loopback proxy
// (`src-tauri/src/mtls_proxy.rs`). Stands up the SHIPPED mTLS material + listener
// so the Rust `build_client` (reqwest/rustls) handshake can be validated against a
// real server WITHOUT needing an exposed `--server remote-access` deployment:
//
//   1. mint a per-project CA + server cert + client cert via `src/auth/ca.ts`;
//   2. round-trip the client through a real `.p12` (`exportClientP12`→`readP12`),
//      so the PEM the Rust proxy receives is EXACTLY the desktop enrollment path
//      (a PKCS#1 RSA key — the interop detail worth proving against rustls);
//   3. start Node's mTLS listener (`requestCert` + `rejectUnauthorized`) with a
//      `GET /api/*` HTTP endpoint AND a `wss://…/ws/echo` endpoint (for the WS
//      leg validation);
//   4. write `client.crt` / `client.key` / `ca.crt` to a temp dir and print
//      `READY <port> <certdir>`, then stay up until killed.
//
// Driven by `scripts/validate-mtls.sh` (which runs the `#[ignore]`d live Rust
// tests against it). Run: `npm run validate:mtls`.
import { mkdtempSync, writeFileSync } from 'fs';
import { createServer } from 'https';
import { tmpdir } from 'os';
import { join } from 'path';

import { WebSocketServer } from 'ws';

import { exportClientP12, generateCa, readP12, signClientCert, signServerCert } from '../src/auth/ca.js';

const ca = generateCa({ commonName: 'HS Phase-A Test CA' });
const server = signServerCert(ca, { hosts: ['localhost', '127.0.0.1'] });
const clientSigned = signClientCert(ca, { clientId: 'phase-a-device', label: 'Phase-A Device' });

// The exact material the desktop hands the Rust proxy: PEM extracted from a `.p12`.
const p12 = exportClientP12({ certPem: clientSigned.certPem, keyPem: clientSigned.keyPem, caCertPem: ca.caCertPem, password: 'phase-a-pw' });
const client = readP12(p12, 'phase-a-pw');

const dir = mkdtempSync(join(tmpdir(), 'hs-mtls-phaseA-'));
writeFileSync(join(dir, 'client.crt'), client.certPem);
writeFileSync(join(dir, 'client.key'), client.keyPem);
writeFileSync(join(dir, 'ca.crt'), ca.caCertPem);

const srv = createServer(
  { cert: server.certPem, key: server.keyPem, ca: [ca.caCertPem], requestCert: true, rejectUnauthorized: true },
  (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, path: req.url })); },
);

// WS echo endpoint on the SAME mTLS listener — the client cert is required for the
// upgrade too, so this validates the `wss://` client-auth handshake.
const wss = new WebSocketServer({ server: srv, path: '/ws/echo' });
wss.on('connection', (ws) => { ws.on('message', (data) => ws.send(data.toString())); });

srv.listen(0, '127.0.0.1', () => {
  const addr = srv.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  // eslint-disable-next-line no-console
  console.log(`READY ${port} ${dir}`);
});
