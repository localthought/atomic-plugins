//! Atomic request signatures, version 2 (issue #54, section 3).
//!
//! Every signed request to the proxy carries Atomic's own headers:
//!
//! | header | value |
//! |---|---|
//! | `x-atomic-agent` | the signer, `atomic:agent:<key>` (or `did:ad:agent:<key>`) |
//! | `x-atomic-public-key` | the signer's Ed25519 key, base64 |
//! | `x-atomic-timestamp` | Unix milliseconds, decimal |
//! | `x-atomic-signature` | Ed25519 signature, base64, over the message below |
//! | `x-atomic-signature-version` | `2` |
//!
//! The signed message is five lines joined by `\n`, with no trailing newline:
//!
//! ```text
//! atomic-request-v2
//! {METHOD}
//! {full URL, including query}
//! {timestamp, Unix ms}
//! {sha-256 hex of the body}
//! ```
//!
//! The proxy accepts version 2 only. Atomic's version 1 message
//! (`"{URL} {timestamp}"`) covers neither the method nor the body, and v1
//! proofs are deliberately reusable for five minutes, so a captured one could
//! be resent with a different body. A request without the version header, or
//! with any other version, is refused; nothing falls back to v1.
//!
//! "Full URL" is the proxy's public origin, `BASE_URL`, followed by the
//! request's path and query exactly as they arrived. It is never rebuilt from
//! the `Host` header or the connection's scheme: behind TLS termination
//! (Heroku) the process sees plain HTTP and a rewritten host.
use sha2::{Digest, Sha256};

use crate::agent_id::{self, AgentId};
use crate::api_error::ApiError;

pub const AGENT_HEADER: &str = "x-atomic-agent";
pub const PUBLIC_KEY_HEADER: &str = "x-atomic-public-key";
pub const TIMESTAMP_HEADER: &str = "x-atomic-timestamp";
pub const SIGNATURE_HEADER: &str = "x-atomic-signature";
pub const VERSION_HEADER: &str = "x-atomic-signature-version";

const DOMAIN: &str = "atomic-request-v2";

/// How far a signed request's timestamp may be from the proxy's clock, either
/// way (decision 5). Shorter than half the ten-minute `used_challenges`
/// retention, so a proof cannot outlive the record of its use.
pub const MAX_SKEW_MS: u64 = 5 * 60 * 1000;

/// Lowercase hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The exact message a v2 signature covers.
pub fn message(method: &str, url: &str, timestamp_ms: &str, body: &[u8]) -> String {
    format!(
        "{DOMAIN}\n{}\n{url}\n{timestamp_ms}\n{}",
        method.to_ascii_uppercase(),
        sha256_hex(body)
    )
}

/// The URL a client signs for a request that arrived with `path_and_query`,
/// given the configured public base URL.
pub fn signed_url(base_url: &str, path_and_query: &str) -> String {
    format!("{}{path_and_query}", base_url.trim_end_matches('/'))
}

/// A signature that checked out, not yet recorded as used.
#[derive(Debug)]
pub struct Verified {
    pub agent: AgentId,
    /// The key to spend in `used_challenges`; see [`crate::security::Security::consume_nonce`].
    pub replay_key: String,
}

