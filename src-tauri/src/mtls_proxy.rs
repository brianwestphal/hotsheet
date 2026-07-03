// HS-9307 (docs/112 §112.5.1) — the desktop (Tauri) loopback mTLS proxy.
//
// The platform WebViews can't present an OS-store client certificate on the
// outbound `wss://`/`https://` mTLS handshake that Hot Sheet's remote transport
// needs (HS-9306: WKWebView is broken for our fetch/WebSocket subresource
// requests; WebView2/WebKitGTK need bespoke native wiring Tauri doesn't expose).
// So the Rust side holds the client cert and does the outbound mTLS itself,
// exposing a **loopback (127.0.0.1, ephemeral port)** plain-HTTP endpoint the
// WebView hits over `http://127.0.0.1:<port>`. The client's origin-aware
// transport (HS-9302) points a remote project at that loopback URL when running
// under Tauri; the web build is unaffected (the browser presents the cert
// natively, §97.3).
//
// **Scaffold status (HS-9307):** the mTLS client construction + the loopback
// HTTP forwarder + the start/stop registry are here and compile. NOT yet done:
// (a) the WebSocket-proxy leg (`/ws/sync` + terminal WS need a
// `tokio-tungstenite` client sharing one rustls config); (b) the real-server
// validation spike (Phase A — prove the handshake against an exposed
// `--server remote-access` + a minted `.p12`). Both are follow-ups; the proxy is
// unvalidated against a real server (maintainer-accepted, 2026-07-03).

use std::collections::HashMap;
use std::sync::Mutex;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::response::Response;
use axum::Router;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

/// The per-device client identity + the server's trust root, all PEM. The client
/// cert/key are what the WebView can't present; the CA is the per-project
/// self-signed CA (docs/94) the outbound handshake validates the server against.
#[derive(Clone)]
pub struct MtlsIdentity {
    pub cert_pem: String,
    pub key_pem: String,
    pub ca_pem: String,
}

/// Build a `reqwest` client that (1) presents `identity`'s client cert on the
/// mTLS handshake and (2) trusts the per-project CA. rustls backend (no OpenSSL)
/// so the build stays cross-platform. Pure over the PEM inputs → unit-testable
/// without a live server.
pub fn build_client(identity: &MtlsIdentity) -> Result<reqwest::Client, String> {
    // reqwest's `Identity::from_pem` wants the cert + PKCS#8 key concatenated.
    let mut bundle = identity.cert_pem.clone();
    if !bundle.ends_with('\n') {
        bundle.push('\n');
    }
    bundle.push_str(&identity.key_pem);
    let id = reqwest::Identity::from_pem(bundle.as_bytes())
        .map_err(|e| format!("client identity: {e}"))?;
    let ca = reqwest::Certificate::from_pem(identity.ca_pem.as_bytes())
        .map_err(|e| format!("CA certificate: {e}"))?;
    reqwest::Client::builder()
        .use_rustls_tls()
        .identity(id)
        .add_root_certificate(ca)
        // The per-project CA is a private root; don't also trust the OS bundle
        // (the remote server is authenticated ONLY by its project CA, docs/94).
        .tls_built_in_root_certs(false)
        .build()
        .map_err(|e| format!("build client: {e}"))
}

/// A running loopback proxy: its port + a shutdown trigger.
pub struct ProxyHandle {
    port: u16,
    shutdown: Option<oneshot::Sender<()>>,
}

