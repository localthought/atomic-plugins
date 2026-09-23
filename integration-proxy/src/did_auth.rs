//! Ed25519 authentication against the DID a persistent connection is bound
//! to (issue #40).
//!
//! A connection's owner is an Atomic Data agent DID, `did:ad:agent:{pubkey}`,
//! where `{pubkey}` is the agent's 32-byte Ed25519 public key in base64. The
//! DID therefore carries its own verification key: nothing is resolved over
//! the network and nothing is pinned beside it. A key rotation is a new DID
//! and so a new connection.
//!
//! Two presentations are accepted, both verified against that key:
//!
//! - a **signed request**: the holder signs this exact request (method,
//!   path and query, body digest, timestamp). Single use: the proxy records
//!   a digest of the signed message in `used_challenges`.
//! - a **capability**: the holder signs `{connection_id, platform, exp}` and
//!   hands the token to a caller that cannot hold the key (a sandboxed
//!   frame). Reusable until `exp`, which may be at most
//!   [`MAX_CAPABILITY_LIFETIME_SECS`] ahead.
//!
//! Both signed messages start with a fixed, versioned prefix and contain
//! newlines, so neither can be mistaken for Atomic's own request signature
//! over `"{subject} {timestamp}"`, and neither can be replayed as the other.
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const DID_PREFIX: &str = "did:ad:agent:";
const REQUEST_DOMAIN: &str = "integration-proxy-request-v1";
const CAPABILITY_DOMAIN: &str = "integration-proxy-capability-v1";

/// How far a signed request's timestamp may be from the proxy's clock, either
/// way. Mirrors Atomic's `AUTH_MAX_AGE_MS` (`lib/src/authentication.rs`), and
/// is shorter than the ten-minute `used_challenges` retention, so a request
/// cannot outlive the record of its use.
pub const MAX_REQUEST_SKEW_MS: u64 = 5 * 60 * 1000;

/// The longest a capability may be valid for when presented. The proxy does
/// not mint capabilities, so it cannot stop a holder signing a longer one; it
/// refuses to honour it instead.
pub const MAX_CAPABILITY_LIFETIME_SECS: u64 = 15 * 60;

/// Decodes base64 the way Atomic Data does (`lib/src/agents.rs`
/// `decode_base64`): URL-safe or standard alphabet, padded or not.
fn decode_base64(value: &str) -> Option<Vec<u8>> {
    let standard: String = value
        .trim_end_matches('=')
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect();
    let pad = (4 - standard.len() % 4) % 4;
    STANDARD
        .decode(format!("{standard}{}", "=".repeat(pad)))
        .ok()
}

/// The Ed25519 key inside `did:ad:agent:{pubkey}`, or `None` for any other
/// identifier (a legacy HTTP agent subject, a test placeholder, a malformed
/// key). Such a connection can still be used with a rotating code, but not
/// with signature or capability auth.
pub fn agent_key(did: &str) -> Option<VerifyingKey> {
    let encoded = did.strip_prefix(DID_PREFIX)?;
    let bytes: [u8; 32] = decode_base64(encoded)?.try_into().ok()?;
    VerifyingKey::from_bytes(&bytes).ok()
}

fn verify(did: &str, message: &[u8], signature: &str) -> bool {
    let Some(key) = agent_key(did) else {
        return false;
    };
    let Some(signature) = decode_base64(signature)
        .and_then(|bytes| <[u8; 64]>::try_from(bytes).ok())
        .map(|bytes| Signature::from_bytes(&bytes))
    else {
        return false;
    };
    // Strict: rejects small-order keys and non-canonical signatures.
    key.verify_strict(message, &signature).is_ok()
}

/// The exact bytes a caller signs to authenticate one proxied request.
///
/// `path_and_query` is the request target as sent, e.g.
/// `/proxy/github-issues/repos/o/r/issues?state=all`, before any
/// percent-decoding.
pub fn request_message(
    connection_id: &str,
    method: &str,
    path_and_query: &str,
    timestamp_ms: u64,
    body: &[u8],
) -> String {
    let digest = Sha256::digest(body);
    let body_hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{REQUEST_DOMAIN}\n{connection_id}\n{}\n{path_and_query}\n{timestamp_ms}\n{body_hex}",
        method.to_ascii_uppercase()
    )
}

/// A value for `used_challenges` that is unique per signed message. Keyed on
/// the message rather than the signature, so a second valid encoding of the
/// same signature cannot slip past it.
pub fn replay_key(message: &str) -> String {
    format!(
        "connection-request:{}",
        URL_SAFE_NO_PAD.encode(Sha256::digest(message.as_bytes()))
    )
}

