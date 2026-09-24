//! Who may use this proxy (issue #54, section 5).
//!
//! The atomic.place proxy admits agents that have a SaaS account, and checks
//! their tier; how an agent is linked to an account is decided in
//! ontola/atomic-saas#138. A self-hosted proxy admits every agent, or keeps
//! its own list. Both are an [`AccessPolicy`]: the proxy asks it at
//! `/connect/redeem` and on every signed request, always about the
//! connection's **owner** (a delegated app agent or a frame is checked
//! against the owner it acts for), so freemium limits count per owner.
//!
//! The default, [`EnvAccessPolicy`], admits everyone except the agents in
//! `REVOKED_SUBJECTS`, and, when `ALLOWED_AGENTS` is set, only those.
use std::{collections::HashSet, future::Future, pin::Pin};

use crate::agent_id::{self, AgentId};

/// The answer to "may this owner use the proxy now?".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Access {
    Allowed,
    /// Refused, with a reason safe to show the caller.
    Denied(String),
}

/// A pluggable admission check. Implementations should answer quickly (the
/// check runs on every request) and cache lookups as they see fit.
pub trait AccessPolicy: Send + Sync + 'static {
    fn check<'a>(&'a self, owner: &'a AgentId)
        -> Pin<Box<dyn Future<Output = Access> + Send + 'a>>;
}

/// Admits every agent. Useful for a self-hosted proxy and in tests.
pub struct AllowAll;

impl AccessPolicy for AllowAll {
    fn check<'a>(
        &'a self,
        _owner: &'a AgentId,
    ) -> Pin<Box<dyn Future<Output = Access> + Send + 'a>> {
        Box::pin(async { Access::Allowed })
    }
}

/// The policy configured from the environment: a denylist and an optional
/// allowlist, both of agent ids in any accepted spelling.
pub struct EnvAccessPolicy {
    allowed: Option<HashSet<String>>,
    revoked: HashSet<String>,
}

impl EnvAccessPolicy {
    /// Ids that do not parse as agent ids are ignored (and logged), so a stale
    /// entry cannot lock everyone out or in.
    pub fn new(allowed: Option<Vec<String>>, revoked: Vec<String>) -> Self {
        let canonical = |ids: Vec<String>| -> HashSet<String> {
            ids.into_iter()
                .filter_map(|id| match agent_id::parse(id.trim()) {
                    Some(agent) => Some(agent.as_str().to_owned()),
                    None => {
                        tracing::warn!(%id, "ignoring an access-list entry that is not an atomic:agent id");
                        None
                    }
                })
                .collect()
        };
        Self {
            allowed: allowed.map(canonical),
            revoked: canonical(revoked),
        }
    }
}

impl AccessPolicy for EnvAccessPolicy {
    fn check<'a>(
        &'a self,
        owner: &'a AgentId,
    ) -> Pin<Box<dyn Future<Output = Access> + Send + 'a>> {
        let answer = if self.revoked.contains(owner.as_str()) {
            Access::Denied("this agent is revoked on this proxy".into())
        } else if self
            .allowed
            .as_ref()
            .is_some_and(|allowed| !allowed.contains(owner.as_str()))
        {
            Access::Denied("this agent is not on this proxy's allowlist".into())
        } else {
            Access::Allowed
        };
        Box::pin(async move { answer })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_id::test_signer::Agent;

    #[tokio::test]
    async fn the_env_policy_canonicalizes_and_applies_both_lists() {
        let (a, b, c) = (Agent::new(1), Agent::new(2), Agent::new(3));
        let parse = |agent: &Agent| agent_id::parse(&agent.id()).unwrap();
        let open = EnvAccessPolicy::new(None, vec![b.legacy_id(), "garbage".into()]);
        assert_eq!(open.check(&parse(&a)).await, Access::Allowed);
        assert!(matches!(open.check(&parse(&b)).await, Access::Denied(_)));
        let closed = EnvAccessPolicy::new(Some(vec![a.legacy_id()]), vec![]);
        assert_eq!(closed.check(&parse(&a)).await, Access::Allowed);
        assert!(matches!(closed.check(&parse(&c)).await, Access::Denied(_)));
        assert_eq!(AllowAll.check(&parse(&c)).await, Access::Allowed);
    }
}
