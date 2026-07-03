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
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::ws::{Message as AxumMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Request, State};
use axum::response::{IntoResponse, Response};
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message as TungMessage;

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

/// Build a `rustls::ClientConfig` presenting the device client cert + trusting
/// ONLY the per-project CA — the shared config for the WS-proxy leg (HS-9309).
/// `tokio-tungstenite` consumes it via `Connector::Rustls`; it also unifies with
/// the HTTP leg (reqwest can take it via `use_preconfigured_tls`). Pure over PEM.
pub fn build_rustls_config(identity: &MtlsIdentity) -> Result<rustls::ClientConfig, String> {
    // rustls 0.23 needs a process CryptoProvider; install aws-lc-rs once (idempotent).
    static PROVIDER: std::sync::Once = std::sync::Once::new();
    PROVIDER.call_once(|| {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    });

    let mut roots = rustls::RootCertStore::empty();
    for cert in rustls_pemfile::certs(&mut identity.ca_pem.as_bytes()) {
        roots
            .add(cert.map_err(|e| format!("CA parse: {e}"))?)
            .map_err(|e| format!("CA add: {e}"))?;
    }
    if roots.is_empty() {
        return Err("no CA certificate in ca_pem".into());
    }

    let certs = rustls_pemfile::certs(&mut identity.cert_pem.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("client cert parse: {e}"))?;
    let key = rustls_pemfile::private_key(&mut identity.key_pem.as_bytes())
        .map_err(|e| format!("client key parse: {e}"))?
        .ok_or_else(|| "no client private key in key_pem".to_string())?;

    rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_client_auth_cert(certs, key)
        .map_err(|e| format!("client auth config: {e}"))
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
    /// Shared rustls config for the WS leg (client-auth cert + project CA root).
    ws_config: Arc<rustls::ClientConfig>,
}

/// Start a loopback (127.0.0.1, ephemeral port) HTTP proxy that forwards every
/// request to `remote_origin` over the mTLS client. Returns a handle carrying the
/// port + a shutdown trigger. Async — runs on Tauri's tokio runtime.
///
/// Both HTTP (buffered body) and WebSocket upgrades (`/ws/sync` + terminal WS)
/// are proxied over mTLS. A streaming-body pass is a follow-up.
pub async fn start_proxy(identity: MtlsIdentity, remote_origin: String) -> Result<ProxyHandle, String> {
    let client = build_client(&identity)?;
    let ws_config = Arc::new(build_rustls_config(&identity)?);
    let state = ProxyState { client, remote_origin, ws_config };
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
    // A `Connection: Upgrade` / `Upgrade: websocket` request → proxy the socket to
    // the remote `wss://` over mTLS. (`Option<WebSocketUpgrade>` isn't a valid axum
    // 0.8 extractor, so detect the header + run the extractor by hand.)
    let is_ws = req
        .headers()
        .get(axum::http::header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));

    let (mut parts, body) = req.into_parts();
    let path_and_query = parts.uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/").to_string();

    if is_ws {
        return match WebSocketUpgrade::from_request_parts(&mut parts, &state).await {
            Ok(ws) => {
                let target = format!("{}{}", https_to_wss(&state.remote_origin), path_and_query);
                let config = state.ws_config.clone();
                ws.on_upgrade(move |socket| proxy_ws(socket, target, config))
            }
            Err(rej) => rej.into_response(),
        };
    }

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
            // Drop hop-by-hop + framing headers: we re-frame the body ourselves, so
            // relaying the upstream's `transfer-encoding`/`content-length` produces a
            // malformed response (hyper `IncompleteMessage`). `append` preserves
            // multi-value headers (e.g. `set-cookie`).
            if is_hop_by_hop(name) {
                continue;
            }
            h.append(name, value.clone());
        }
    }
    resp.body(Body::from(bytes)).unwrap_or_else(|e| bad_gateway(format!("build response: {e}")))
}

/// Hop-by-hop / framing headers a proxy must not relay verbatim (RFC 9110 §7.6.1
/// + the framing headers we set ourselves). `HeaderName::as_str` is lowercase.
fn is_hop_by_hop(name: &axum::http::HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection" | "keep-alive" | "proxy-authenticate" | "proxy-authorization"
            | "te" | "trailer" | "transfer-encoding" | "upgrade" | "content-length"
    )
}

/// `https://host:port` → `wss://host:port` (and `http`→`ws`) for the WS dial.
fn https_to_wss(origin: &str) -> String {
    if let Some(rest) = origin.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = origin.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        origin.to_string()
    }
}