#[derive(Debug, PartialEq, Eq)]
pub enum RequestRejection {
    /// Timestamp missing, unparsable, or outside [`MAX_REQUEST_SKEW_MS`].
    Stale,
    /// Signature does not verify against the connection's DID, or the DID
    /// carries no usable key.
    BadSignature,
}

/// Verifies a signed request against the DID the connection is bound to.
/// Replay is checked separately by the caller, with [`replay_key`], because
/// it needs the database.
pub fn verify_request(
    did: &str,
    message: &str,
    timestamp_ms: u64,
    now_ms: u64,
    signature: &str,
) -> Result<(), RequestRejection> {
    if timestamp_ms.abs_diff(now_ms) > MAX_REQUEST_SKEW_MS {
        return Err(RequestRejection::Stale);
    }
    if !verify(did, message.as_bytes(), signature) {
        return Err(RequestRejection::BadSignature);
    }
    Ok(())
}

/// What a capability grants. `exp` is Unix seconds.
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CapabilityClaims {
    pub v: u8,
    pub connection_id: String,
    pub platform: String,
    pub exp: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CapabilityRejection {
    Malformed,
    /// Past `exp`. Distinguished so a holder knows to mint a new one.
    Expired,
    /// `exp` further ahead than [`MAX_CAPABILITY_LIFETIME_SECS`].
    TooLong,
    BadSignature,
}

fn capability_message(payload: &str) -> String {
    format!("{CAPABILITY_DOMAIN}\n{payload}")
}

/// Splits `<payload>.<signature>` and decodes the claims, without verifying.
/// The caller needs `connection_id` to find the DID to verify against.
pub fn parse_capability(
    token: &str,
) -> Result<(CapabilityClaims, &str, &str), CapabilityRejection> {
    let (payload, signature) = token
        .split_once('.')
        .ok_or(CapabilityRejection::Malformed)?;
    let claims: CapabilityClaims = URL_SAFE_NO_PAD
        .decode(payload)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or(CapabilityRejection::Malformed)?;
    if claims.v != 1 {
        return Err(CapabilityRejection::Malformed);
    }
    Ok((claims, payload, signature))
}

/// Checks a parsed capability's lifetime and signature. The caller also checks
/// `claims.platform` against the route and the connection.
pub fn verify_capability(
    did: &str,
    claims: &CapabilityClaims,
    payload: &str,
    signature: &str,
    now_secs: u64,
) -> Result<(), CapabilityRejection> {
    if !verify(did, capability_message(payload).as_bytes(), signature) {
        return Err(CapabilityRejection::BadSignature);
    }
    if claims.exp <= now_secs {
        return Err(CapabilityRejection::Expired);
    }
    if claims.exp - now_secs > MAX_CAPABILITY_LIFETIME_SECS {
        return Err(CapabilityRejection::TooLong);
    }
    Ok(())
}

/// Test-only signer: what an Atomic agent (or the node holding an app
/// agent's secret) does on its side.
#[cfg(test)]
pub mod test_signer {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    pub struct Agent(pub SigningKey);

    impl Agent {
        pub fn new(seed: u8) -> Self {
            Self(SigningKey::from_bytes(&[seed; 32]))
        }
        pub fn did(&self) -> String {
            format!(
                "{DID_PREFIX}{}",
                URL_SAFE_NO_PAD.encode(self.0.verifying_key().as_bytes())
            )
        }
        pub fn sign(&self, message: &str) -> String {
            URL_SAFE_NO_PAD.encode(self.0.sign(message.as_bytes()).to_bytes())
        }
        pub fn capability(&self, connection_id: &str, platform: &str, exp: u64) -> String {
            let payload = URL_SAFE_NO_PAD.encode(
                serde_json::to_vec(&CapabilityClaims {
                    v: 1,
                    connection_id: connection_id.into(),
                    platform: platform.into(),
                    exp,
                })
                .unwrap(),
            );
            let signature = self.sign(&capability_message(&payload));
            format!("{payload}.{signature}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_signer::Agent;
    use super::*;

    #[test]
    fn a_did_carries_its_own_key_in_either_base64_alphabet() {
        let agent = Agent::new(7);
        let key = agent.0.verifying_key();
        assert_eq!(agent_key(&agent.did()), Some(key));
        // Atomic's legacy standard-alphabet, padded form of the same key.
        let legacy = format!("{DID_PREFIX}{}", STANDARD.encode(key.as_bytes()));
        assert_eq!(agent_key(&legacy), Some(key));
    }

    #[test]
    fn identifiers_without_an_ed25519_key_are_not_signers() {
        for did in [
            "did:ad:agent:test",
            "did:ad:agent:",
            "https://example.com/agents/abc",
            "did:ad:agent:AAAA",
            "",
        ] {
            assert!(agent_key(did).is_none(), "{did}");
        }
    }

    #[test]
    fn a_signed_request_verifies_only_for_its_own_did_message_and_time() {
        let agent = Agent::new(1);
        let other = Agent::new(2);
        let now = 1_700_000_000_000;
        let message = request_message("conn", "get", "/proxy/p/items?a=1", now, b"");
        let signature = agent.sign(&message);
        assert_eq!(
            verify_request(&agent.did(), &message, now, now, &signature),
            Ok(())
        );
        assert_eq!(
            verify_request(&other.did(), &message, now, now, &signature),
            Err(RequestRejection::BadSignature)
        );
        let tampered = request_message("conn", "get", "/proxy/p/items?a=2", now, b"");
        assert_eq!(
            verify_request(&agent.did(), &tampered, now, now, &signature),
            Err(RequestRejection::BadSignature)
        );
        let with_body = request_message("conn", "get", "/proxy/p/items?a=1", now, b"{}");
        assert_eq!(
            verify_request(&agent.did(), &with_body, now, now, &signature),
            Err(RequestRejection::BadSignature)
        );
        assert_eq!(
            verify_request(
                &agent.did(),
                &message,
                now,
                now + MAX_REQUEST_SKEW_MS + 1,
                &signature
            ),
            Err(RequestRejection::Stale)
        );
        assert_eq!(
            verify_request(&agent.did(), &message, now, now, "not-a-signature"),
            Err(RequestRejection::BadSignature)
        );
    }

    #[test]
    fn request_messages_are_domain_separated_and_method_normalized() {
        let message = request_message("c", "post", "/proxy/p/x", 5, b"");
        assert!(message.starts_with("integration-proxy-request-v1\nc\nPOST\n/proxy/p/x\n5\n"));
        // Ends in a hex digest, never a bare number, so it cannot be read as
        // Atomic's "{subject} {timestamp}".
        assert!(
            message.ends_with("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        );
        assert_ne!(
            replay_key(&message),
            replay_key(&request_message("c", "post", "/proxy/p/x", 6, b""))
        );
    }

    #[test]
    fn a_capability_is_bound_to_its_signer_and_lifetime() {
        let agent = Agent::new(3);
        let now = 1_700_000_000;
        let token = agent.capability("conn", "platform", now + 60);
        let (claims, payload, signature) = parse_capability(&token).unwrap();
        assert_eq!(claims.connection_id, "conn");
        assert_eq!(claims.platform, "platform");
        assert_eq!(
            verify_capability(&agent.did(), &claims, payload, signature, now),
            Ok(())
        );
        assert_eq!(
            verify_capability(&Agent::new(4).did(), &claims, payload, signature, now),
            Err(CapabilityRejection::BadSignature)
        );
        assert_eq!(
            verify_capability(&agent.did(), &claims, payload, signature, now + 60),
            Err(CapabilityRejection::Expired)
        );

        let long = agent.capability("conn", "platform", now + MAX_CAPABILITY_LIFETIME_SECS + 1);
        let (claims, payload, signature) = parse_capability(&long).unwrap();
        assert_eq!(
            verify_capability(&agent.did(), &claims, payload, signature, now),
            Err(CapabilityRejection::TooLong)
        );
    }

    #[test]
    fn a_capability_signature_is_not_a_request_signature() {
        let agent = Agent::new(5);
        let token = agent.capability("conn", "platform", 100);
        let (_, payload, signature) = parse_capability(&token).unwrap();
        // The capability's signature over its payload does not verify as a
        // request signature over the same text, nor vice versa.
        assert_eq!(
            verify_request(&agent.did(), payload, 0, 0, signature),
            Err(RequestRejection::BadSignature)
        );
    }

    #[test]
    fn malformed_capabilities_are_rejected_before_any_lookup() {
        for token in [
            "",
            "no-dot",
            "!!!.sig",
            &format!(
                "{}.sig",
                URL_SAFE_NO_PAD.encode(br#"{"v":2,"connection_id":"c","platform":"p","exp":1}"#)
            ),
            &format!(
                "{}.sig",
                URL_SAFE_NO_PAD
                    .encode(br#"{"v":1,"connection_id":"c","platform":"p","exp":1,"extra":true}"#)
            ),
        ] {
            assert_eq!(
                parse_capability(token).err(),
                Some(CapabilityRejection::Malformed),
                "{token}"
            );
        }
    }
}