/// Verifies a request's v2 signature: version, agent id, key binding,
/// timestamp and signature. Replay is checked by the caller with
/// [`Verified::replay_key`], because it needs the database.
pub fn verify(
    headers: &axum::http::HeaderMap,
    method: &str,
    url: &str,
    body: &[u8],
    now_ms: u64,
) -> Result<Verified, ApiError> {
    let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
    let (Some(agent), Some(public_key), Some(timestamp), Some(signature)) = (
        header(AGENT_HEADER),
        header(PUBLIC_KEY_HEADER),
        header(TIMESTAMP_HEADER),
        header(SIGNATURE_HEADER),
    ) else {
        return Err(ApiError::MissingSignature);
    };
    if header(VERSION_HEADER) != Some("2") {
        return Err(ApiError::UnsupportedSignatureVersion);
    }
    let agent = agent_id::parse(agent).ok_or(ApiError::InvalidAgent)?;
    let key_agent = agent_id::from_public_key(public_key).ok_or(ApiError::InvalidAgent)?;
    if agent != key_agent {
        return Err(ApiError::AgentKeyMismatch);
    }
    // Digits only: `u64::from_str` would also take a leading '+', which would
    // give one timestamp two spellings in the signed message.
    let timestamp_ms = Some(timestamp)
        .filter(|t| !t.is_empty() && t.len() <= 16 && t.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|t| t.parse::<u64>().ok())
        .ok_or(ApiError::StaleTimestamp)?;
    if timestamp_ms.abs_diff(now_ms) > MAX_SKEW_MS {
        return Err(ApiError::StaleTimestamp);
    }
    let message = message(method, url, timestamp, body);
    if !agent.verify(message.as_bytes(), signature) {
        return Err(ApiError::BadSignature);
    }
    Ok(Verified {
        agent,
        replay_key: replay_key(&message),
    })
}

/// A value for `used_challenges` that is unique per signed message. Keyed on
/// the message rather than the signature, so a second valid encoding of the
/// same signature cannot slip past it.
pub fn replay_key(message: &str) -> String {
    format!("atomic-request-v2:{}", sha256_hex(message.as_bytes()))
}

/// Verifies a request's v2 signature against the proxy's public URL for it,
/// then spends it: a signed request is accepted once.
pub async fn authenticate(
    state: &crate::AppState,
    security: &crate::security::Security,
    method: &axum::http::Method,
    uri: &axum::http::Uri,
    headers: &axum::http::HeaderMap,
    body: &[u8],
) -> Result<AgentId, ApiError> {
    let path_and_query = uri.path_and_query().map_or(uri.path(), |p| p.as_str());
    let url = signed_url(&state.base_url, path_and_query);
    let verified = verify(headers, method.as_str(), &url, body, crate::now_ms())?;
    match security.consume_nonce(&verified.replay_key).await {
        Ok(true) => Ok(verified.agent),
        Ok(false) => Err(ApiError::Replayed),
        Err(_) => Err(ApiError::Unavailable),
    }
}

