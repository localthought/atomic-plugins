//! Agent identifiers: the one place that parses them (issue #54, decision 9).
//!
//! The proxy's account is an Atomic agent. Its id carries its own public key,
//! so verifying a signature needs no lookup. Accepted input forms:
//!
//! - `atomic:agent:<key>`, the canonical scheme since atomic-server#1585;
//! - `did:ad:agent:<key>`, the legacy alias atomic-server accepts forever.
//!
//! `<key>` is base64 in either alphabet (standard or URL-safe), padded or not,
//! as Atomic's own `decode_base64` accepts it. Only Ed25519 (a 32-byte key)
//! exists today; a new algorithm is added here, in [`parse`], and nowhere
//! else.
//!
//! Every id is converted to one canonical string before it is stored or
//! compared: `atomic:agent:` followed by the key in unpadded base64url, the
//! encoding Atomic's `encode_base64` emits. Two spellings of the same key are
//! the same agent; the proxy only ever outputs the canonical form.
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use ed25519_dalek::{Signature, VerifyingKey};

pub const ATOMIC_AGENT_PREFIX: &str = "atomic:agent:";
pub const DID_AD_AGENT_PREFIX: &str = "did:ad:agent:";

/// A parsed, verifiable agent id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentId {
    canonical: String,
    key: AgentKey,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum AgentKey {
    Ed25519(VerifyingKey),
}

impl AgentId {
    /// The canonical `atomic:agent:<base64url key>` form.
    pub fn as_str(&self) -> &str {
        &self.canonical
    }

    /// Verifies `signature` (base64, either alphabet) over `message`.
    /// Strict: rejects small-order keys and non-canonical signatures.
    pub fn verify(&self, message: &[u8], signature: &str) -> bool {
        match &self.key {
            AgentKey::Ed25519(key) => {
                let Some(bytes) =
                    decode_base64(signature).and_then(|bytes| <[u8; 64]>::try_from(bytes).ok())
                else {
                    return false;
                };
                key.verify_strict(message, &Signature::from_bytes(&bytes))
                    .is_ok()
            }
        }
    }
}

impl std::fmt::Display for AgentId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.canonical)
    }
}

