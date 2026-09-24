//! The provider side of connecting: sending the browser to the provider's
//! authorization endpoint, and its callback. The callback exchanges the code
//! for a token and hands it to the browser as a short-lived, PKCE-bound
//! handoff (see `connect.rs`); it never establishes who the user is, which
//! `/connect/redeem`'s signature does.
use crate::{providers::Provider, AppState};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Redirect, Response},
};
use axum_extra::extract::PrivateCookieJar;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use url::Url;

#[derive(Deserialize)]
pub struct Callback {
    code: Option<String>,
    error: Option<String>,
    state: String,
}
#[derive(Deserialize)]
struct Token {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
}
fn error() -> Response {
    crate::connect::protected((
        StatusCode::BAD_REQUEST,
        "OAuth request could not be completed",
    ))
}

fn append_provider_authorization(url: &mut Url, provider: &Provider, challenge: &str) {
    for (key, value) in &provider.authorization_params {
        url.query_pairs_mut().append_pair(key, value);
    }
    if provider.use_pkce {
        url.query_pairs_mut()
            .append_pair("code_challenge", challenge)
            .append_pair("code_challenge_method", "S256");
    }
}

fn callback_url(state: &AppState, name: &str) -> String {
    format!(
        "{}/oauth/{name}/callback",
        state.base_url.trim_end_matches('/')
    )
}

/// The provider authorization URL for `name`, with a new single-use state
/// row carrying the sealed `connect::OAuthContext`.
pub async fn begin(state: &AppState, name: &str, context: String) -> Result<String, ()> {
    let provider = Provider::configured(&state.catalog, name).map_err(|_| ())?;
    let security = state.security.as_ref().ok_or(())?;
    let oauth_state = crate::connect::random();
    let verifier = crate::connect::random();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    security
        .store_connect_state(
            &oauth_state,
            &crate::security::ConnectState {
                platform: name.into(),
                verifier,
                context,
            },
        )
        .await
        .map_err(|_| ())?;
    let mut url = Url::parse(&provider.provider.authorization_url).map_err(|_| ())?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &provider.client_id)
        .append_pair("redirect_uri", &callback_url(state, name))
        .append_pair("scope", &provider.provider.scopes.join(" "))
        .append_pair("state", &oauth_state);
    append_provider_authorization(&mut url, &provider.provider, &challenge);
    Ok(url.into())
}

pub async fn callback(
    Path(name): Path<String>,
    State(state): State<AppState>,
    Query(query): Query<Callback>,
    jar: PrivateCookieJar,
) -> Response {
    crate::connect::protected(callback_response(name, state, query, jar).await)
}

async fn callback_response(
    name: String,
    state: AppState,
    query: Callback,
    jar: PrivateCookieJar,
) -> Response {
    let Ok(provider) = Provider::configured(&state.catalog, &name) else {
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
    let Some(security) = &state.security else {
        return error();
    };
    let Ok(Some(stored)) = security.take_connect_state(&query.state).await else {
        return error();
    };
    if stored.platform != name {
        return error();
    }
    // Validate the browser binding before looking at a cancellation or
    // exchanging the code: only the browser that approved the consent
    // screen may complete it.
    let Some(context) = crate::connect::oauth_context(security, &stored.context, &jar) else {
        return error();
    };
    if context.request.platform != name {
        return error();
    }
    if query.error.is_some() || query.code.is_none() {
        let Ok(mut redirect) = Url::parse(&context.request.redirect_uri) else {
            return error();
        };
        redirect
            .query_pairs_mut()
            .append_pair("error", "access_denied");
        return (
            crate::connect::clear_provider_cookie(jar),
            Redirect::to(redirect.as_str()),
        )
            .into_response();
    }
    let code = query.code.unwrap();
    let callback = callback_url(&state, &name);
    let mut params = vec![
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
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
        Ok(r) => r,
        Err(_) => return error(),
    };
    let Ok(response) = response.error_for_status() else {
        return error();
    };
    let Ok(token) = response.json::<Token>().await else {
        return error();
    };
    let credential = crate::proxy::StoredCredential::OAuth {
        provider: name.clone(),
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at: token.expires_in.map(|seconds| crate::now_secs() + seconds),
    };
    match crate::connect::handoff(security, &context.request, credential).await {
        Ok(code) => {
            crate::connect::finish_with_connection_code(jar, &context.request.redirect_uri, &code)
        }
        Err(()) => error(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(requirement: &str) -> serde_json::Value {
        let mut document = serde_json::json!({
            "components": {
                "parameters": {"accessType": {
                    "name": "access_type", "in": "query",
                    "schema": {"type": "string", "enum": ["offline"]}
                }},
                "securitySchemes": {"auth": {
                    "type": "oauth2",
                    "x-oauth-authentication-details": {
                        "authorizationServerMetadata": {
                            "code_challenge_methods_supported": ["S256"]
                        },
                        "authorizationCode": {
                            "pkce": {"requirement": requirement},
                            "profile": {"parameters": [{
                                "parameter": {"$ref": "#/components/parameters/accessType"},
                                "value": "offline"
                            }]}
                        }
                    },
                    "flows": {"authorizationCode": {
                        "authorizationUrl": "https://auth.example/authorize",
                        "tokenUrl": "https://auth.example/token",
                        "scopes": {"read": "Read"}
                    }}
                }}
            },
            "security": [{"auth": ["read"]}],
            "paths": {}
        });
        if requirement == "unsupported" {
            document["components"]["securitySchemes"]["auth"]["x-oauth-authentication-details"]
                ["authorizationServerMetadata"]
                .as_object_mut()
                .unwrap()
                .remove("code_challenge_methods_supported");
        }
        document
    }

    #[test]
    fn authorization_details_add_trusted_profile_values_and_only_supported_pkce() {
        for (requirement, expects_pkce) in [("required", true), ("unsupported", false)] {
            let provider = Provider::from_document(&document(requirement), None).unwrap();
            let mut url = Url::parse(&provider.authorization_url).unwrap();
            append_provider_authorization(&mut url, &provider, "challenge");
            let pairs: Vec<_> = url.query_pairs().into_owned().collect();
            assert!(pairs.contains(&("access_type".into(), "offline".into())));
            assert_eq!(
                pairs.iter().any(|(key, _)| key == "code_challenge"),
                expects_pkce
            );
            assert_eq!(
                pairs.iter().any(|(key, _)| key == "code_challenge_method"),
                expects_pkce
            );
        }
    }
}