/// Proxy a loopback WebSocket to the remote `wss://` over mTLS, piping frames
/// bidirectionally until either side closes. Best-effort — a failed remote dial
/// just drops the loopback socket (the client sees a closed connection).
async fn proxy_ws(client_ws: WebSocket, target: String, config: Arc<rustls::ClientConfig>) {
    let connector = tokio_tungstenite::Connector::Rustls(config);
    let remote = match tokio_tungstenite::connect_async_tls_with_config(&target, None, false, Some(connector)).await {
        Ok((stream, _resp)) => stream,
        Err(_) => return, // dial/handshake failed → drop; the loopback socket closes
    };

    let (mut client_tx, mut client_rx) = client_ws.split();
    let (mut remote_tx, mut remote_rx) = remote.split();

    // loopback (browser) → remote
    let c2r = async {
        while let Some(Ok(msg)) = client_rx.next().await {
            if remote_tx.send(axum_to_tung(msg)).await.is_err() {
                break;
            }
        }
    };
    // remote → loopback (browser)
    let r2c = async {
        while let Some(Ok(msg)) = remote_rx.next().await {
            if client_tx.send(tung_to_axum(msg)).await.is_err() {
                break;
            }
        }
    };

    tokio::select! {
        _ = c2r => {}
        _ = r2c => {}
    }
}

/// axum → tungstenite frame. Close-frame details are dropped (a bare Close both
/// sides understand is enough for a proxy).
fn axum_to_tung(m: AxumMessage) -> TungMessage {
    match m {
        AxumMessage::Text(t) => TungMessage::Text(t.as_str().into()),
        AxumMessage::Binary(b) => TungMessage::Binary(b),
        AxumMessage::Ping(b) => TungMessage::Ping(b),
        AxumMessage::Pong(b) => TungMessage::Pong(b),
        AxumMessage::Close(_) => TungMessage::Close(None),
    }
}

