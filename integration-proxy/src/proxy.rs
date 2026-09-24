//! `ANY /proxy/{connection_id}/{platform}/{path}`: proxied provider calls
//! (issue #54).
//!
//! Every request is authenticated one of two ways, both ending in a v2
//! request signature (see [`crate::signature`]):
//!
//! - **Signed by an agent with standing** on the connection: its owner; an
//!   app agent holding a delegation for it; or a runtime registered (by the
//!   owner) for such an app. Delegations and runtimes are read on every
//!   request, so revoking one takes effect on the next.
//! - **A frame capability** (`Authorization: Capability …`, see
//!   [`crate::capability`]) signed by the owner for a delegated app, plus a
//!   request signature by the capability's `cnf` key.
//!
//! Nothing rotates: the connection id is not a secret, and a signature is
//! accepted once. The connection id is in the path, so the signature covers
//! it. The owner is then checked against the access policy.
use axum::{
    body::Bytes,
    extract::{OriginalUri, Path, RawQuery, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::{
    agent_id,
    api_error::ApiError,
    capability,
    security::{ConnectionRecord, Security, Standing},
    AppState,
};

/// The provider credential sealed in a connection row, interpreted only here
/// and where it is minted (`oauth.rs`'s callback, `connect.rs`'s apiKey
/// branch).
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind")]
pub(crate) enum StoredCredential {
    #[serde(rename = "oauth")]
    OAuth {
        provider: String,
        access_token: String,
        refresh_token: Option<String>,
        expires_at: Option<u64>,
    },
    #[serde(rename = "api_key")]
    ApiKey { provider: String, key: String },
}

impl StoredCredential {
    fn provider(&self) -> &str {
        match self {
            Self::OAuth { provider, .. } | Self::ApiKey { provider, .. } => provider,
        }
    }
}

#[derive(Deserialize)]
struct RefreshToken {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
}

fn needs_refresh(credential: &StoredCredential) -> bool {
    matches!(
        credential,
        StoredCredential::OAuth { expires_at: Some(expires), .. } if *expires <= crate::now_secs() + 30
    )
}

async fn refresh_token(state: &AppState, credential: &mut StoredCredential) -> Result<(), ()> {
    let StoredCredential::OAuth {
        provider,
        access_token,
        refresh_token,
        expires_at,
    } = credential
    else {
        // A static API key has nothing to refresh.
        return Ok(());
    };
    let refresh_token_value = refresh_token.as_deref().ok_or(())?;
    let configured =
        crate::providers::Provider::configured(&state.catalog, provider).map_err(|_| ())?;
    #[cfg(test)]
    let configured = {
        let mut configured = configured;
        if let Some(upstream) = &state.test_upstream {
            configured.provider.token_url = format!("{}/token", upstream.trim_end_matches('/'));
        }
        configured
    };
    let response = configured
        .token_request(
            &state.http_client,
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token_value),
            ],
        )
        .send()
        .await
        .map_err(|_| ())?
        .error_for_status()
        .map_err(|_| ())?;
    let token = response.json::<RefreshToken>().await.map_err(|_| ())?;
    *access_token = token.access_token;
    if token.refresh_token.is_some() {
        *refresh_token = token.refresh_token;
    }
    *expires_at = token.expires_in.map(|seconds| crate::now_secs() + seconds);
    Ok(())
}

/// Refreshes a connection's OAuth token if it is about to expire, with at
/// most one refresh in flight per connection (see
/// `Security::claim_refresh_lease`). A caller that loses the race waits for
/// the winner's result instead of spending the refresh token again.
async fn refresh_connection(
    state: &AppState,
    security: &Security,
    connection_id: &str,
    credential: &mut StoredCredential,
) -> Result<(), ()> {
    const ATTEMPTS: usize = 50;
    const WAIT: std::time::Duration = std::time::Duration::from_millis(200);
    let reload = |record: Option<ConnectionRecord>| -> Result<StoredCredential, ()> {
        serde_json::from_slice(&record.ok_or(())?.credential).map_err(|_| ())
    };
    for _ in 0..ATTEMPTS {
        if !needs_refresh(credential) {
            return Ok(());
        }
        if security
            .claim_refresh_lease(connection_id)
            .await
            .map_err(|_| ())?
        {
            // Another caller may have finished a refresh between our read
            // and our claim; start from the row as it is now.
            if let Ok(current) =
                reload(security.load_connection(connection_id).await.ok().flatten())
            {
                *credential = current;
            }
            if !needs_refresh(credential) {
                let _ = security.release_refresh_lease(connection_id).await;
                return Ok(());
            }
            if refresh_token(state, credential).await.is_err() {
                let _ = security.release_refresh_lease(connection_id).await;
                return Err(());
            }
            let serialized = serde_json::to_vec(&*credential).map_err(|_| ())?;
            return security
                .store_refreshed_connection(connection_id, &serialized)
                .await
                .map_err(|_| ());
        }
        tokio::time::sleep(WAIT).await;
        *credential = reload(security.load_connection(connection_id).await.ok().flatten())?;
    }
    Err(())
}

