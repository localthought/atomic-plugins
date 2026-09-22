//! Standalone browser login through a catalog-selected API identity endpoint.
//!
//! This deliberately does not create a connection credential, handoff, or
//! tenant secret. `oauth` owns the one-use OAuth state and dispatches its
//! sealed `api-login-v1:` context here after consuming it.

use crate::providers::Provider;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{Redirect, Response},
};
use axum_extra::extract::{
    cookie::{Cookie, SameSite},
    PrivateCookieJar,
};
use serde::{Deserialize, Serialize};

pub const CONTEXT_PREFIX: &str = "api-login-v1:";
pub const CONTEXT_AAD: &[u8] = b"api-login-v1";
const BINDING_COOKIE: &str = "api_login_binding";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ApiLoginContext {
    /// Random browser binding, checked after the OAuth state has been consumed.
    pub binding: String,
    /// Either `/` or a previously validated, encrypted `/connect?...` return.
    pub return_target: String,
}

impl ApiLoginContext {
    pub fn new(binding: String, return_target: Option<String>) -> Self {
        Self {
            binding,
            return_target: return_target.unwrap_or_else(|| "/".into()),
        }
    }
}

fn binding_cookie(value: String) -> Cookie<'static> {
    Cookie::build((BINDING_COOKIE, value))
        .path("/")
        .secure(true)
        .http_only(true)
        .same_site(SameSite::Lax)
        .max_age(time::Duration::minutes(10))
        .build()
}

pub(crate) fn has_binding(jar: &PrivateCookieJar, context: &ApiLoginContext) -> bool {
    jar.get(BINDING_COOKIE)
        .is_some_and(|cookie| cookie.value() == context.binding)
}

fn clear_binding(jar: PrivateCookieJar) -> PrivateCookieJar {
    jar.remove(Cookie::build(BINDING_COOKIE).path("/").build())
}

fn valid_return(target: &str) -> bool {
    target == "/" || crate::connect::cancel_login_target(target).is_some()
}

#[derive(Deserialize)]
struct Token {
    access_token: String,
}

fn error() -> Response {
    crate::connect::protected((StatusCode::BAD_REQUEST, "API login could not be started"))
}

/// Start a standalone browser session from a catalog-trusted identity API.
/// No request query can influence the post-login destination: it is either the
/// encrypted, revalidated connect return or the local root.
pub async fn start(
    Path(platform): Path<String>,
    State(state): State<crate::AppState>,
    jar: PrivateCookieJar,
) -> Response {
    if crate::session::read_session(&jar).is_some()
        || state.catalog.tenant_identity(&platform).is_err()
    {
        return error();
    }
    // The helper reparses the encrypted return as a full ConnectRequest.
    let context = ApiLoginContext::new(
        crate::connect::random(),
        crate::connect::validated_login_return(&jar),
    );
    match crate::oauth::begin_login(&state, &platform, &context).await {
        Ok(url) => crate::connect::protected((
            crate::session::clear_connect_redirect(jar).add(binding_cookie(context.binding)),
            Redirect::to(&url),
        )),
        Err(()) => error(),
    }
}

