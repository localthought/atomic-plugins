//! Frame capabilities, version 2 (issue #54, section 3).
//!
//! A plugin frame runs third-party code in a null-origin iframe with no
//! storage, so it holds no durable key. When it opens it generates a
//! non-extractable key in memory; its page (which holds the user's key)
//! signs a short-lived capability bound to that key:
//!
//! ```text
//! Authorization: Capability <payload>.<sig>
//! payload = base64url(JSON claims), unpadded
//! sig     = owner's Ed25519 signature, base64, over
//!           "integration-proxy-capability-v2\n" + the JSON bytes
//! claims  = {"v":2,"connection_id","platform","aud","app","cnf","exp"}
//! ```
//!
//! - `aud`: the proxy origin (`BASE_URL`'s scheme, host and port);
//! - `app`: the installation's app `atomic:agent`, which must hold a
//!   delegation for the connection at the time of every request;
//! - `cnf`: the frame's temporary key as an agent id, `atomic:agent:<key>`;
//! - `exp`: Unix seconds, at most [`MAX_LIFETIME_SECS`] ahead.
//!
//! The capability alone authorises nothing: every request must also carry a
//! v2 request signature (see [`crate::signature`]) made with `cnf`'s key. A
//! copied capability is useless without the frame's private key.
//!
//! The v1 capability of draft PR #72 (a bearer token, never used by a client)
//! is gone.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};

use crate::agent_id::{self, AgentId};
use crate::api_error::ApiError;

pub const DOMAIN: &str = "integration-proxy-capability-v2";

/// The longest a capability may be valid for when presented (decision 5). The
/// proxy does not mint capabilities, so it cannot stop a page signing a longer
/// one; it refuses to honour it instead.
pub const MAX_LIFETIME_SECS: u64 = 15 * 60;

/// What a capability says, as signed.
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Claims {
    pub v: u8,
    pub connection_id: String,
    pub platform: String,
    pub aud: String,
    pub app: String,
    pub cnf: String,
    pub exp: u64,
}

/// A capability whose structure is sound, not yet verified.
#[derive(Debug)]
pub struct Parsed {
    pub claims: Claims,
    pub app: AgentId,
    pub cnf: AgentId,
    json: Vec<u8>,
    signature: String,
}

/// The message the owner signs.
pub fn message(json: &[u8]) -> Vec<u8> {
    let mut message = Vec::with_capacity(DOMAIN.len() + 1 + json.len());
    message.extend_from_slice(DOMAIN.as_bytes());
    message.push(b'\n');
    message.extend_from_slice(json);
    message
}

/// Splits and decodes `<payload>.<sig>` and parses its agent ids. Rejects
/// anything but version 2.
pub fn parse(token: &str) -> Result<Parsed, ApiError> {
    if token.len() > 4096 {
        return Err(ApiError::InvalidCapability);
    }
    let (payload, signature) = token.split_once('.').ok_or(ApiError::InvalidCapability)?;
    let json = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| ApiError::InvalidCapability)?;
    let claims: Claims = serde_json::from_slice(&json).map_err(|_| ApiError::InvalidCapability)?;
    if claims.v != 2 {
        return Err(ApiError::InvalidCapability);
    }
    let app = agent_id::parse(&claims.app).ok_or(ApiError::InvalidCapability)?;
    let cnf = agent_id::parse(&claims.cnf).ok_or(ApiError::InvalidCapability)?;
    Ok(Parsed {
        claims,
        app,
        cnf,
        json,
        signature: signature.to_owned(),
    })
}

impl Parsed {
    /// Checks, in order: the owner's signature, the audience, and the
    /// lifetime. The caller then checks `connection_id` and `platform`
    /// against the route, the delegation for [`Parsed::app`], and the
    /// request signature by [`Parsed::cnf`].
    pub fn verify(&self, owner: &AgentId, audience: &str, now_secs: u64) -> Result<(), ApiError> {
        if !owner.verify(&message(&self.json), &self.signature) {
            return Err(ApiError::InvalidCapability);
        }
        if self.claims.aud != audience {
            return Err(ApiError::WrongAudience);
        }
        if self.claims.exp <= now_secs {
            return Err(ApiError::CapabilityExpired);
        }
        if self.claims.exp - now_secs > MAX_LIFETIME_SECS {
            return Err(ApiError::CapabilityTooLong);
        }
        Ok(())
    }
}