/// How a request was allowed to use a connection.
#[derive(Debug, PartialEq, Eq)]
enum Caller {
    Owner,
    Delegate(String),
    Runtime { agent: String, app: String },
    Frame { app: String },
}

/// Authenticates a proxied request against the connection it names. See the
/// module documentation for the two accepted presentations.
#[allow(clippy::too_many_arguments)]
async fn authenticate(
    state: &AppState,
    security: &Security,
    record: &ConnectionRecord,
    platform: &str,
    method: &Method,
    uri: &axum::http::Uri,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<Caller, ApiError> {
    let owner = agent_id::parse(&record.owner).ok_or(ApiError::Internal)?;
    let authorization = headers
        .get(header::AUTHORIZATION)
        .map(|value| {
            value
                .to_str()
                .map_err(|_| ApiError::UnsupportedAuthorization)
        })
        .transpose()?;
    let caller = match authorization {
        Some(value) => {
            let token = value
                .strip_prefix("Capability ")
                .ok_or(ApiError::UnsupportedAuthorization)?;
            let parsed = capability::parse(token)?;
            parsed.verify(&owner, &state.public_origin, crate::now_secs())?;
            if parsed.claims.connection_id != record.connection_id
                || parsed.claims.platform != platform
                || record.platform != platform
            {
                return Err(ApiError::CapabilityScope);
            }
            if !security
                .is_delegated(&record.connection_id, parsed.app.as_str())
                .await
                .map_err(|_| ApiError::Unavailable)?
            {
                return Err(ApiError::NotDelegated);
            }
            let signer =
                crate::signature::authenticate(state, security, method, uri, headers, body).await?;
            if signer != parsed.cnf {
                return Err(ApiError::CapabilityKeyMismatch);
            }
            Caller::Frame {
                app: parsed.app.as_str().to_owned(),
            }
        }
        None => {
            let signer =
                crate::signature::authenticate(state, security, method, uri, headers, body).await?;
            match security
                .standing(&record.connection_id, owner.as_str(), signer.as_str())
                .await
                .map_err(|_| ApiError::Unavailable)?
            {
                Standing::Owner => Caller::Owner,
                Standing::Delegate => Caller::Delegate(signer.as_str().to_owned()),
                Standing::Runtime { app } => Caller::Runtime {
                    agent: signer.as_str().to_owned(),
                    app,
                },
                Standing::None => return Err(ApiError::NotDelegated),
            }
        }
    };
    if record.platform != platform {
        return Err(ApiError::PlatformMismatch);
    }
    crate::check_access(state, &owner).await?;
    Ok(caller)
}

/// How to attach a resolved credential to the outbound upstream request.
/// `None` covers query-located API keys, already appended to the target URL
/// before the request is built.
enum CredentialInjection {
    Bearer(String),
    Header { name: String, value: String },
    None,
}

pub async fn forward(
    Path((connection_id, platform, path)): Path<(String, String, String)>,
    RawQuery(query): RawQuery,
    State(state): State<AppState>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match forward_inner(
        &state,
        &connection_id,
        &platform,
        &path,
        query,
        method,
        &uri,
        &headers,
        body,
    )
    .await
    {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

#[allow(clippy::too_many_arguments)]
async fn forward_inner(
    state: &AppState,
    connection_id: &str,
    platform: &str,
    path: &str,
    query: Option<String>,
    method: Method,
    uri: &axum::http::Uri,
    headers: &HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let request_path = format!("/{path}");
    if contains_traversal_segment(&request_path) {
        return Err(ApiError::BadRequest(
            "path must not contain traversal segments",
        ));
    }
    if body.len() > 1_048_576 {
        return Ok((StatusCode::PAYLOAD_TOO_LARGE, "request body is too large").into_response());
    }
    let security = state.security.as_ref().ok_or(ApiError::Unavailable)?;
    if connection_id.len() != 43 {
        return Err(ApiError::UnknownConnection);
    }
    let record = security
        .load_connection(connection_id)
        .await
        .map_err(|_| ApiError::Unavailable)?
        .ok_or(ApiError::UnknownConnection)?;
    let caller = authenticate(
        state, security, &record, platform, &method, uri, headers, &body,
    )
    .await?;
    // Only an authenticated use keeps a connection alive.
    let (delegate, runtime) = match &caller {
        Caller::Owner => (None, None),
        Caller::Delegate(agent) => (Some(agent.as_str()), None),
        Caller::Runtime { agent, app } => (
            Some(app.as_str()),
            Some((record.owner.as_str(), agent.as_str())),
        ),
        Caller::Frame { app } => (Some(app.as_str()), None),
    };
    let _ = security.touch(connection_id, delegate, runtime).await;

    let mut credential = serde_json::from_slice::<StoredCredential>(&record.credential)
        .map_err(|_| ApiError::Internal)?;
    if credential.provider() != platform {
        return Err(ApiError::PlatformMismatch);
    }
    if refresh_connection(state, security, connection_id, &mut credential)
        .await
        .is_err()
    {
        return Err(ApiError::CredentialRefreshFailed);
    }
    let not_in_catalog = || {
        (
            StatusCode::NOT_FOUND,
            "method or path is not in the catalog",
        )
            .into_response()
    };
    let Some(required_headers) =
        state
            .catalog
            .required_headers(platform, method.as_str(), &request_path)
    else {
        return Ok(not_in_catalog());
    };
    let Some(mut target) = state
        .catalog
        .allows(platform, method.as_str(), &request_path)
    else {
        return Ok(not_in_catalog());
    };
    if let Err(message) = state.catalog.validate_request(
        platform,
        method.as_str(),
        &request_path,
        query.as_deref(),
        headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
        !body.is_empty(),
    ) {
        return Ok((StatusCode::BAD_REQUEST, message).into_response());
    }
    target.set_path(&request_path);
    target.set_query(query.as_deref());
    let injection = match &credential {
        StoredCredential::OAuth { access_token, .. } => {
            CredentialInjection::Bearer(access_token.clone())
        }
        StoredCredential::ApiKey { key, .. } => {
            let Ok(crate::providers::SecurityScheme::ApiKey(scheme)) =
                state.catalog.security_scheme(platform)
            else {
                return Err(ApiError::Internal);
            };
            match scheme.location {
                crate::providers::ApiKeyLocation::Header => CredentialInjection::Header {
                    name: scheme.name,
                    value: key.clone(),
                },
                crate::providers::ApiKeyLocation::Query => {
                    target.query_pairs_mut().append_pair(&scheme.name, key);
                    CredentialInjection::None
                }
                crate::providers::ApiKeyLocation::Cookie => {
                    return Ok((
                        StatusCode::NOT_IMPLEMENTED,
                        "cookie-located API keys are not supported",
                    )
                        .into_response());
                }
            }
        }
    };
    let upstream = match upstream_request(
        &state.http_client,
        method.clone(),
        target.clone(),
        injection,
        headers,
        &required_headers,
        body,
    )
    .send()
    .await
    {
        Ok(response) => response,
        Err(_) => return Ok((StatusCode::BAD_GATEWAY, "upstream request failed").into_response()),
    };
    let status = upstream.status();
    let forwarded_headers = upstream_response_headers(upstream.headers());
    let bytes = match read_bounded_body(upstream, MAX_RESPONSE_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return Ok((
                StatusCode::BAD_GATEWAY,
                "upstream response failed or was too large",
            )
                .into_response())
        }
    };
    let mut response = Response::new(bytes.into());
    *response.status_mut() = status;
    *response.headers_mut() = forwarded_headers;
    Ok(response)
}

// Forward only representation/pagination metadata, never provider cookies or credentials.
fn upstream_response_headers(headers: &HeaderMap) -> HeaderMap {
    let mut result = HeaderMap::new();
    for name in [
        header::CONTENT_TYPE,
        header::LINK,
        header::RETRY_AFTER,
        header::ETAG,
        axum::http::HeaderName::from_static("x-total-count"),
        axum::http::HeaderName::from_static("x-next-page"),
    ] {
        for value in headers.get_all(&name) {
            result.append(name.clone(), value.clone());
        }
    }
    result
}

const MAX_RESPONSE_BYTES: usize = 10_485_760;

/// Reads the upstream body incrementally so an oversized or slow response is
/// rejected as soon as the limit is crossed, instead of after it is fully
/// buffered in memory.
async fn read_bounded_body(mut upstream: reqwest::Response, limit: usize) -> Result<Bytes, ()> {
    if upstream
        .content_length()
        .is_some_and(|len| len > limit as u64)
    {
        return Err(());
    }
    let mut buffer = Vec::new();
    while let Some(chunk) = upstream.chunk().await.map_err(|_| ())? {
        if buffer.len() + chunk.len() > limit {
            return Err(());
        }
        buffer.extend_from_slice(&chunk);
    }
    Ok(Bytes::from(buffer))
}

/// Rejects any `.` or `..` path segment so a client cannot request a path
/// that, once assigned to the upstream URL, normalizes to a different path
/// than the one validated against the catalog allowlist.
fn contains_traversal_segment(path: &str) -> bool {
    path.split('/')
        .any(|segment| segment == "." || segment == "..")
}

fn upstream_request(
    client: &reqwest::Client,
    method: axum::http::Method,
    target: Url,
    injection: CredentialInjection,
    headers: &HeaderMap,
    required_headers: &[(String, String)],
    body: Bytes,
) -> reqwest::RequestBuilder {
    let mut request = client.request(method, target);
    request = match injection {
        CredentialInjection::Bearer(token) => request.bearer_auth(token),
        CredentialInjection::Header { name, value } => request.header(name, value),
        CredentialInjection::None => request,
    };
    if let Some(content_type) = headers.get(header::CONTENT_TYPE) {
        request = request.header(header::CONTENT_TYPE, content_type);
    }
    if let Some(etag) = headers.get(header::IF_MATCH) {
        request = request.header(header::IF_MATCH, etag);
    }
    for (name, value) in required_headers {
        request = request.header(name, value);
    }
    request.body(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_id::test_signer::Agent;
    use crate::capability::{mint, Claims};
    use crate::test_support::{body_json, security, signed_request, state, PUBLIC_ORIGIN};
    use axum::http::{header::AUTHORIZATION, HeaderValue};
    use axum::Json;
    use serde_json::json;
    use tower::ServiceExt;

    fn test_state() -> AppState {
        state(None)
    }

    #[tokio::test]
    async fn forwarded_requests_include_server_owned_user_agent() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new().route(
            "/repos/owner/repo/issues",
            axum::routing::post(|axum::extract::OriginalUri(uri): axum::extract::OriginalUri, headers: HeaderMap, body: Bytes| async move {
                Json(json!({
                    "query": uri.query(),
                    "user_agent": headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()),
                    "authorization": headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()),
                    "content_type": headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()),
                    "if_match": headers.get(header::IF_MATCH).and_then(|v| v.to_str().ok()),
                    "body": String::from_utf8(body.to_vec()).unwrap(),
                }))
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = crate::build_http_client();
        for caller_user_agent in [None, Some("caller-controlled-agent")] {
            let mut headers = HeaderMap::new();
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            );
            headers.insert(
                header::IF_MATCH,
                HeaderValue::from_static("\"event-version\""),
            );
            if let Some(value) = caller_user_agent {
                headers.insert(header::USER_AGENT, HeaderValue::from_static(value));
            }
            let response = upstream_request(
                &client,
                axum::http::Method::POST,
                Url::parse(&format!("http://{address}/repos/owner/repo/issues?state=all&page=2&per_page=1&labels=a%2Cb")).unwrap(),
                CredentialInjection::Bearer("test-provider-token".to_string()),
                &headers,
                &[],
                Bytes::from_static(b"{}"),
            )
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
            assert_eq!(
                response["query"],
                "state=all&page=2&per_page=1&labels=a%2Cb"
            );
            assert_eq!(response["user_agent"], "LocalThought-integration-proxy");
            assert_eq!(response["authorization"], "Bearer test-provider-token");
            assert_eq!(response["content_type"], "application/json");
            assert_eq!(response["body"], "{}");
            assert_eq!(response["if_match"], "\"event-version\"");
        }
        server.abort();
    }

    #[tokio::test]
    async fn api_key_credentials_are_sent_as_the_declared_header_not_bearer() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new().route(
            "/workspaces",
            axum::routing::get(
                |headers: HeaderMap| async move {
                    Json(json!({
                        "authorization": headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()),
                        "x_api_key": headers.get("x-api-key").and_then(|v| v.to_str().ok()),
                    }))
                },
            ),
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = crate::build_http_client();
        let response = upstream_request(
            &client,
            axum::http::Method::GET,
            Url::parse(&format!("http://{address}/workspaces")).unwrap(),
            CredentialInjection::Header {
                name: "X-Api-Key".to_string(),
                value: "clockify-secret".to_string(),
            },
            &HeaderMap::new(),
            &[],
            Bytes::new(),
        )
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
        assert_eq!(response["authorization"], serde_json::Value::Null);
        assert_eq!(response["x_api_key"], "clockify-secret");
        server.abort();
    }

    #[test]
    fn pagination_headers_survive_without_forwarding_provider_credentials() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        headers.append(
            header::LINK,
            HeaderValue::from_static(
                "<https://api.github.com/repos/o/r/issues?page=2>; rel=\"next\"",
            ),
        );
        headers.append(
            header::LINK,
            HeaderValue::from_static(
                "<https://api.github.com/repos/o/r/issues?page=3>; rel=\"last\"",
            ),
        );
        headers.insert(
            header::SET_COOKIE,
            HeaderValue::from_static("provider-session=private"),
        );
        headers.insert(
            "x-connection-code",
            HeaderValue::from_static("untrusted-provider-code"),
        );
        headers.insert(header::RETRY_AFTER, HeaderValue::from_static("300"));
        let forwarded = upstream_response_headers(&headers);
        assert_eq!(
            forwarded.get(header::RETRY_AFTER),
            Some(&HeaderValue::from_static("300"))
        );
        assert_eq!(forwarded.get_all(header::LINK).iter().count(), 2);
        assert_eq!(forwarded[header::CONTENT_TYPE], "application/json");
        assert!(!forwarded.contains_key(header::SET_COOKIE));
        assert!(!forwarded.contains_key("x-connection-code"));
    }

    #[test]
    fn traversal_segments_are_rejected_including_encoded_forms() {
        assert!(contains_traversal_segment("/repositories/../issues"));
        assert!(contains_traversal_segment("/repositories/./issues"));
        assert!(contains_traversal_segment("/../etc/passwd"));
        assert!(!contains_traversal_segment("/repositories/123/issues"));
        assert!(!contains_traversal_segment("/repositories/..foo/issues"));
    }

    #[tokio::test]
    async fn forward_rejects_a_path_containing_traversal_segments_before_touching_credentials() {
        let mut state = test_state();
        state.catalog = crate::catalog::Catalog::from_test_document(
            "github-issues",
            json!({
                "servers": [{"url": "https://api.example"}],
                "paths": {"/repositories/{id}/issues": {"get": {}}}
            }),
            json!({}),
        );
        // No Authorization header and no security service configured: if the
        // traversal check did not run first, this would fail with 401/503
        // instead of 400.
        let response = crate::router(state)
            .oneshot(
                axum::http::Request::builder()
                    .uri("/proxy/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/github-issues/repositories/../issues")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn read_bounded_body_rejects_a_response_over_the_limit() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new().route("/big", axum::routing::get(|| async { vec![0u8; 20] }));
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = crate::build_http_client();
        let response = client
            .get(format!("http://{address}/big"))
            .send()
            .await
            .unwrap();
        assert!(read_bounded_body(response, 10).await.is_err());

        let response = client
            .get(format!("http://{address}/big"))
            .send()
            .await
            .unwrap();
        assert!(read_bounded_body(response, 20).await.is_ok());
        server.abort();
    }

    /// An upstream that echoes the API key it received, and a catalog for it.
    async fn api_key_upstream() -> (tokio::task::JoinHandle<()>, crate::catalog::Catalog) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new().route(
            "/workspaces",
            axum::routing::any(|headers: HeaderMap| async move {
                axum::Json(json!({
                    "x_api_key": headers.get("x-api-key").and_then(|v| v.to_str().ok()),
                    "signature_forwarded": headers.contains_key("x-atomic-signature"),
                    "authorization": headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok()),
                }))
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let catalog = crate::catalog::Catalog::from_test_document(
            "clockify",
            json!({
                "servers": [{"url": format!("http://{address}")}],
                "components": {"securitySchemes": {"clockifyApiKey": {
                    "type": "apiKey", "in": "header", "name": "X-Api-Key"
                }}},
                "security": [{"clockifyApiKey": []}],
                "paths": {"/workspaces": {"get": {}, "post": {"requestBody": {"content": {"application/json": {}}}}}}
            }),
            json!({}),
        );
        (server, catalog)
    }

    fn api_key_credential() -> Vec<u8> {
        serde_json::to_vec(&StoredCredential::ApiKey {
            provider: "clockify".into(),
            key: "clockify-secret".into(),
        })
        .unwrap()
    }

    struct Fixture {
        state: AppState,
        security: Security,
        owner: Agent,
        id: String,
        _server: tokio::task::JoinHandle<()>,
    }

    async fn fixture(owner_seed: u8) -> Fixture {
        let security = security().await;
        let (server, catalog) = api_key_upstream().await;
        let mut s = state(Some(security.clone()));
        s.catalog = catalog;
        let owner = Agent::new(owner_seed);
        let id = security
            .create_connection("clockify", &owner.id(), &api_key_credential())
            .await
            .unwrap();
        Fixture {
            state: s,
            security,
            owner,
            id,
            _server: server,
        }
    }

    impl Fixture {
        fn path(&self) -> String {
            format!("/proxy/{}/clockify/workspaces", self.id)
        }
        async fn send(&self, request: axum::http::Request<axum::body::Body>) -> Response {
            crate::router(self.state.clone())
                .oneshot(request)
                .await
                .unwrap()
        }
        async fn get_as(&self, agent: &Agent) -> Response {
            self.send(signed_request(
                &self.state,
                agent,
                "GET",
                &self.path(),
                vec![],
            ))
            .await
        }
        fn claims(&self, app: &Agent, frame: &Agent) -> Claims {
            Claims {
                v: 2,
                connection_id: self.id.clone(),
                platform: "clockify".into(),
                aud: PUBLIC_ORIGIN.into(),
                app: app.id(),
                cnf: frame.id(),
                exp: crate::now_secs() + 600,
            }
        }
        async fn frame_get(&self, token: &str, signer: &Agent) -> Response {
            let mut request = signed_request(&self.state, signer, "GET", &self.path(), vec![]);
            request.headers_mut().insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Capability {token}")).unwrap(),
            );
            self.send(request).await
        }
    }

    async fn expect_error(response: Response, status: StatusCode, code: &str) {
        assert_eq!(response.status(), status, "expected {code}");
        assert_eq!(body_json(response).await["error"], code);
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_the_owner_signs_requests_that_reach_the_provider_once_each() {
        let f = fixture(31).await;
        let request = signed_request(&f.state, &f.owner, "GET", &f.path(), vec![]);
        let replay = crate::test_support::clone_request(&request);
        let response = f.send(request).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!response.headers().contains_key("x-connection-code"));
        let body = body_json(response).await;
        assert_eq!(body["x_api_key"], "clockify-secret");
        // The caller's own signature headers never reach the provider.
        assert_eq!(body["signature_forwarded"], false);
        // Nothing rotated: a second, freshly signed request works too.
        assert_eq!(f.get_as(&f.owner).await.status(), StatusCode::OK);
        // The exact same signed request is refused.
        expect_error(f.send(replay).await, StatusCode::UNAUTHORIZED, "replayed").await;
        // A signed POST covers its body.
        let post = signed_request(&f.state, &f.owner, "POST", &f.path(), b"{}".to_vec());
        assert_eq!(f.send(post).await.status(), StatusCode::OK);
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_each_verification_step_fails_closed() {
        let f = fixture(32).await;
        // No signature at all.
        let unsigned = axum::http::Request::builder()
            .uri(f.path())
            .body(axum::body::Body::empty())
            .unwrap();
        expect_error(
            f.send(unsigned).await,
            StatusCode::UNAUTHORIZED,
            "missing_signature",
        )
        .await;
        // A retired connection code.
        let bearer = axum::http::Request::builder()
            .uri(f.path())
            .header(AUTHORIZATION, "Bearer old-connection-code")
            .body(axum::body::Body::empty())
            .unwrap();
        expect_error(
            f.send(bearer).await,
            StatusCode::UNAUTHORIZED,
            "unsupported_authorization",
        )
        .await;
        // Version 1 header.
        let mut v1 = signed_request(&f.state, &f.owner, "GET", &f.path(), vec![]);
        v1.headers_mut().insert(
            crate::signature::VERSION_HEADER,
            HeaderValue::from_static("1"),
        );
        expect_error(
            f.send(v1).await,
            StatusCode::UNAUTHORIZED,
            "unsupported_signature_version",
        )
        .await;
        // Stale timestamp.
        let stale = crate::test_support::signed_request_at(
            &f.state,
            &f.owner,
            "GET",
            &f.path(),
            vec![],
            crate::now_ms() - crate::signature::MAX_SKEW_MS - 1000,
        );
        expect_error(
            f.send(stale).await,
            StatusCode::UNAUTHORIZED,
            "stale_timestamp",
        )
        .await;
        // Tampered body.
        let mut tampered = signed_request(&f.state, &f.owner, "POST", &f.path(), b"{}".to_vec());
        *tampered.body_mut() = axum::body::Body::from(r#"{"x":1}"#);
        expect_error(
            f.send(tampered).await,
            StatusCode::UNAUTHORIZED,
            "bad_signature",
        )
        .await;
        // A signature over the internal (plain-HTTP) URL instead of BASE_URL.
        let internal = crate::test_support::signed_request_for_url(
            &f.owner,
            "GET",
            &f.path(),
            &format!("http://localhost:8080{}", f.path()),
            vec![],
        );
        expect_error(
            f.send(internal).await,
            StatusCode::UNAUTHORIZED,
            "bad_signature",
        )
        .await;
        // The Host header does not matter: the signed URL is built from BASE_URL.
        let mut spoofed_host = signed_request(&f.state, &f.owner, "GET", &f.path(), vec![]);
        spoofed_host
            .headers_mut()
            .insert(header::HOST, HeaderValue::from_static("evil.example"));
        assert_eq!(f.send(spoofed_host).await.status(), StatusCode::OK);
        // Claiming to be the owner while signing with another key.
        let impostor = Agent::new(33);
        let mut claimed = signed_request(&f.state, &impostor, "GET", &f.path(), vec![]);
        claimed.headers_mut().insert(
            crate::signature::AGENT_HEADER,
            HeaderValue::from_str(&f.owner.id()).unwrap(),
        );
        expect_error(
            f.send(claimed).await,
            StatusCode::UNAUTHORIZED,
            "agent_key_mismatch",
        )
        .await;
        // Someone else's key: no standing on this connection.
        expect_error(
            f.get_as(&impostor).await,
            StatusCode::FORBIDDEN,
            "not_delegated",
        )
        .await;
        // Wrong platform in the path.
        let wrong_platform = signed_request(
            &f.state,
            &f.owner,
            "GET",
            &format!("/proxy/{}/github-issues/workspaces", f.id),
            vec![],
        );
        expect_error(
            f.send(wrong_platform).await,
            StatusCode::FORBIDDEN,
            "platform_mismatch",
        )
        .await;
        // Unknown connection.
        let unknown = signed_request(
            &f.state,
            &f.owner,
            "GET",
            &format!("/proxy/{}/clockify/workspaces", crate::connect::random()),
            vec![],
        );
        expect_error(
            f.send(unknown).await,
            StatusCode::NOT_FOUND,
            "unknown_connection",
        )
        .await;
        // The legacy spelling of the owner's id is the owner.
        let mut legacy = signed_request(&f.state, &f.owner, "GET", &f.path(), vec![]);
        legacy.headers_mut().insert(
            crate::signature::AGENT_HEADER,
            HeaderValue::from_str(&f.owner.legacy_id()).unwrap(),
        );
        assert_eq!(f.send(legacy).await.status(), StatusCode::OK);
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_delegates_and_runtimes_lose_access_the_moment_they_are_revoked() {
        let f = fixture(34).await;
        let app = Agent::new(35);
        let node = Agent::new(36);
        expect_error(f.get_as(&app).await, StatusCode::FORBIDDEN, "not_delegated").await;
        f.security
            .put_delegation(&f.id, &app.id(), Some("Plugin"))
            .await
            .unwrap();
        assert_eq!(f.get_as(&app).await.status(), StatusCode::OK);
        expect_error(
            f.get_as(&node).await,
            StatusCode::FORBIDDEN,
            "not_delegated",
        )
        .await;
        f.security
            .put_runtime(&f.owner.id(), &node.id(), &app.id(), Some("server"))
            .await
            .unwrap();
        assert_eq!(f.get_as(&node).await.status(), StatusCode::OK);
        // Revoke the app's delegation: the app and its runtime stop at once.
        f.security
            .delete_delegation(&f.id, &app.id())
            .await
            .unwrap();
        expect_error(f.get_as(&app).await, StatusCode::FORBIDDEN, "not_delegated").await;
        expect_error(
            f.get_as(&node).await,
            StatusCode::FORBIDDEN,
            "not_delegated",
        )
        .await;
        // Restore, then remove only the runtime.
        f.security
            .put_delegation(&f.id, &app.id(), None)
            .await
            .unwrap();
        f.security
            .delete_runtime(&f.owner.id(), &node.id())
            .await
            .unwrap();
        assert_eq!(f.get_as(&app).await.status(), StatusCode::OK);
        expect_error(
            f.get_as(&node).await,
            StatusCode::FORBIDDEN,
            "not_delegated",
        )
        .await;
        // Deleting the connection ends everyone's access.
        f.security
            .delete_connection(&f.id, &f.owner.id())
            .await
            .unwrap();
        expect_error(
            f.get_as(&f.owner).await,
            StatusCode::NOT_FOUND,
            "unknown_connection",
        )
        .await;
        expect_error(
            f.get_as(&app).await,
            StatusCode::NOT_FOUND,
            "unknown_connection",
        )
        .await;
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_the_access_policy_is_asked_about_the_owner_on_every_request() {
        let mut f = fixture(37).await;
        let app = Agent::new(38);
        f.security
            .put_delegation(&f.id, &app.id(), None)
            .await
            .unwrap();
        assert_eq!(f.get_as(&app).await.status(), StatusCode::OK);
        f.state.access = std::sync::Arc::new(crate::access::EnvAccessPolicy::new(
            None,
            vec![f.owner.id()],
        ));
        expect_error(
            f.get_as(&f.owner).await,
            StatusCode::FORBIDDEN,
            "access_denied",
        )
        .await;
        // A delegate is judged by its owner's standing, not its own.
        expect_error(f.get_as(&app).await, StatusCode::FORBIDDEN, "access_denied").await;
        f.state.access = std::sync::Arc::new(crate::access::EnvAccessPolicy::new(
            Some(vec![f.owner.legacy_id()]),
            vec![],
        ));
        assert_eq!(f.get_as(&app).await.status(), StatusCode::OK);
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_a_frame_capability_works_only_with_the_frame_key_and_a_live_delegation() {
        let f = fixture(39).await;
        let app = Agent::new(40);
        let frame = Agent::new(41);
        let token = mint(&f.owner, &f.claims(&app, &frame));
        // No delegation for the app yet.
        expect_error(
            f.frame_get(&token, &frame).await,
            StatusCode::FORBIDDEN,
            "not_delegated",
        )
        .await;
        f.security
            .put_delegation(&f.id, &app.id(), None)
            .await
            .unwrap();
        assert_eq!(f.frame_get(&token, &frame).await.status(), StatusCode::OK);
        // The capability is reusable within its lifetime, each request freshly signed.
        assert_eq!(f.frame_get(&token, &frame).await.status(), StatusCode::OK);
        // A copied capability used without the frame's key.
        let thief = Agent::new(42);
        expect_error(
            f.frame_get(&token, &thief).await,
            StatusCode::UNAUTHORIZED,
            "capability_key_mismatch",
        )
        .await;
        // ... or with no request signature at all.
        let bare = axum::http::Request::builder()
            .uri(f.path())
            .header(AUTHORIZATION, format!("Capability {token}"))
            .body(axum::body::Body::empty())
            .unwrap();
        expect_error(
            f.send(bare).await,
            StatusCode::UNAUTHORIZED,
            "missing_signature",
        )
        .await;
        // Replaying one of the frame's signed requests.
        let mut request = signed_request(&f.state, &frame, "GET", &f.path(), vec![]);
        request.headers_mut().insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Capability {token}")).unwrap(),
        );
        let replay = crate::test_support::clone_request(&request);
        assert_eq!(f.send(request).await.status(), StatusCode::OK);
        expect_error(f.send(replay).await, StatusCode::UNAUTHORIZED, "replayed").await;
        // The owner key itself cannot stand in for the frame key.
        expect_error(
            f.frame_get(&token, &f.owner).await,
            StatusCode::UNAUTHORIZED,
            "capability_key_mismatch",
        )
        .await;
        // Revoking the delegation stops the capability immediately.
        f.security
            .delete_delegation(&f.id, &app.id())
            .await
            .unwrap();
        expect_error(
            f.frame_get(&token, &frame).await,
            StatusCode::FORBIDDEN,
            "not_delegated",
        )
        .await;
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_capability_misuse_is_refused_with_a_specific_reason() {
        let f = fixture(43).await;
        let app = Agent::new(44);
        let frame = Agent::new(45);
        f.security
            .put_delegation(&f.id, &app.id(), None)
            .await
            .unwrap();
        type Edit = Box<dyn Fn(&mut Claims)>;
        let cases: Vec<(Edit, StatusCode, &str)> = vec![
            (
                Box::new(|c| c.aud = "https://other-proxy.example".into()),
                StatusCode::UNAUTHORIZED,
                "wrong_audience",
            ),
            (
                Box::new(|c| c.exp = crate::now_secs() - 1),
                StatusCode::UNAUTHORIZED,
                "capability_expired",
            ),
            (
                Box::new(|c| c.exp = crate::now_secs() + crate::capability::MAX_LIFETIME_SECS + 60),
                StatusCode::UNAUTHORIZED,
                "capability_too_long",
            ),
            (
                Box::new(|c| c.platform = "github-issues".into()),
                StatusCode::FORBIDDEN,
                "capability_scope",
            ),
            (
                Box::new(|c| c.connection_id = crate::connect::random()),
                StatusCode::FORBIDDEN,
                "capability_scope",
            ),
            (
                Box::new(|c| c.app = Agent::new(46).id()),
                StatusCode::FORBIDDEN,
                "not_delegated",
            ),
        ];
        for (edit, status, code) in cases {
            let mut claims = f.claims(&app, &frame);
            edit(&mut claims);
            let token = mint(&f.owner, &claims);
            expect_error(f.frame_get(&token, &frame).await, status, code).await;
        }
        // Minted by someone other than the connection owner (even by the
        // delegated app itself).
        let token = mint(&app, &f.claims(&app, &frame));
        expect_error(
            f.frame_get(&token, &frame).await,
            StatusCode::UNAUTHORIZED,
            "invalid_capability",
        )
        .await;
        // #72's v1 bearer capability is gone.
        let v1 = format!(
            "{}.sig",
            base64::Engine::encode(
                &base64::engine::general_purpose::URL_SAFE_NO_PAD,
                format!(
                    r#"{{"v":1,"connection_id":"{}","platform":"clockify","exp":1}}"#,
                    f.id
                )
            )
        );
        expect_error(
            f.frame_get(&v1, &frame).await,
            StatusCode::UNAUTHORIZED,
            "invalid_capability",
        )
        .await;
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL and fixture OAuth credentials; CI runs it"]
    async fn postgres_concurrent_requests_refresh_an_expired_token_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let token_requests = std::sync::Arc::new(AtomicUsize::new(0));
        let token_counter = token_requests.clone();
        let upstream = axum::Router::new()
            .route(
                "/token",
                axum::routing::post(move |body: Bytes| {
                    let token_counter = token_counter.clone();
                    async move {
                        token_counter.fetch_add(1, Ordering::SeqCst);
                        assert!(String::from_utf8(body.to_vec())
                            .unwrap()
                            .contains("grant_type=refresh_token"));
                        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                        axum::Json(json!({"access_token": "refreshed-token", "expires_in": 3600, "refresh_token": "rotated-refresh"}))
                    }
                }),
            )
            .route(
                "/items",
                axum::routing::get(|headers: HeaderMap| async move {
                    assert_eq!(headers.get(AUTHORIZATION).unwrap(), "Bearer refreshed-token");
                    (
                        [(header::ETAG, "\"v1\""), (header::LINK, "<https://example/items?page=2>; rel=\"next\"")],
                        axum::Json(json!([{"id": 1}])),
                    )
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let security = security().await;
        let mut s = state(Some(security.clone()));
        s.catalog = crate::catalog::Catalog::from_test_document(
            "github-issues",
            json!({
                "servers": [{"url": upstream_url}],
                "components": {"securitySchemes": {"oauth": {"type": "oauth2", "flows": {
                    "authorizationCode": {
                        "authorizationUrl": "https://auth.example/authorize",
                        "tokenUrl": "https://auth.example/token",
                        "scopes": {"read": "Read items"}
                    }
                }}}},
                "security": [{"oauth": ["read"]}],
                "paths": {"/items": {"get": {}}}
            }),
            json!({}),
        );
        s.test_upstream = Some(upstream_url);
        let owner = Agent::new(47);
        let credential = serde_json::to_vec(&StoredCredential::OAuth {
            provider: "github-issues".into(),
            access_token: "stale-token".into(),
            refresh_token: Some("a-refresh-token".into()),
            expires_at: Some(0),
        })
        .unwrap();
        let id = security
            .create_connection("github-issues", &owner.id(), &credential)
            .await
            .unwrap();
        let path = format!("/proxy/{id}/github-issues/items");
        let (a, b) = tokio::join!(
            crate::router(s.clone()).oneshot(signed_request(&s, &owner, "GET", &path, vec![])),
            crate::router(s.clone()).oneshot(signed_request(&s, &owner, "GET", &path, vec![])),
        );
        let (a, b) = (a.unwrap(), b.unwrap());
        assert_eq!(a.status(), StatusCode::OK);
        assert_eq!(b.status(), StatusCode::OK);
        assert_eq!(a.headers()[header::ETAG], "\"v1\"");
        assert!(a.headers().get(header::LINK).is_some());
        assert_eq!(token_requests.load(Ordering::SeqCst), 1);
        let stored: StoredCredential = serde_json::from_slice(
            &security
                .load_connection(&id)
                .await
                .unwrap()
                .unwrap()
                .credential,
        )
        .unwrap();
        match stored {
            StoredCredential::OAuth {
                access_token,
                refresh_token,
                ..
            } => {
                assert_eq!(access_token, "refreshed-token");
                assert_eq!(refresh_token.as_deref(), Some("rotated-refresh"));
            }
            StoredCredential::ApiKey { .. } => panic!("expected an OAuth credential"),
        }
        server.abort();
    }
}
