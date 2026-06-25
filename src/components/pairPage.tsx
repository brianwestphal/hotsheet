import { Layout } from './layout.js';

/**
 * HS-9033 — the standalone device-pairing page (`GET /pair`), the phone end of
 * mTLS QR pairing (docs/94 §94.4.2 Phase 2). Deliberately NOT the full app: an
 * enrolling device has no shared secret and reaches the server over the trusted
 * tunnel channel, so this is a lean, secret-free surface that loads its own
 * `pair.js` (in-browser keypair + CSR + `.p12` assembly) instead of `app.js`.
 *
 * The server renders only the shell + a root container; `src/client/pair.tsx`
 * renders every step into `#pair-root` so the flow lives in one place.
 */
export function PairPage() {
  return (
    <Layout title="Pair device · Hot Sheet" scriptSrc="/static/pair.js">
      <div className="pair-page">
        <header className="pair-header">
          <h1>Pair this device</h1>
          <p className="pair-sub">Enroll this device for secure remote access to Hot Sheet.</p>
        </header>
        <main className="pair-root" id="pair-root">
          <div className="pair-loading">Loading…</div>
        </main>
        <noscript>
          <p className="pair-error">JavaScript is required to pair this device.</p>
        </noscript>
      </div>
    </Layout>
  );
}
