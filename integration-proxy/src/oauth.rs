use crate::{
    providers::Provider,
    proxy::{self, ConnectParams},
    session, AppState,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Redirect, Response},
};
use axum_extra::extract::PrivateCookieJar;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use url::Url;

#[derive(Deserialize)]
pub struct Start {
    redirect_uri: String,
    ts: u64,
    nonce: String,
    challenge: String,
    tenant_id: String,
    user_id: String,
    user_id_sig: String,
    response: String,
}
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
fn random() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn error() -> Response {
    (
        StatusCode::BAD_REQUEST,
        "OAuth request could not be completed",
    )
        .into_response()
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

pub async fn start(
    Path(name): Path<String>,
    State(state): State<AppState>,
    Query(request): Query<Start>,
) -> Response {
    let proof = ConnectParams {
        redirect_uri: request.redirect_uri.clone(),
        ts: request.ts,
        nonce: request.nonce.clone(),
        challenge: request.challenge,
        tenant_id: request.tenant_id.clone(),
        user_id: request.user_id.clone(),
        user_id_sig: request.user_id_sig,
        response: request.response,
    };
    if proxy::verify_connect(&state, &proof).await.is_err() {
        return error();
    }
    match begin(
        &state,
        &name,
        &request.redirect_uri,
        &request.tenant_id,
        &request.user_id,
        None,
    )
    .await
    {
        Ok(url) => Redirect::to(&url).into_response(),
        Err(()) => error(),
    }
}

pub async fn begin(
    state: &AppState,
    name: &str,
    redirect_uri: &str,
    tenant_id: &str,
    user_id: &str,
    context: Option<String>,
) -> Result<String, ()> {
    let provider = Provider::configured(&state.catalog, name).map_err(|_| ())?;
    let security = state.security.as_ref().ok_or(())?;
    if security.is_revoked(tenant_id, user_id) {
        return Err(());
    }
    let oauth_state = random();
    let verifier = random();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let callback = format!(
        "{}/oauth/{}/callback",
        state.base_url.trim_end_matches('/'),
        name
    );
    security
        .store_oauth_state(
            &oauth_state,
            &crate::security::OAuthState {
                provider: name.into(),
                redirect_uri: redirect_uri.into(),
                tenant_id: tenant_id.into(),
                user_id: user_id.into(),
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
        .append_pair("redirect_uri", &callback)
        .append_pair("scope", &provider.provider.scopes.join(" "))
        .append_pair("state", &oauth_state);
    append_provider_authorization(&mut url, &provider.provider, &challenge);
    Ok(url.into())
}

/// Starts a standalone API identity login. The context is deliberately in a
/// different sealing domain from a connection handoff and carries no tenant
/// or proxy credential.
pub async fn begin_login(
    state: &AppState,
    name: &str,
    context: &crate::api_login::ApiLoginContext,
) -> Result<String, ()> {
    let mut provider = Provider::configured(&state.catalog, name).map_err(|_| ())?;
    provider.provider = state
        .catalog
        .identity_oauth_provider(name)
        .map_err(|_| ())?;
    let security = state.security.as_ref().ok_or(())?;
    let state_value = random();
    let verifier = random();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let sealed = security
        .seal(
            &serde_json::to_vec(context).map_err(|_| ())?,
            crate::api_login::CONTEXT_AAD,
        )
        .map_err(|_| ())?;
    let callback = format!(
        "{}/oauth/{}/callback",
        state.base_url.trim_end_matches('/'),
        name
    );
    security
        .store_oauth_state(
            &state_value,
            &crate::security::OAuthState {
                provider: name.into(),
                redirect_uri: "/".into(),
                tenant_id: "".into(),
                user_id: "".into(),
                verifier,
                context: Some(format!("{}{}", crate::api_login::CONTEXT_PREFIX, sealed)),
            },
        )
        .await
        .map_err(|_| ())?;
    let mut url = Url::parse(&provider.provider.authorization_url).map_err(|_| ())?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &provider.client_id)
        .append_pair("redirect_uri", &callback)
        .append_pair("scope", &provider.provider.scopes.join(" "))
        .append_pair("state", &state_value);
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
    let Ok(Some(stored)) = security.take_oauth_state(&query.state).await else {
        return error();
    };
    if stored
        .context
        .as_deref()
        .is_some_and(|context| context.starts_with(crate::api_login::CONTEXT_PREFIX))
    {
        return crate::api_login::callback(&name, &state, stored, query.code, query.error, jar)
            .await;
    }
    if stored.provider != name || security.is_revoked(&stored.tenant_id, &stored.user_id) {
        return error();
    }
    let context = match &stored.context {
        Some(value) => match crate::connect::oauth_context(security, value, &jar) {
            Some(context)
                if context.request.platform == name
                    && context.request.redirect_uri == stored.redirect_uri
                    && context.request.user_id == stored.user_id =>
            {
                Some(context)
            }
            _ => return error(),
        },
        None => None,
    };
    let crate::security::OAuthState {
        redirect_uri,
        tenant_id: tenant_id_from_state,
        user_id,
        verifier,
        ..
    } = stored;
    // Validate the browser/session binding before looking at a cancellation or
    // exchanging the code. A callback must never authenticate a session that
    // was created or switched while the browser was at the provider.
    if let Some(context) = &context {
        match &context.mode {
            crate::connect::BootstrapMode::Bootstrap if session::read_session(&jar).is_some() => {
                return error()
            }
            crate::connect::BootstrapMode::ExistingTenant { tenant_id }
                if tenant_id != &tenant_id_from_state
                    || session::read_session(&jar)
                        .as_ref()
                        .map(|user| &user.subject)
                        != Some(tenant_id) =>
            {
                return error()
            }
            _ => {}
        }
    }
    if query.error.is_some() || query.code.is_none() {
        if context.is_some() {
            let Ok(mut redirect) = Url::parse(&redirect_uri) else {
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
        return error();
    }
    let code = query.code.unwrap();
    let callback = format!(
        "{}/oauth/{}/callback",
        state.base_url.trim_end_matches('/'),
        name
    );
    let mut params = vec![
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", callback.as_str()),
    ];
    if provider.provider.use_pkce {
        params.push(("code_verifier", verifier.as_str()));
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
    let (tenant_id, jar) = match context.as_ref().map(|context| &context.mode) {
        Some(crate::connect::BootstrapMode::ExistingTenant { tenant_id }) => {
            (tenant_id.clone(), jar)
        }
        Some(crate::connect::BootstrapMode::Bootstrap) => {
            // A session appearing while this state was in flight would let a
            // different browser identity bind the provider credential.
            let Ok(operation) = state.catalog.tenant_identity(&name) else {
                return error();
            };
            #[cfg(test)]
            let operation = if let Some(upstream) = &state.test_upstream {
                let mut operation = operation;
                operation.url = format!("{}/identity", upstream.trim_end_matches('/'))
                    .parse()
                    .expect("test upstream URL");
                operation
            } else {
                operation
            };
            let mut response = match state
                .identity_http_client
                .get(operation.url.clone())
                .bearer_auth(&token.access_token)
                .send()
                .await
            {
                Ok(response) => response,
                Err(_) => return error(),
            };
            if !response.status().is_success() {
                return error();
            }
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
            let Ok(body) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
                return error();
            };
            let Ok(identity) = crate::identity::resolve(&operation, &body, &provider.client_id)
            else {
                return error();
            };
            let subject = match identity
                .legacy_subject_if_matches(state.app_auth_identity_namespace.as_deref())
            {
                Ok(Some(subject)) => subject,
                Ok(None) => identity.canonical(),
                Err(_) => return error(),
            };
            if security.is_revoked(&subject, &user_id) {
                return error();
            }
            let identity_label = name.clone();
            let email = identity.email.clone().unwrap_or_default();
            let name = identity.name.clone().unwrap_or_else(|| email.clone());
            let mut user =
                session::SessionUser::new(subject.clone(), email, name, identity.picture);
            user.identity_label = Some(identity_label);
            (subject, session::set_session(jar, &user))
        }
        None => (tenant_id_from_state.clone(), jar),
    };
    let credential = crate::proxy::StoredCredential::OAuth {
        provider: name.clone(),
        tenant_id: tenant_id.clone(),
        user_id: user_id.clone(),
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at: token
            .expires_in
            .map(|seconds| crate::proxy::now_unix() + seconds),
    };
    let aad = "connection-credential-v1";
    let Ok(envelope) = security.seal(&serde_json::to_vec(&credential).unwrap(), aad.as_bytes())
    else {
        return error();
    };
    let code = match context {
        Some(context) => {
            match crate::connect::handoff(security, &context, &tenant_id, &envelope).await {
                Ok(code) => code,
                Err(()) => return error(),
            }
        }
        None => {
            let code = random();
            if security
                .store_connection_code(&code, &envelope)
                .await
                .is_err()
            {
                return error();
            }
            code
        }
    };
    crate::connect::finish_with_connection_code(jar, &redirect_uri, &code)
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