/// Finish a standalone API login after `oauth` atomically consumed its state.
/// This path deliberately discards provider tokens after identity lookup.
pub async fn callback(
    platform: &str,
    state: &crate::AppState,
    stored: crate::security::OAuthState,
    code: Option<String>,
    oauth_error: Option<String>,
    jar: PrivateCookieJar,
) -> Response {
    let Some(security) = &state.security else {
        return error();
    };
    if stored.provider != platform
        || !stored.tenant_id.is_empty()
        || !stored.user_id.is_empty()
        || crate::session::read_session(&jar).is_some()
    {
        return error();
    }
    let Some(sealed) = stored
        .context
        .as_deref()
        .and_then(|value| value.strip_prefix(CONTEXT_PREFIX))
    else {
        return error();
    };
    let Some(bytes) = security.open(sealed, CONTEXT_AAD) else {
        return error();
    };
    let Ok(context) = serde_json::from_slice::<ApiLoginContext>(&bytes) else {
        return error();
    };
    if !has_binding(&jar, &context) || !valid_return(&context.return_target) {
        return error();
    }
    if oauth_error.is_some() || code.is_none() {
        let target = crate::connect::cancel_login_target(&context.return_target)
            .unwrap_or_else(|| "/".into());
        return crate::connect::protected((
            crate::connect::clear_consent(clear_binding(jar)),
            Redirect::to(&target),
        ));
    }
    let Ok(provider) = Provider::configured(&state.catalog, platform) else {
        return error();
    };
    #[cfg(test)]
    let provider = {
        let mut provider = provider;
        if let Some(upstream) = &state.test_upstream {
            provider.provider.token_url = format!("{}/token", upstream.trim_end_matches('/'));
        }
        provider
    };
    let callback = format!(
        "{}/oauth/{}/callback",
        state.base_url.trim_end_matches('/'),
        platform
    );
    let mut params = vec![
        ("grant_type", "authorization_code"),
        ("code", code.as_deref().unwrap()),
        ("redirect_uri", callback.as_str()),
    ];
    if provider.provider.use_pkce {
        params.push(("code_verifier", stored.verifier.as_str()));
    }
    let response = match provider
        .token_request(&state.http_client, &params)
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return error(),
    };
    let Ok(response) = response.error_for_status() else {
        return error();
    };
    let Ok(token) = response.json::<Token>().await else {
        return error();
    };
    let Ok(operation) = state.catalog.tenant_identity(platform) else {
        return error();
    };
    #[cfg(test)]
    let operation = {
        let mut operation = operation;
        if let Some(upstream) = &state.test_upstream {
            operation.url = format!("{}/identity", upstream.trim_end_matches('/'))
                .parse()
                .expect("test URL");
        }
        operation
    };
    let mut response = match state
        .identity_http_client
        .get(operation.url.clone())
        .bearer_auth(&token.access_token)
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => response,
        _ => return error(),
    };
    if response
        .content_length()
        .is_some_and(|length| length > 65_536)
    {
        return error();
    }
    let mut bytes = Vec::new();
    loop {
        let Ok(chunk) = response.chunk().await else {
            return error();
        };
        let Some(chunk) = chunk else { break };
        if bytes.len() + chunk.len() > 65_536 {
            return error();
        }
        bytes.extend_from_slice(&chunk);
    }
    let Ok(body) = serde_json::from_slice(&bytes) else {
        return error();
    };
    let Ok(identity) = crate::identity::resolve(&operation, &body, &provider.client_id) else {
        return error();
    };
    let subject =
        match identity.legacy_subject_if_matches(state.app_auth_identity_namespace.as_deref()) {
            Ok(Some(subject)) => subject,
            Ok(None) => identity.canonical(),
            Err(_) => return error(),
        };
    if security.is_revoked(&subject, "") {
        return error();
    }
    let email = identity.email.unwrap_or_default();
    let name = identity.name.unwrap_or_else(|| email.clone());
    let mut user = crate::session::SessionUser::new(subject, email, name, identity.picture);
    user.identity_label = Some(platform.into());
    crate::connect::protected((
        crate::session::set_session(clear_binding(jar), &user),
        Redirect::to(&context.return_target),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_uses_root_only_when_no_validated_return_was_supplied() {
        assert_eq!(
            ApiLoginContext::new("binding".into(), None).return_target,
            "/"
        );
        assert_eq!(
            ApiLoginContext::new(
                "binding".into(),
                Some("/connect?platform=google-calendar".into())
            )
            .return_target,
            "/connect?platform=google-calendar"
        );
    }

    #[test]
    fn context_domain_is_distinct_from_connection_oauth() {
        assert_ne!(CONTEXT_AAD, b"platform-oauth-v1");
        assert!(CONTEXT_PREFIX.starts_with("api-login-"));
    }
}