/// tungstenite → axum frame (the reverse of `axum_to_tung`).
fn tung_to_axum(m: TungMessage) -> AxumMessage {
    match m {
        TungMessage::Text(t) => AxumMessage::Text(t.as_str().into()),
        TungMessage::Binary(b) => AxumMessage::Binary(b),
        TungMessage::Ping(b) => AxumMessage::Ping(b),
        TungMessage::Pong(b) => AxumMessage::Pong(b),
        TungMessage::Close(_) => AxumMessage::Close(None),
        TungMessage::Frame(_) => AxumMessage::Close(None), // raw frames aren't surfaced by the reader
    }
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

    // HS-9309 Phase-A — the LIVE mTLS handshake against a real server. `#[ignore]`
    // so `cargo test` skips it by default; the `validate-mtls` harness starts the
    // shipped Node mTLS listener (real CA + `.p12`→PEM client material) and runs
    // this with `-- --ignored` + `HS_MTLS_PORT`/`HS_MTLS_CERT_DIR` set. Validates
    // the interop that matters: Node-minted PKCS#1 client key → reqwest/rustls
    // `Identity` → Node `requestCert`+`rejectUnauthorized` acceptance.
    #[tokio::test]
    #[ignore]
    async fn live_mtls_handshake_against_real_server() {
        let dir = std::env::var("HS_MTLS_CERT_DIR").expect("HS_MTLS_CERT_DIR unset");
        let port = std::env::var("HS_MTLS_PORT").expect("HS_MTLS_PORT unset");
        let read = |f: &str| std::fs::read_to_string(format!("{dir}/{f}")).expect(f);
        let identity = MtlsIdentity {
            cert_pem: read("client.crt"),
            key_pem: read("client.key"),
            ca_pem: read("ca.crt"),
        };
        let url = format!("https://127.0.0.1:{port}/api/projects");

        // Positive: the enrolled client cert completes the mTLS handshake.
        let client = build_client(&identity).expect("build_client");
        let resp = client.get(&url).send().await.expect("mTLS request should succeed");
        assert!(resp.status().is_success(), "unexpected status {}", resp.status());
        let body = resp.text().await.expect("body");
        assert!(body.contains("\"ok\":true"), "unexpected body: {body}");

        // Negative: trusting the CA but presenting NO client cert must be rejected
        // by the server's requestCert + rejectUnauthorized.
        let ca = reqwest::Certificate::from_pem(identity.ca_pem.as_bytes()).unwrap();
        let no_cert = reqwest::Client::builder()
            .use_rustls_tls()
            .tls_built_in_root_certs(false)
            .add_root_certificate(ca)
            .build()
            .unwrap();
        assert!(
            no_cert.get(&url).send().await.is_err(),
            "a request WITHOUT a client cert must fail the mTLS handshake",
        );
    }

    // HS-9309 Phase-A — the LIVE `wss://` client-auth handshake (the WS-proxy leg).
    // Validates that `build_rustls_config` + tokio-tungstenite completes the mTLS
    // WebSocket upgrade against the harness's `/ws/echo` endpoint (client cert
    // required for the upgrade), and that frames round-trip. `#[ignore]` like the
    // HTTP test; run via `npm run validate:mtls`.
    #[tokio::test]
    #[ignore]
    async fn live_wss_mtls_handshake_against_real_server() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;

        let dir = std::env::var("HS_MTLS_CERT_DIR").expect("HS_MTLS_CERT_DIR unset");
        let port = std::env::var("HS_MTLS_PORT").expect("HS_MTLS_PORT unset");
        let read = |f: &str| std::fs::read_to_string(format!("{dir}/{f}")).expect(f);
        let identity = MtlsIdentity {
            cert_pem: read("client.crt"),
            key_pem: read("client.key"),
            ca_pem: read("ca.crt"),
        };

        let config = build_rustls_config(&identity).expect("build_rustls_config");
        let connector = tokio_tungstenite::Connector::Rustls(std::sync::Arc::new(config));
        let url = format!("wss://127.0.0.1:{port}/ws/echo");

        let (mut ws, _resp) =
            tokio_tungstenite::connect_async_tls_with_config(&url, None, false, Some(connector))
                .await
                .expect("wss mTLS handshake should succeed");

        ws.send(Message::text("ping")).await.expect("send");
        let reply = ws.next().await.expect("a reply").expect("ok");
        assert_eq!(reply.into_text().expect("text").as_str(), "ping");
    }

    // HS-9309 Phase-A — end-to-end through the actual loopback proxy: a PLAIN
    // client hits `http://127.0.0.1:<loopback>` (no cert) and the proxy adds the
    // mTLS on the way to the harness. Validates the real forwarding path, not just
    // `build_client`/`build_rustls_config` in isolation. `#[ignore]`d.
    fn test_identity() -> MtlsIdentity {
        let dir = std::env::var("HS_MTLS_CERT_DIR").expect("HS_MTLS_CERT_DIR unset");
        let read = |f: &str| std::fs::read_to_string(format!("{dir}/{f}")).expect(f);
        MtlsIdentity { cert_pem: read("client.crt"), key_pem: read("client.key"), ca_pem: read("ca.crt") }
    }

    #[tokio::test]
    #[ignore]
    async fn live_http_proxy_end_to_end() {
        let port = std::env::var("HS_MTLS_PORT").expect("HS_MTLS_PORT unset");
        let handle = start_proxy(test_identity(), format!("https://127.0.0.1:{port}")).await.expect("start_proxy");
        let url = format!("{}/api/projects", handle.loopback_url());
        let resp = reqwest::get(&url).await.expect("loopback GET");
        assert!(resp.status().is_success());
        assert!(resp.text().await.unwrap().contains("\"ok\":true"));
    }

    #[tokio::test]
    #[ignore]
    async fn live_ws_proxy_end_to_end() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;

        let port = std::env::var("HS_MTLS_PORT").expect("HS_MTLS_PORT unset");
        let handle = start_proxy(test_identity(), format!("https://127.0.0.1:{port}")).await.expect("start_proxy");
        // Plain ws:// to the loopback proxy — no client cert; the proxy adds mTLS.
        let url = format!("ws://127.0.0.1:{}/ws/echo", handle.port);
        let (mut ws, _resp) = tokio_tungstenite::connect_async(&url).await.expect("loopback ws connect");
        ws.send(Message::text("via-proxy")).await.expect("send");
        let reply = ws.next().await.expect("a reply").expect("ok");
        assert_eq!(reply.into_text().expect("text").as_str(), "via-proxy");
    }

    // HS-9312 Phase-A — the full "(b)" path: read the device identity from the OS
    // keychain (no PEM through JS) → handshake. The `validate-mtls` harness writes
    // the `{cert,key,ca}` JSON blob into the keychain under
    // (com.hotsheet.plugin.mtls, <origin>) + sets HS_MTLS_ORIGIN before this runs,
    // and deletes it after. `#[ignore]`d + macOS/Linux only (Windows has no
    // keychain path). Skips cleanly when HS_MTLS_ORIGIN is unset.
    #[tokio::test]
    #[ignore]
    async fn live_keychain_identity_handshake() {
        let Ok(origin) = std::env::var("HS_MTLS_ORIGIN") else { return };
        let identity = crate::mtls_keychain::read_identity(&origin).expect("read identity from keychain");
        let client = build_client(&identity).expect("build_client");
        let resp = client.get(format!("{origin}/api/projects")).send().await.expect("keychain-identity mTLS GET");
        assert!(resp.status().is_success(), "status {}", resp.status());
        assert!(resp.text().await.unwrap().contains("\"ok\":true"));
    }
}