/// Decodes base64 the way Atomic Data does (`lib/src/agents.rs`
/// `decode_base64`): URL-safe or standard alphabet, padded or not.
pub fn decode_base64(value: &str) -> Option<Vec<u8>> {
    let trimmed = value.trim_end_matches('=');
    if trimmed.len() + 2 < value.len() {
        return None;
    }
    let standard: String = trimmed
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

/// Parses any accepted spelling of an agent id. `None` for anything else:
/// an HTTP agent URL, another identifier kind, a malformed or non-Ed25519
/// key.
pub fn parse(id: &str) -> Option<AgentId> {
    let encoded = id
        .strip_prefix(ATOMIC_AGENT_PREFIX)
        .or_else(|| id.strip_prefix(DID_AD_AGENT_PREFIX))?;
    from_public_key(encoded)
}

/// The agent whose key is `public_key` (base64, either alphabet), as sent in
/// Atomic's `x-atomic-public-key` header.
pub fn from_public_key(public_key: &str) -> Option<AgentId> {
    if public_key.is_empty() || public_key.len() > 128 {
        return None;
    }
    let bytes: [u8; 32] = decode_base64(public_key)?.try_into().ok()?;
    let key = VerifyingKey::from_bytes(&bytes).ok()?;
    if key.is_weak() {
        return None;
    }
    Some(AgentId {
        canonical: format!("{ATOMIC_AGENT_PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes)),
        key: AgentKey::Ed25519(key),
    })
}

/// Test-only signer: what an Atomic agent does on its side.
#[cfg(test)]
pub mod test_signer {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    pub struct Agent(pub SigningKey);

    impl Agent {
        pub fn new(seed: u8) -> Self {
            Self(SigningKey::from_bytes(&[seed; 32]))
        }
        pub fn public_key(&self) -> String {
            URL_SAFE_NO_PAD.encode(self.0.verifying_key().as_bytes())
        }
        pub fn id(&self) -> String {
            format!("{ATOMIC_AGENT_PREFIX}{}", self.public_key())
        }
        pub fn legacy_id(&self) -> String {
            format!(
                "{DID_AD_AGENT_PREFIX}{}",
                STANDARD.encode(self.0.verifying_key().as_bytes())
            )
        }
        pub fn sign(&self, message: &[u8]) -> String {
            STANDARD.encode(self.0.sign(message).to_bytes())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_signer::Agent;
    use super::*;

    #[test]
    fn every_accepted_spelling_canonicalizes_to_one_atomic_agent_id() {
        let agent = Agent::new(7);
        let key = agent.0.verifying_key();
        let canonical = format!("atomic:agent:{}", URL_SAFE_NO_PAD.encode(key.as_bytes()));
        for spelling in [
            format!("atomic:agent:{}", URL_SAFE_NO_PAD.encode(key.as_bytes())),
            format!("atomic:agent:{}", STANDARD.encode(key.as_bytes())),
            format!(
                "atomic:agent:{}",
                STANDARD.encode(key.as_bytes()).trim_end_matches('=')
            ),
            format!("did:ad:agent:{}", URL_SAFE_NO_PAD.encode(key.as_bytes())),
            format!("did:ad:agent:{}", STANDARD.encode(key.as_bytes())),
            format!("did:ad:agent:{}=", URL_SAFE_NO_PAD.encode(key.as_bytes())),
        ] {
            let parsed = parse(&spelling).unwrap_or_else(|| panic!("{spelling}"));
            assert_eq!(parsed.as_str(), canonical, "{spelling}");
            assert_eq!(parsed, parse(&canonical).unwrap());
        }
        assert_eq!(
            from_public_key(&STANDARD.encode(key.as_bytes()))
                .unwrap()
                .as_str(),
            canonical
        );
    }

    #[test]
    fn a_key_that_needs_both_alphabets_to_differ_still_canonicalizes() {
        // Find a key whose standard encoding contains '+' or '/', so the two
        // alphabets really spell it differently.
        let agent = (0u8..=255)
            .map(Agent::new)
            .find(|agent| {
                let standard = STANDARD.encode(agent.0.verifying_key().as_bytes());
                standard.contains('+') || standard.contains('/')
            })
            .expect("some seed has a '+' or '/' in its standard encoding");
        let standard = STANDARD.encode(agent.0.verifying_key().as_bytes());
        let parsed = parse(&format!("did:ad:agent:{standard}")).unwrap();
        assert_eq!(parsed.as_str(), agent.id());
        assert!(!parsed.as_str().contains('+') && !parsed.as_str().contains('/'));
    }

    #[test]
    fn identifiers_without_an_ed25519_key_are_rejected() {
        for id in [
            "",
            "atomic:agent:",
            "did:ad:agent:",
            "did:ad:agent:test",
            "atomic:agent:pubkey123",
            "atomic:agent:AAAA",
            "https://example.com/agents/abc",
            "atomic:commit:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "atomic:node:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            // 32 zero bytes: a small-order (weak) Ed25519 point.
            "atomic:agent:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            // A valid key with excessive padding.
            &format!("{}===", Agent::new(1).id()),
            // Surrounding whitespace is not stripped.
            &format!(" {}", Agent::new(1).id()),
            &format!("ATOMIC:AGENT:{}", Agent::new(1).public_key()),
        ] {
            assert!(parse(id).is_none(), "{id:?}");
        }
    }

    #[test]
    fn signatures_verify_only_for_their_own_key_and_message() {
        let agent = Agent::new(3);
        let other = Agent::new(4);
        let parsed = parse(&agent.id()).unwrap();
        let signature = agent.sign(b"message");
        assert!(parsed.verify(b"message", &signature));
        // Either alphabet for the signature itself.
        let url_safe = URL_SAFE_NO_PAD.encode(STANDARD.decode(&signature).unwrap());
        assert!(parsed.verify(b"message", &url_safe));
        assert!(!parsed.verify(b"message2", &signature));
        assert!(!parse(&other.id()).unwrap().verify(b"message", &signature));
        assert!(!parsed.verify(b"message", "not-a-signature"));
        assert!(!parsed.verify(b"message", ""));
    }
}
