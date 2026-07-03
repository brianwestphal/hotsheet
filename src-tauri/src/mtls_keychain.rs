// HS-9312 (docs/112 §112.5.1) — read the desktop mTLS device identity from the OS
// keychain so the private key NEVER crosses the JS/WebView boundary (the
// maintainer chose this over passing PEM through the Tauri command, 2026-07-03).
//
// Interop: this mirrors `src/keychain.ts`'s platform commands EXACTLY — service
// `com.hotsheet.plugin.<id>`, account = key — so the Node-side enrollment writer
// and this Rust reader address the same secret. We shell out to the same tools
// (`security` on macOS, `secret-tool` on Linux) rather than use the `keyring`
// crate, whose default Linux attribute scheme (`service`/`username`) would NOT
// match Node's (`service`/`account`). Windows uses Node's file fallback (no
// keychain) — unsupported here yet (returns None; a follow-up if we add a Windows
// keychain path both sides agree on).
//
// The platform-specific argv is a PURE function (`read_command`) so every OS
// branch is unit-testable on any host (per CLAUDE.md's Rust guidance).

use std::process::Command;

use crate::mtls_proxy::MtlsIdentity;

/// Keychain plugin-id namespace for the desktop mTLS client identity → service
/// `com.hotsheet.plugin.mtls`. The enrollment writer (Node) MUST match.
const MTLS_PLUGIN_ID: &str = "mtls";

fn service_name(plugin_id: &str) -> String {
    format!("com.hotsheet.plugin.{plugin_id}")
}

/// Pure: the argv to READ a generic-password secret on `os`, mirroring
/// `keychain.ts`. `None` on platforms with no keychain path (Windows). `os` is the
/// `std::env::consts::OS`-style string (`"macos"` / `"linux"` / …).
pub fn read_command(os: &str, service: &str, account: &str) -> Option<(String, Vec<String>)> {
    match os {
        "macos" => Some((
            "security".into(),
            vec![
                "find-generic-password".into(),
                "-s".into(), service.into(),
                "-a".into(), account.into(),
                "-w".into(),
            ],
        )),
        "linux" => Some((
            "secret-tool".into(),
            vec!["lookup".into(), "service".into(), service.into(), "account".into(), account.into()],
        )),
        _ => None,
    }
}

/// Read a keychain secret on the current OS. `None` if absent / unavailable /
/// unsupported platform.
fn read_secret(service: &str, account: &str) -> Option<String> {
    let (program, args) = read_command(std::env::consts::OS, service, account)?;
    let output = Command::new(program).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() { None } else { Some(value) }
}

/// The device mTLS identity for `origin`, read from the keychain. The stored value
/// is a JSON `{cert, key, ca}` blob the enrollment writer put under
/// (`com.hotsheet.plugin.mtls`, `<origin>`).
pub fn read_identity(origin: &str) -> Result<MtlsIdentity, String> {
    let raw = read_secret(&service_name(MTLS_PLUGIN_ID), origin)
        .ok_or_else(|| format!("no mTLS identity in the keychain for {origin}"))?;
    parse_identity(&raw)
}

/// Pure: parse the stored JSON blob into an `MtlsIdentity`. Separated so the
/// parse is unit-testable without touching the keychain.
pub fn parse_identity(raw: &str) -> Result<MtlsIdentity, String> {
    #[derive(serde::Deserialize)]
    struct Stored {
        cert: String,
        key: String,
        ca: String,
    }
    let s: Stored = serde_json::from_str(raw).map_err(|e| format!("parse keychain identity: {e}"))?;
    if s.cert.is_empty() || s.key.is_empty() || s.ca.is_empty() {
        return Err("keychain identity is missing cert/key/ca".into());
    }
    Ok(MtlsIdentity { cert_pem: s.cert, key_pem: s.key, ca_pem: s.ca })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_command_macos_uses_security_find_generic_password() {
        let (prog, args) = read_command("macos", "com.hotsheet.plugin.mtls", "https://h:1").unwrap();
        assert_eq!(prog, "security");
        assert_eq!(
            args,
            vec!["find-generic-password", "-s", "com.hotsheet.plugin.mtls", "-a", "https://h:1", "-w"],
        );
    }

    #[test]
    fn read_command_linux_uses_secret_tool_lookup() {
        let (prog, args) = read_command("linux", "svc", "acct").unwrap();
        assert_eq!(prog, "secret-tool");
        assert_eq!(args, vec!["lookup", "service", "svc", "account", "acct"]);
    }

    #[test]
    fn read_command_unsupported_platform_is_none() {
        assert!(read_command("windows", "svc", "acct").is_none());
    }

    #[test]
    fn parse_identity_reads_the_json_blob() {
        let raw = r#"{"cert":"C","key":"K","ca":"A"}"#;
        let id = parse_identity(raw).unwrap();
        assert_eq!(id.cert_pem, "C");
        assert_eq!(id.key_pem, "K");
        assert_eq!(id.ca_pem, "A");
    }

    #[test]
    fn parse_identity_rejects_bad_json_and_missing_fields() {
        assert!(parse_identity("not json").is_err());
        assert!(parse_identity(r#"{"cert":"C","key":"","ca":"A"}"#).is_err());
    }
}