/// Test-only: what the page does to mint a capability.
#[cfg(test)]
pub fn mint(owner: &crate::agent_id::test_signer::Agent, claims: &Claims) -> String {
    let json = serde_json::to_vec(claims).unwrap();
    format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(&json),
        owner.sign(&message(&json))
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_id::test_signer::Agent;

    const NOW: u64 = 1_790_000_000;
    const AUD: &str = "https://proxy.example";

    fn claims(frame: &Agent, app: &Agent) -> Claims {
        Claims {
            v: 2,
            connection_id: "conn".into(),
            platform: "github-issues".into(),
            aud: AUD.into(),
            app: app.id(),
            cnf: frame.id(),
            exp: NOW + 600,
        }
    }

    #[test]
    fn a_capability_verifies_against_its_owner_and_names_app_and_frame() {
        let (owner, app, frame) = (Agent::new(1), Agent::new(2), Agent::new(3));
        let token = mint(&owner, &claims(&frame, &app));
        let parsed = parse(&token).unwrap();
        assert_eq!(parsed.app.as_str(), app.id());
        assert_eq!(parsed.cnf.as_str(), frame.id());
        let owner_id = agent_id::parse(&owner.id()).unwrap();
        assert_eq!(parsed.verify(&owner_id, AUD, NOW), Ok(()));
        // Signed by someone other than the connection owner.
        let other = agent_id::parse(&Agent::new(9).id()).unwrap();
        assert_eq!(
            parsed.verify(&other, AUD, NOW),
            Err(ApiError::InvalidCapability)
        );
    }

    #[test]
    fn legacy_ids_in_claims_are_canonicalized() {
        let (owner, app, frame) = (Agent::new(1), Agent::new(2), Agent::new(3));
        let mut c = claims(&frame, &app);
        c.app = app.legacy_id();
        c.cnf = frame.legacy_id();
        let parsed = parse(&mint(&owner, &c)).unwrap();
        assert_eq!(parsed.app.as_str(), app.id());
        assert_eq!(parsed.cnf.as_str(), frame.id());
    }

    #[test]
    fn audience_and_lifetime_are_enforced() {
        let (owner, app, frame) = (Agent::new(1), Agent::new(2), Agent::new(3));
        let owner_id = agent_id::parse(&owner.id()).unwrap();
        let parsed = parse(&mint(&owner, &claims(&frame, &app))).unwrap();
        for audience in [
            "https://other-proxy.example",
            "http://proxy.example",
            "https://proxy.example/",
        ] {
            assert_eq!(
                parsed.verify(&owner_id, audience, NOW),
                Err(ApiError::WrongAudience)
            );
        }
        assert_eq!(
            parsed.verify(&owner_id, AUD, NOW + 600),
            Err(ApiError::CapabilityExpired)
        );
        assert_eq!(parsed.verify(&owner_id, AUD, NOW + 599), Ok(()));
        let mut long = claims(&frame, &app);
        long.exp = NOW + MAX_LIFETIME_SECS + 1;
        let parsed = parse(&mint(&owner, &long)).unwrap();
        assert_eq!(
            parsed.verify(&owner_id, AUD, NOW),
            Err(ApiError::CapabilityTooLong)
        );
        long.exp = NOW + MAX_LIFETIME_SECS;
        let parsed = parse(&mint(&owner, &long)).unwrap();
        assert_eq!(parsed.verify(&owner_id, AUD, NOW), Ok(()));
    }

    #[test]
    fn tampering_with_any_claim_breaks_the_signature() {
        let (owner, app, frame) = (Agent::new(1), Agent::new(2), Agent::new(3));
        let owner_id = agent_id::parse(&owner.id()).unwrap();
        let token = mint(&owner, &claims(&frame, &app));
        let signature = token.split_once('.').unwrap().1;
        let mut forged = claims(&Agent::new(4), &app);
        forged.exp = NOW + 700;
        let json = serde_json::to_vec(&forged).unwrap();
        let tampered = format!("{}.{signature}", URL_SAFE_NO_PAD.encode(json));
        assert_eq!(
            parse(&tampered).unwrap().verify(&owner_id, AUD, NOW),
            Err(ApiError::InvalidCapability)
        );
    }

    #[test]
    fn a_capability_signature_is_not_a_request_signature() {
        let (owner, app, frame) = (Agent::new(1), Agent::new(2), Agent::new(3));
        let c = claims(&frame, &app);
        let json = serde_json::to_vec(&c).unwrap();
        // Signed without the domain prefix: refused.
        let token = format!("{}.{}", URL_SAFE_NO_PAD.encode(&json), owner.sign(&json));
        let owner_id = agent_id::parse(&owner.id()).unwrap();
        assert_eq!(
            parse(&token).unwrap().verify(&owner_id, AUD, NOW),
            Err(ApiError::InvalidCapability)
        );
    }

    #[test]
    fn malformed_and_other_version_capabilities_are_rejected_before_any_lookup() {
        let (app, frame) = (Agent::new(2), Agent::new(3));
        let encode =
            |value: serde_json::Value| format!("{}.sig", URL_SAFE_NO_PAD.encode(value.to_string()));
        let good = serde_json::to_value(claims(&frame, &app)).unwrap();
        let mut v1 = good.clone();
        v1["v"] = 1.into();
        let mut extra = good.clone();
        extra["scope"] = "all".into();
        let mut missing_cnf = good.clone();
        missing_cnf.as_object_mut().unwrap().remove("cnf");
        let mut bad_cnf = good.clone();
        bad_cnf["cnf"] = "did:ad:agent:test".into();
        let mut bad_app = good.clone();
        bad_app["app"] = "https://example.com/app".into();
        let mut string_exp = good;
        string_exp["exp"] = "1790000600".into();
        for token in [
            String::new(),
            "no-dot".into(),
            "!!!.sig".into(),
            // #72's v1 bearer shape.
            format!(
                "{}.sig",
                URL_SAFE_NO_PAD.encode(br#"{"v":1,"connection_id":"c","platform":"p","exp":1}"#)
            ),
            encode(v1),
            encode(extra),
            encode(missing_cnf),
            encode(bad_cnf),
            encode(bad_app),
            encode(string_exp),
            "a".repeat(5000),
        ] {
            assert_eq!(
                parse(&token).err(),
                Some(ApiError::InvalidCapability),
                "{token}"
            );
        }
    }
}