/// Test-only: the headers an Atomic client sends for a v2-signed request.
#[cfg(test)]
pub fn test_headers(
    agent: &crate::agent_id::test_signer::Agent,
    method: &str,
    url: &str,
    timestamp_ms: u64,
    body: &[u8],
) -> Vec<(&'static str, String)> {
    let message = message(method, url, &timestamp_ms.to_string(), body);
    vec![
        (AGENT_HEADER, agent.id()),
        (PUBLIC_KEY_HEADER, agent.public_key()),
        (TIMESTAMP_HEADER, timestamp_ms.to_string()),
        (SIGNATURE_HEADER, agent.sign(message.as_bytes())),
        (VERSION_HEADER, "2".to_string()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_id::test_signer::Agent;
    use axum::http::{HeaderMap, HeaderValue};

    const NOW: u64 = 1_790_000_000_000;
    const URL: &str = "https://proxy.example/proxy/conn/github-issues/repos/o/r/issues?state=all";

    fn headers(pairs: Vec<(&'static str, String)>) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(name, HeaderValue::from_str(&value).unwrap());
        }
        map
    }

    fn signed(agent: &Agent) -> HeaderMap {
        headers(test_headers(agent, "POST", URL, NOW, b"{}"))
    }

    #[test]
    fn the_message_matches_the_specified_layout() {
        assert_eq!(
            message("get", "https://p.example/x?y=1", "1700000000000", b""),
            "atomic-request-v2\nGET\nhttps://p.example/x?y=1\n1700000000000\n\
             e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"{}"),
            "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
        );
    }

    #[test]
    fn the_signed_url_comes_from_base_url_not_the_host_header() {
        assert_eq!(
            signed_url("https://proxy.example/", "/proxy/c/p/x?a=1"),
            "https://proxy.example/proxy/c/p/x?a=1"
        );
        assert_eq!(
            signed_url("https://proxy.example", "/connect/redeem"),
            "https://proxy.example/connect/redeem"
        );
    }

    #[test]
    fn a_valid_v2_signature_verifies_and_names_the_canonical_agent() {
        let agent = Agent::new(1);
        let verified = verify(&signed(&agent), "POST", URL, b"{}", NOW).unwrap();
        assert_eq!(verified.agent.as_str(), agent.id());
        // The legacy spelling of the same key is the same agent.
        let mut legacy = test_headers(&agent, "POST", URL, NOW, b"{}");
        legacy[0].1 = agent.legacy_id();
        let verified = verify(&headers(legacy), "POST", URL, b"{}", NOW).unwrap();
        assert_eq!(verified.agent.as_str(), agent.id());
    }

    #[test]
    fn every_signed_part_is_covered() {
        let agent = Agent::new(1);
        let signed = signed(&agent);
        for (method, url, body) in [
            ("PUT", URL, &b"{}"[..]),
            (
                "POST",
                "https://proxy.example/proxy/conn/github-issues/repos/o/r/issues?state=open",
                b"{}",
            ),
            (
                "POST",
                "https://other-proxy.example/proxy/conn/github-issues/repos/o/r/issues?state=all",
                b"{}",
            ),
            (
                "POST",
                "http://proxy.example/proxy/conn/github-issues/repos/o/r/issues?state=all",
                b"{}",
            ),
            ("POST", URL, b"{\"agent\":\"attacker\"}"),
            ("POST", URL, b""),
        ] {
            assert_eq!(
                verify(&signed, method, url, body, NOW).unwrap_err(),
                ApiError::BadSignature,
                "{method} {url} {body:?}"
            );
        }
    }

    #[test]
    fn version_1_and_unknown_versions_are_refused_without_fallback() {
        let agent = Agent::new(1);
        for version in [None, Some("1"), Some("3"), Some(""), Some(" 2")] {
            let mut pairs = test_headers(&agent, "POST", URL, NOW, b"{}");
            pairs.pop();
            if let Some(version) = version {
                pairs.push((VERSION_HEADER, version.to_string()));
            }
            assert_eq!(
                verify(&headers(pairs), "POST", URL, b"{}", NOW).unwrap_err(),
                ApiError::UnsupportedSignatureVersion,
                "{version:?}"
            );
        }
        // A genuine v1 signature ("{URL} {ts}") with the v2 header is just a
        // bad signature.
        let v1 = agent.sign(format!("{URL} {NOW}").as_bytes());
        let mut pairs = test_headers(&agent, "POST", URL, NOW, b"{}");
        pairs[3].1 = v1;
        assert_eq!(
            verify(&headers(pairs), "POST", URL, b"{}", NOW).unwrap_err(),
            ApiError::BadSignature
        );
    }

    #[test]
    fn missing_headers_are_reported_as_missing() {
        let agent = Agent::new(1);
        for skip in 0..4 {
            let mut pairs = test_headers(&agent, "POST", URL, NOW, b"{}");
            pairs.remove(skip);
            assert_eq!(
                verify(&headers(pairs), "POST", URL, b"{}", NOW).unwrap_err(),
                ApiError::MissingSignature
            );
        }
        assert_eq!(
            verify(&HeaderMap::new(), "GET", URL, b"", NOW).unwrap_err(),
            ApiError::MissingSignature
        );
    }

    #[test]
    fn the_agent_must_be_the_key_in_the_public_key_header() {
        let agent = Agent::new(1);
        let other = Agent::new(2);
        // Signed by `other`, but claiming to be `agent`.
        let mut pairs = test_headers(&other, "POST", URL, NOW, b"{}");
        pairs[0].1 = agent.id();
        assert_eq!(
            verify(&headers(pairs), "POST", URL, b"{}", NOW).unwrap_err(),
            ApiError::AgentKeyMismatch
        );
        for bad_agent in [
            "https://atomicdata.dev/agents/someone".to_string(),
            "atomic:agent:nope".to_string(),
        ] {
            let mut pairs = test_headers(&agent, "POST", URL, NOW, b"{}");
            pairs[0].1 = bad_agent.clone();
            assert_eq!(
                verify(&headers(pairs), "POST", URL, b"{}", NOW).unwrap_err(),
                ApiError::InvalidAgent,
                "{bad_agent}"
            );
        }
        let mut pairs = test_headers(&agent, "POST", URL, NOW, b"{}");
        pairs[1].1 = "AAAA".into();
        assert_eq!(
            verify(&headers(pairs), "POST", URL, b"{}", NOW).unwrap_err(),
            ApiError::InvalidAgent
        );
    }

    #[test]
    fn timestamps_must_be_within_five_minutes_either_way() {
        let agent = Agent::new(1);
        for (offset, ok) in [
            (0i64, true),
            (MAX_SKEW_MS as i64, true),
            (-(MAX_SKEW_MS as i64), true),
            (MAX_SKEW_MS as i64 + 1, false),
            (-(MAX_SKEW_MS as i64) - 1, false),
        ] {
            let ts = (NOW as i64 + offset) as u64;
            let result = verify(
                &headers(test_headers(&agent, "GET", URL, ts, b"")),
                "GET",
                URL,
                b"",
                NOW,
            );
            assert_eq!(result.is_ok(), ok, "offset {offset}");
            if !ok {
                assert_eq!(result.unwrap_err(), ApiError::StaleTimestamp);
            }
        }
        for bad in ["", "+1790000000000", "1.7e12", "-5", "abc"] {
            let mut pairs = test_headers(&agent, "GET", URL, NOW, b"");
            pairs[2].1 = bad.into();
            assert_eq!(
                verify(&headers(pairs), "GET", URL, b"", NOW).unwrap_err(),
                ApiError::StaleTimestamp,
                "{bad}"
            );
        }
    }

    /// Golden vectors shared with atomic-server (`lib/src/authentication_v2_vectors.json`
    /// on its `claude/atomic-signature-v2` branch, copied verbatim), so the
    /// signer and this verifier cannot drift apart unnoticed.
    #[test]
    fn atomic_server_v2_vectors_verify_here() {
        let vectors: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/atomic-request-v2-vectors.json"
        ))
        .unwrap();
        let vectors = vectors["vectors"].as_array().unwrap();
        assert!(!vectors.is_empty());
        for vector in vectors {
            let name = vector["name"].as_str().unwrap();
            let method = vector["method"].as_str().unwrap();
            let url = vector["url"].as_str().unwrap();
            let body = vector["body"].as_str().unwrap().as_bytes();
            let timestamp = vector["timestamp"].as_u64().unwrap();
            assert_eq!(sha256_hex(body), vector["body_sha256_hex"], "{name}");
            assert_eq!(
                message(method, url, &timestamp.to_string(), body),
                vector["message"].as_str().unwrap(),
                "{name}"
            );
            let pairs = vec![
                (AGENT_HEADER, vector["agent"].as_str().unwrap().to_owned()),
                (
                    PUBLIC_KEY_HEADER,
                    vector["public_key"].as_str().unwrap().to_owned(),
                ),
                (TIMESTAMP_HEADER, timestamp.to_string()),
                (
                    SIGNATURE_HEADER,
                    vector["signature"].as_str().unwrap().to_owned(),
                ),
                (VERSION_HEADER, "2".to_owned()),
            ];
            let verified = verify(&headers(pairs), method, url, body, timestamp)
                .unwrap_or_else(|e| panic!("{name}: {e:?}"));
            assert_eq!(verified.agent.as_str(), vector["agent"], "{name}");
        }
    }

    #[test]
    fn replay_keys_differ_per_message() {
        let a = message("GET", URL, "1", b"");
        let b = message("GET", URL, "2", b"");
        assert_ne!(replay_key(&a), replay_key(&b));
        assert_eq!(replay_key(&a), replay_key(&a.clone()));
    }
}