impl ProxyHandle {
    /// The loopback base URL the WebView should hit for this remote origin.
    pub fn loopback_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// Signal the proxy task to shut down (idempotent).
    pub fn stop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

#[derive(Clone)]
struct ProxyState {
    client: reqwest::Client,
    /// The remote origin (`https://host:port`) requests are forwarded to.
    remote_origin: String,
}

/// Start a loopback (127.0.0.1, ephemeral port) HTTP proxy that forwards every
/// request to `remote_origin` over the mTLS client. Returns a handle carrying the
/// port + a shutdown trigger. Async — runs on Tauri's tokio runtime.
///
/// NOTE (scaffold): WebSocket upgrades are NOT yet proxied (the `/ws/sync` +
/// terminal WS legs are the follow-up). HTTP is forwarded with a buffered body.
pub async fn start_proxy(identity: MtlsIdentity, remote_origin: String) -> Result<ProxyHandle, String> {
    let client = build_client(&identity)?;
    let state = ProxyState { client, remote_origin };
    let app: Router = Router::new().fallback(forward).with_state(state);

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind loopback: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?
        .port();

    let (tx, rx) = oneshot::channel::<()>();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = rx.await;
            })
            .await;
    });

    Ok(ProxyHandle { port, shutdown: Some(tx) })
}

/// Forward one loopback request to the remote origin over mTLS and relay the
/// response. Buffers the body (fine for the API surface; a streaming pass is a
/// follow-up). Failures become a 502 so the WebView sees a clean error.
async fn forward(State(state): State<ProxyState>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");
    let url = format!("{}{}", state.remote_origin, path_and_query);

    let body_bytes = match axum::body::to_bytes(body, usize::MAX).await {
        Ok(b) => b,
        Err(e) => return bad_gateway(format!("read body: {e}")),
    };

    let mut builder = state.client.request(parts.method.clone(), &url).body(body_bytes.to_vec());
    // Relay request headers, minus hop-by-hop / host (reqwest sets Host from the URL).
    for (name, value) in parts.headers.iter() {
        if name == axum::http::header::HOST {
            continue;
        }
        builder = builder.header(name, value);
    }

    let upstream = match builder.send().await {
        Ok(r) => r,
        Err(e) => return bad_gateway(format!("upstream: {e}")),
    };

    let status = upstream.status();
    let headers = upstream.headers().clone();
    let bytes = match upstream.bytes().await {
        Ok(b) => b,
        Err(e) => return bad_gateway(format!("upstream body: {e}")),
    };

    let mut resp = Response::builder().status(status);
    if let Some(h) = resp.headers_mut() {
        for (name, value) in headers.iter() {
            h.insert(name, value.clone());
        }
    }
    resp.body(Body::from(bytes)).unwrap_or_else(|e| bad_gateway(format!("build response: {e}")))
}

fn bad_gateway(msg: String) -> Response {
    Response::builder()
        .status(axum::http::StatusCode::BAD_GATEWAY)
        .body(Body::from(msg))
        .expect("static 502 response builds")
}

/// The Tauri-managed registry of running proxies, keyed by remote origin.
#[derive(Default)]
pub struct MtlsProxies(pub Mutex<HashMap<String, ProxyHandle>>);

#[cfg(test)]
mod tests {
    use super::*;

    // A self-signed cert + PKCS#8 key + a CA PEM would be generated by the server
    // (docs/94). Here we only assert `build_client` REJECTS malformed PEM without a
    // network — the happy path (a real cert) is exercised by the manual real-server
    // spike (Phase A). Constructing a valid self-signed identity in-test would pull
    // a cert-gen dep we don't want just for the scaffold.
    #[test]
    fn build_client_rejects_empty_pem() {
        let id = MtlsIdentity {
            cert_pem: String::new(),
            key_pem: String::new(),
            ca_pem: String::new(),
        };
        assert!(build_client(&id).is_err());
    }

    #[test]
    fn build_client_rejects_garbage_pem() {
        let id = MtlsIdentity {
            cert_pem: "-----BEGIN CERTIFICATE-----\nnot base64\n-----END CERTIFICATE-----".into(),
            key_pem: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----".into(),
            ca_pem: "garbage".into(),
        };
        assert!(build_client(&id).is_err());
    }

    #[test]
    fn loopback_url_formats_the_port() {
        let h = ProxyHandle { port: 51234, shutdown: None };
        assert_eq!(h.loopback_url(), "http://127.0.0.1:51234");
    }
}
