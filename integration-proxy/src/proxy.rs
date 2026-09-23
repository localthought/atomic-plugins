use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::{
    body::Bytes,
    extract::{Form, Path, Query, RawQuery, State},
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse, Redirect, Response},
    Json,
};
use axum_extra::extract::PrivateCookieJar;
use serde::{Deserialize, Serialize};
use serde_json::json;
use url::Url;

use crate::{session, templates, tenant_secret, AppState};

/// Builds the path (with query string) to reopen `/connect` for a given
/// `redirect_uri`, used to send a user back here after a login detour.
pub fn connect_url(redirect_uri: &str) -> String {
    let query: String = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("redirect_uri", redirect_uri)
        .finish();
    format!("/connect?{query}")
}

pub fn oauth_start_url(platform: &str, params: &ConnectParams) -> String {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("redirect_uri", &params.redirect_uri)
        .append_pair("ts", &params.ts.to_string())
        .append_pair("nonce", &params.nonce)
        .append_pair("challenge", &params.challenge)
        .append_pair("tenant_id", &params.tenant_id)
        .append_pair("user_id", &params.user_id)
        .append_pair("user_id_sig", &params.user_id_sig)
        .append_pair("response", &params.response)
        .finish();
    format!("/oauth/{platform}/start?{query}")
}

fn parse_redirect_uri(raw: &str) -> Result<Url, ConnectError> {
    let url = Url::parse(raw).map_err(|_| ConnectError::InvalidRedirect)?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(ConnectError::InvalidRedirect);
    }
    Ok(url)
}

#[derive(Deserialize)]
pub struct ConnectParams {
    pub redirect_uri: String,
    pub ts: u64,
    pub nonce: String,
    pub challenge: String,
    pub tenant_id: String,
    pub user_id: String,
    pub user_id_sig: String,
    pub response: String,
}

#[derive(Serialize)]
pub struct SessionChallenge {
    ts: u64,
    challenge: String,
    nonce: String,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_secs()
}
pub fn now_unix() -> u64 {
    now()
}

fn challenge(server_secret: &str, ts: u64, nonce: &str) -> String {
    tenant_secret::sign(server_secret, &format!("{ts}.{nonce}"))
}

pub async fn session_challenge(State(state): State<AppState>) -> Json<SessionChallenge> {
    let ts = now();
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let nonce = URL_SAFE_NO_PAD.encode(bytes);
    Json(SessionChallenge {
        ts,
        challenge: challenge(&state.server_secret, ts, &nonce),
        nonce,
    })
}

pub async fn verify_connect(state: &AppState, params: &ConnectParams) -> Result<(), ConnectError> {
    if params.ts > now() || now().saturating_sub(params.ts) > 600 {
        return Err(ConnectError::InvalidSession);
    }
    if !tenant_secret::verify_signature(
        &state.server_secret,
        &format!("{}.{}", params.ts, params.nonce),
        &params.challenge,
    ) {
        return Err(ConnectError::InvalidSession);
    }
    let tenant_secret = tenant_secret::derive(&state.server_secret, &params.tenant_id);
    if !tenant_secret::verify_signature(&tenant_secret, &params.challenge, &params.response)
        || !tenant_secret::verify_signature(&tenant_secret, &params.user_id, &params.user_id_sig)
    {
        return Err(ConnectError::InvalidSession);
    }
    if state
        .security
        .as_ref()
        .is_some_and(|security| security.is_revoked(&params.tenant_id, &params.user_id))
    {
        return Err(ConnectError::Revoked);
    }
    Ok(())
}

/// Shows the "connect this app" consent screen for a signed-in user, or
/// sends them to log in first (remembering where to come back to).
pub async fn connect_page(
    State(state): State<AppState>,
    Query(params): Query<ConnectParams>,
    jar: PrivateCookieJar,
) -> Result<Response, ConnectError> {
    parse_redirect_uri(&params.redirect_uri)?;
    verify_connect(&state, &params).await?;

    match session::read_session(&jar) {
        Some(_) => {
            Ok(Html(templates::render_connect(&params, &state.catalog.names())).into_response())
        }
        None => {
            let mut target = url::Url::parse("https://localhost/connect").unwrap();
            target
                .query_pairs_mut()
                .append_pair("redirect_uri", &params.redirect_uri)
                .append_pair("ts", &params.ts.to_string())
                .append_pair("nonce", &params.nonce)
                .append_pair("challenge", &params.challenge)
                .append_pair("tenant_id", &params.tenant_id)
                .append_pair("user_id", &params.user_id)
                .append_pair("user_id_sig", &params.user_id_sig)
                .append_pair("response", &params.response);
            let jar = session::set_connect_redirect(
                jar,
                &format!("/connect?{}", target.query().unwrap()),
            );
            Ok((jar, Redirect::to("/auth/login")).into_response())
        }
    }
}

#[derive(Deserialize)]
pub struct ConnectConfirmForm {
    pub redirect_uri: String,
    pub ts: u64,
    pub nonce: String,
    pub challenge: String,
    pub tenant_id: String,
    pub user_id: String,
    pub user_id_sig: String,
    pub response: String,
}

/// Confirms the connection and redirects back to the caller with the
/// signed-in user's deterministic tenant secret attached as `?secret=`.
pub async fn connect_confirm(
    State(state): State<AppState>,
    jar: PrivateCookieJar,
    Form(form): Form<ConnectConfirmForm>,
) -> Result<Redirect, ConnectError> {
    let params = ConnectParams {
        redirect_uri: form.redirect_uri,
        ts: form.ts,
        nonce: form.nonce,
        challenge: form.challenge,
        tenant_id: form.tenant_id,
        user_id: form.user_id,
        user_id_sig: form.user_id_sig,
        response: form.response,
    };
    let mut redirect_uri = parse_redirect_uri(&params.redirect_uri)?;
    verify_connect(&state, &params).await?;
    if let Some(security) = &state.security {
        if !security
            .consume_nonce(&params.nonce)
            .await
            .map_err(|_| ConnectError::InvalidSession)?
        {
            return Err(ConnectError::InvalidSession);
        }
    }
    let user = session::read_session(&jar).ok_or(ConnectError::NotLoggedIn)?;

    let secret = tenant_secret::derive(&state.server_secret, &user.subject);
    redirect_uri
        .query_pairs_mut()
        .append_pair("secret", &secret);

    Ok(Redirect::to(redirect_uri.as_str()))
}

/// Minimal authenticated endpoint other services (e.g. atomic-server) call
/// to check a tenant secret is legitimate.
pub async fn proxy(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));

    match token.and_then(|token| tenant_secret::verify(&state.server_secret, token)) {
        Some(_identity) => Json(json!({ "ok": true })).into_response(),
        None => (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "ok": false, "error": "invalid or missing bearer token" })),
        )
            .into_response(),
    }
}

/// The credential sealed into a connection code, opaque to the
/// PKCE/handoff/rotation machinery and only interpreted here and where it's
/// minted (`oauth.rs`'s callback, `connect.rs`'s apiKey `authorize` branch).
#[derive(Deserialize, Serialize)]
#[serde(tag = "kind")]
pub(crate) enum StoredCredential {
    #[serde(rename = "oauth")]
    OAuth {
        provider: String,
        tenant_id: String,
        user_id: String,
        access_token: String,
        refresh_token: Option<String>,
        expires_at: Option<u64>,
    },
    #[serde(rename = "api_key")]
    ApiKey {
        provider: String,
        tenant_id: String,
        user_id: String,
        key: String,
    },
}

impl StoredCredential {
    fn provider(&self) -> &str {
        match self {
            Self::OAuth { provider, .. } | Self::ApiKey { provider, .. } => provider,
        }
    }
    fn tenant_id(&self) -> &str {
        match self {
            Self::OAuth { tenant_id, .. } | Self::ApiKey { tenant_id, .. } => tenant_id,
        }
    }
    fn user_id(&self) -> &str {
        match self {
            Self::OAuth { user_id, .. } | Self::ApiKey { user_id, .. } => user_id,
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
        StoredCredential::OAuth { expires_at: Some(expires), .. } if *expires <= now() + 30
    )
}

async fn refresh_if_needed(state: &AppState, credential: &mut StoredCredential) -> Result<(), ()> {
    if !needs_refresh(credential) {
        return Ok(());
    }
    let StoredCredential::OAuth {
        provider,
        access_token,
        refresh_token,
        expires_at,
        ..
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
    *expires_at = token.expires_in.map(|seconds| now() + seconds);
    Ok(())
}

/// Associated data for a connection code's envelope, whether it holds a
/// sealed credential (legacy) or a [`CodePointer`].
pub(crate) const CODE_AAD: &[u8] = b"connection-credential-v1";

/// What a connection code seals once its credential lives in a persistent
/// connection (issue #40): a pointer, so the row stays the credential's one
/// server-side copy and a refreshed or rotated refresh token is never held in
/// two places.
#[derive(Deserialize, Serialize)]
#[serde(tag = "kind")]
pub(crate) enum CodePointer {
    #[serde(rename = "connection")]
    Connection { connection_id: String },
}

/// Test helper: redeems `code` and returns the connection it points at and
/// that connection's serialized credential.
#[cfg(test)]
pub(crate) async fn take_code_credential(
    security: &crate::security::Security,
    code: &str,
) -> Option<(String, Vec<u8>)> {
    let envelope = security.take_connection_code(code).await.ok()??;
    let plaintext = security.open(&envelope, CODE_AAD)?;
    let CodePointer::Connection { connection_id } = serde_json::from_slice(&plaintext).ok()?;
    let record = security.load_connection(&connection_id).await.ok()??;
    Some((connection_id, record.credential))
}

/// Seals a fresh single-use connection code pointing at `connection_id`.
pub(crate) async fn mint_code_for_connection(
    security: &crate::security::Security,
    connection_id: &str,
) -> Result<String, String> {
    let envelope = security.seal(
        &serde_json::to_vec(&CodePointer::Connection {
            connection_id: connection_id.to_owned(),
        })
        .map_err(|e| e.to_string())?,
        CODE_AAD,
    )?;
    let code = crate::connect::random();
    security.store_connection_code(&code, &envelope).await?;
    Ok(code)
}

/// How the caller authenticated. Decides what happens to the credential
/// after the request.
enum Presented {
    /// `Authorization: Bearer <connection code>`: single use, a successor
    /// code is returned in `x-connection-code`.
    Code,
    /// `Authorization: Capability <token>`, or a request signed with the
    /// connection DID's key: nothing rotates.
    Key,
}

fn unauthorized(message: &'static str) -> Response {
    (StatusCode::UNAUTHORIZED, message).into_response()
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

async fn load_connection(
    security: &crate::security::Security,
    connection_id: &str,
) -> Option<crate::security::ConnectionRecord> {
    if connection_id.len() != 43 {
        return None;
    }
    security.load_connection(connection_id).await.ok().flatten()
}

/// Resolves the request's credentials to a persistent connection id (for
/// every presentation except a legacy code) and the credential to use.
///
/// A legacy code, which seals the credential itself, is migrated on first
/// use: its credential moves into a new connection row and its successor is
/// a pointer, so every client ends up backed by a row without changing.
// The error is the finished response; boxing it would buy nothing here.
#[allow(clippy::result_large_err)]
async fn authenticate(
    security: &crate::security::Security,
    platform: &str,
    method: &axum::http::Method,
    uri: &axum::http::Uri,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<(String, Presented, StoredCredential), Response> {
    let authorization = header_str(headers, header::AUTHORIZATION.as_str());
    if let Some(code) = authorization.and_then(|v| v.strip_prefix("Bearer ")) {
        let Ok(Some(envelope)) = security.take_connection_code(code).await else {
            return Err(unauthorized("invalid or expired connection code"));
        };
        let Some(plaintext) = security.open(&envelope, CODE_AAD) else {
            return Err(unauthorized("invalid connection code"));
        };
        if let Ok(CodePointer::Connection { connection_id }) =
            serde_json::from_slice::<CodePointer>(&plaintext)
        {
            let record = load_connection(security, &connection_id)
                .await
                .ok_or_else(|| unauthorized("invalid or expired connection code"))?;
            let credential = serde_json::from_slice::<StoredCredential>(&record.credential)
                .map_err(|_| unauthorized("invalid connection code"))?;
            return Ok((connection_id, Presented::Code, credential));
        }
        let credential = serde_json::from_slice::<StoredCredential>(&plaintext)
            .map_err(|_| unauthorized("invalid connection code"))?;
        // Checked here as well as by the caller: a revoked or misdirected
        // credential must not be migrated into a row.
        if credential.provider() != platform
            || security.is_revoked(credential.tenant_id(), credential.user_id())
        {
            return Err((StatusCode::FORBIDDEN, "credential is not permitted").into_response());
        }
        let connection_id = security
            .create_connection(
                credential.provider(),
                credential.tenant_id(),
                credential.user_id(),
                &plaintext,
            )
            .await
            .map_err(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "credential rotation failed",
                )
                    .into_response()
            })?;
        return Ok((connection_id, Presented::Code, credential));
    }

    let now_secs = now();
    if let Some(token) = authorization.and_then(|v| v.strip_prefix("Capability ")) {
        use crate::did_auth::{parse_capability, verify_capability, CapabilityRejection};
        let (claims, payload, signature) =
            parse_capability(token).map_err(|_| unauthorized("invalid capability"))?;
        let record = load_connection(security, &claims.connection_id)
            .await
            .ok_or_else(|| unauthorized("invalid capability"))?;
        match verify_capability(&record.user_id, &claims, payload, signature, now_secs) {
            Ok(()) => {}
            Err(CapabilityRejection::Expired) => return Err(unauthorized("capability expired")),
            Err(CapabilityRejection::TooLong) => {
                return Err(unauthorized("capability lifetime exceeds 15 minutes"))
            }
            Err(_) => return Err(unauthorized("invalid capability")),
        }
        if claims.platform != platform || record.platform != platform {
            return Err((StatusCode::FORBIDDEN, "credential is not permitted").into_response());
        }
        let credential = serde_json::from_slice::<StoredCredential>(&record.credential)
            .map_err(|_| unauthorized("invalid capability"))?;
        return Ok((claims.connection_id, Presented::Key, credential));
    }
    if authorization.is_some() {
        return Err(unauthorized("unsupported authorization scheme"));
    }

    let (Some(connection_id), Some(timestamp), Some(signature)) = (
        header_str(headers, "x-connection-id"),
        header_str(headers, "x-connection-timestamp"),
        header_str(headers, "x-connection-signature"),
    ) else {
        return Err(unauthorized("missing connection code"));
    };
    use crate::did_auth::{replay_key, request_message, verify_request, RequestRejection};
    let Ok(timestamp) = timestamp.parse::<u64>() else {
        return Err(unauthorized("stale connection signature"));
    };
    let record = load_connection(security, connection_id)
        .await
        .ok_or_else(|| unauthorized("invalid connection signature"))?;
    let path_and_query = uri.path_and_query().map_or(uri.path(), |p| p.as_str());
    let message = request_message(
        connection_id,
        method.as_str(),
        path_and_query,
        timestamp,
        body,
    );
    match verify_request(
        &record.user_id,
        &message,
        timestamp,
        now_secs.saturating_mul(1000),
        signature,
    ) {
        Ok(()) => {}
        Err(RequestRejection::Stale) => return Err(unauthorized("stale connection signature")),
        Err(RequestRejection::BadSignature) => {
            return Err(unauthorized("invalid connection signature"))
        }
    }
    if !matches!(
        security.consume_nonce(&replay_key(&message)).await,
        Ok(true)
    ) {
        return Err(unauthorized("connection signature already used"));
    }
    if record.platform != platform {
        return Err((StatusCode::FORBIDDEN, "credential is not permitted").into_response());
    }
    let credential = serde_json::from_slice::<StoredCredential>(&record.credential)
        .map_err(|_| unauthorized("invalid connection signature"))?;
    Ok((connection_id.to_owned(), Presented::Key, credential))
}

/// Refreshes a connection's OAuth token if it is about to expire, with at
/// most one refresh in flight per connection (see
/// `Security::claim_refresh_lease`). A caller that loses the race waits for
/// the winner's result instead of spending the refresh token again.
async fn refresh_connection(
    state: &AppState,
    security: &crate::security::Security,
    connection_id: &str,
    credential: &mut StoredCredential,
) -> Result<(), ()> {
    const ATTEMPTS: usize = 50;
    const WAIT: std::time::Duration = std::time::Duration::from_millis(200);
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
            if let Some(current) = load_connection(security, connection_id).await {
                if let Ok(current) = serde_json::from_slice(&current.credential) {
                    *credential = current;
                }
            }
            if !needs_refresh(credential) {
                let _ = security.release_refresh_lease(connection_id).await;
                return Ok(());
            }
            if refresh_if_needed(state, credential).await.is_err() {
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
        let current = load_connection(security, connection_id).await.ok_or(())?;
        *credential = serde_json::from_slice(&current.credential).map_err(|_| ())?;
    }
    Err(())
}

/// How to attach a resolved credential to the outbound upstream request.
/// `None` covers query-located API keys, already appended to the target URL
/// before the request is built.
enum CredentialInjection {
    Bearer(String),
    Header { name: String, value: String },
    None,
}

/// `ANY /proxy/{platform}/{path}`. Accepts three presentations, all resolving
/// to a persistent connection (issue #40):
///
/// - `Authorization: Bearer <connection code>`: single use; the response
///   carries a successor in `x-connection-code`.
/// - `Authorization: Capability <token>`: a short-lived token signed by the
///   connection DID's key (see `did_auth`); reusable until it expires.
/// - `x-connection-id`, `x-connection-timestamp`, `x-connection-signature`:
///   this request, signed by the connection DID's key; single use.
///
/// Every response to an authenticated request carries `x-connection-id`.
pub async fn forward(
    Path(path): Path<String>,
    RawQuery(query): RawQuery,
    State(state): State<AppState>,
    method: axum::http::Method,
    uri: axum::http::Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some((platform, path)) = path.split_once('/') else {
        return (
            StatusCode::NOT_FOUND,
            "proxy platform and path are required",
        )
            .into_response();
    };
    let request_path = format!("/{path}");
    if contains_traversal_segment(&request_path) {
        return (
            StatusCode::BAD_REQUEST,
            "path must not contain traversal segments",
        )
            .into_response();
    }
    if body.len() > 1_048_576 {
        return (StatusCode::PAYLOAD_TOO_LARGE, "request body is too large").into_response();
    }
    let Some(security) = &state.security else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "security service unavailable",
        )
            .into_response();
    };
    let (connection_id, presented, mut credential) =
        match authenticate(security, platform, &method, &uri, &headers, &body).await {
            Ok(resolved) => resolved,
            Err(response) => return response,
        };
    if credential.provider() != platform
        || security.is_revoked(credential.tenant_id(), credential.user_id())
    {
        return (StatusCode::FORBIDDEN, "credential is not permitted").into_response();
    }
    // Only an authenticated use keeps a connection alive.
    let _ = security.touch_connection(&connection_id).await;
    // A code has been spent by now. Mint its successor before anything else
    // can fail, so an error below (a refused path, a failed refresh, an
    // upstream outage) no longer costs the caller its connection.
    let successor = match presented {
        Presented::Code => match mint_code_for_connection(security, &connection_id).await {
            Ok(code) => Some(code),
            Err(_) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "credential rotation failed",
                )
                    .into_response()
            }
        },
        Presented::Key => None,
    };
    let finish = |mut response: Response| {
        let headers = response.headers_mut();
        if let Ok(value) = axum::http::HeaderValue::from_str(&connection_id) {
            headers.insert("x-connection-id", value);
        }
        if let Some(code) = &successor {
            if let Ok(value) = axum::http::HeaderValue::from_str(code) {
                headers.insert("x-connection-code", value);
            }
        }
        response
    };
    if refresh_connection(&state, security, &connection_id, &mut credential)
        .await
        .is_err()
    {
        return finish((StatusCode::UNAUTHORIZED, "credential refresh failed").into_response());
    }
    let Some(required_headers) =
        state
            .catalog
            .required_headers(platform, method.as_str(), &request_path)
    else {
        return finish(
            (
                StatusCode::NOT_FOUND,
                "method or path is not in the catalog",
            )
                .into_response(),
        );
    };
    let Some(mut target) = state
        .catalog
        .allows(platform, method.as_str(), &request_path)
    else {
        return finish(
            (
                StatusCode::NOT_FOUND,
                "method or path is not in the catalog",
            )
                .into_response(),
        );
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
        return finish((StatusCode::BAD_REQUEST, message).into_response());
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
                return finish(
                    (StatusCode::UNAUTHORIZED, "invalid connection code").into_response(),
                );
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
                    return finish(
                        (
                            StatusCode::NOT_IMPLEMENTED,
                            "cookie-located API keys are not supported",
                        )
                            .into_response(),
                    );
                }
            }
        }
    };
    let upstream = match upstream_request(
        &state.http_client,
        method.clone(),
        target.clone(),
        injection,
        &headers,
        &required_headers,
        body,
    )
    .send()
    .await
    {
        Ok(response) => response,
        Err(_) => {
            return finish((StatusCode::BAD_GATEWAY, "upstream request failed").into_response())
        }
    };
    let status = upstream.status();
    let forwarded_headers = upstream_response_headers(upstream.headers());
    let bytes = match read_bounded_body(upstream, MAX_RESPONSE_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return finish(
                (
                    StatusCode::BAD_GATEWAY,
                    "upstream response failed or was too large",
                )
                    .into_response(),
            )
        }
    };
    let mut response = Response::new(bytes.into());
    *response.status_mut() = status;
    *response.headers_mut() = forwarded_headers;
    finish(response)
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

#[derive(Debug)]
pub enum ConnectError {
    InvalidRedirect,
    NotLoggedIn,
    InvalidSession,
    Revoked,
}

impl IntoResponse for ConnectError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            ConnectError::InvalidRedirect => (
                StatusCode::BAD_REQUEST,
                "redirect_uri is missing or invalid",
            ),
            ConnectError::NotLoggedIn => (StatusCode::UNAUTHORIZED, "please log in first"),
            ConnectError::InvalidSession => (
                StatusCode::UNAUTHORIZED,
                "invalid or expired tenant session",
            ),
            ConnectError::Revoked => (StatusCode::FORBIDDEN, "tenant or user is revoked"),
        };
        (status, message).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{header::AUTHORIZATION, HeaderValue};
    use axum_extra::extract::cookie::Key;
    use tower::ServiceExt;

    fn test_state(server_secret: &str) -> AppState {
        let config = crate::config::Config {
            app_auth_client_id: "test-client-id".to_string(),
            app_auth_client_secret: "test-client-secret".to_string(),
            app_auth_authorization_url: "https://accounts.example/authorize".to_string(),
            app_auth_token_url: "https://accounts.example/token".to_string(),
            app_auth_userinfo_url: "https://accounts.example/userinfo".to_string(),
            app_auth_label: "OIDC".to_string(),
            app_auth_identity_namespace: None,
            base_url: "http://localhost:8080".to_string(),
            port: 8080,
            session_secret: None,
            server_secret: server_secret.to_string(),
            catalog_path: "catalog.yaml".to_string(),
            database_url: "postgres://unused".to_string(),
            encryption_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_string(),
            revoked_subjects: vec![],
        };
        AppState {
            oauth_client: crate::auth::build_client(&config).unwrap(),
            app_auth_userinfo_url: config.app_auth_userinfo_url.clone(),
            app_auth_label: config.app_auth_label.clone(),
            app_auth_identity_namespace: config.app_auth_identity_namespace.clone(),
            http_client: crate::build_http_client(),
            identity_http_client: crate::build_identity_http_client(),
            key: Key::generate(),
            server_secret: config.server_secret,
            base_url: config.base_url,
            catalog: crate::catalog::Catalog::default(),
            security: None,
            test_upstream: None,
        }
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

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_forward_injects_the_declared_api_key_header_and_rotates_the_code() {
        let db = std::env::var("TEST_DATABASE_URL")
            .expect("set TEST_DATABASE_URL to an isolated test database");
        let security = crate::security::Security::connect(
            &db,
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            vec![],
        )
        .await
        .unwrap();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new().route(
            "/workspaces",
            axum::routing::get(|headers: HeaderMap| async move {
                Json(json!({
                    "authorization": headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()),
                    "x_api_key": headers.get("x-api-key").and_then(|v| v.to_str().ok()),
                }))
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let mut s = test_state("fixture-server-secret");
        s.security = Some(security.clone());
        s.catalog = crate::catalog::Catalog::from_test_document(
            "clockify",
            serde_json::json!({
                "servers": [{"url": format!("http://{address}")}],
                "components": {"securitySchemes": {"clockifyApiKey": {
                    "type": "apiKey", "in": "header", "name": "X-Api-Key"
                }}},
                "security": [{"clockifyApiKey": []}],
                "paths": {"/workspaces": {"get": {}}}
            }),
            serde_json::json!({}),
        );

        let credential = StoredCredential::ApiKey {
            provider: "clockify".into(),
            tenant_id: "tenant".into(),
            user_id: "did:ad:agent:test".into(),
            key: "clockify-secret".into(),
        };
        let envelope = security
            .seal(
                &serde_json::to_vec(&credential).unwrap(),
                b"connection-credential-v1",
            )
            .unwrap();
        let code = "test-connection-code".to_string();
        security
            .store_connection_code(&code, &envelope)
            .await
            .unwrap();

        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {code}")).unwrap(),
        );
        let response = forward(
            Path("clockify/workspaces".to_string()),
            RawQuery(None),
            State(s),
            axum::http::Method::GET,
            "/proxy/clockify/workspaces".parse().unwrap(),
            headers,
            Bytes::new(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let new_code = response.headers()["x-connection-code"]
            .to_str()
            .unwrap()
            .to_string();
        assert_ne!(new_code, code);
        let body = axum::body::to_bytes(response.into_body(), 16384)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["x_api_key"], "clockify-secret");
        assert_eq!(body["authorization"], serde_json::Value::Null);

        // The redeemed code is single-use; only the rotated code now works.
        assert!(security
            .take_connection_code(&code)
            .await
            .unwrap()
            .is_none());
        assert!(security
            .take_connection_code(&new_code)
            .await
            .unwrap()
            .is_some());
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
        let mut state = test_state("server-secret");
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
                    .uri("/proxy/github-issues/repositories/../issues")
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

    /// End-to-end coverage of `forward()` through the real router: an
    /// expired credential is refreshed at the (mocked) provider token
    /// endpoint, the resulting access token is used to call the (mocked)
    /// provider API, the response is forwarded with its pagination/ETag
    /// headers intact, and the one-time connection code is rotated.
    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL and fixture OAuth credentials"]
    async fn forward_refreshes_an_expired_credential_and_forwards_the_response() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let token_requests = std::sync::Arc::new(AtomicUsize::new(0));
        let item_requests = std::sync::Arc::new(AtomicUsize::new(0));
        let token_counter = token_requests.clone();
        let item_counter = item_requests.clone();
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
                        Json(json!({"access_token": "refreshed-token", "expires_in": 3600}))
                    }
                }),
            )
            .route(
                "/items",
                axum::routing::get(move |headers: HeaderMap| {
                    let item_counter = item_counter.clone();
                    async move {
                        item_counter.fetch_add(1, Ordering::SeqCst);
                        assert_eq!(
                            headers.get(AUTHORIZATION).unwrap(),
                            "Bearer refreshed-token"
                        );
                        (
                            [
                                (header::ETAG, "\"v1\""),
                                (header::LINK, "<https://example/items?page=2>; rel=\"next\""),
                            ],
                            Json(json!([{"id": 1}])),
                        )
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });

        let db = std::env::var("TEST_DATABASE_URL").unwrap();
        let security = crate::security::Security::connect(
            &db,
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            vec![],
        )
        .await
        .unwrap();

        let document = json!({
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
        });
        let mut state = test_state("server-secret");
        state.catalog =
            crate::catalog::Catalog::from_test_document("github-issues", document, json!({}));
        state.security = Some(security.clone());
        state.test_upstream = Some(upstream_url);

        let credential = StoredCredential::OAuth {
            provider: "github-issues".into(),
            tenant_id: "tenant".into(),
            user_id: "user".into(),
            access_token: "stale-token".into(),
            refresh_token: Some("a-refresh-token".into()),
            expires_at: Some(0),
        };
        let envelope = security
            .seal(
                &serde_json::to_vec(&credential).unwrap(),
                b"connection-credential-v1",
            )
            .unwrap();
        let old_code = "e2e-test-connection-code";
        security
            .store_connection_code(old_code, &envelope)
            .await
            .unwrap();

        let response = crate::router(state)
            .oneshot(
                axum::http::Request::builder()
                    .uri("/proxy/github-issues/items")
                    .header(AUTHORIZATION, format!("Bearer {old_code}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(token_requests.load(Ordering::SeqCst), 1);
        assert_eq!(item_requests.load(Ordering::SeqCst), 1);
        let new_code = response
            .headers()
            .get("x-connection-code")
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        assert_ne!(new_code, old_code);
        assert_eq!(response.headers()[header::ETAG], "\"v1\"");
        assert!(response.headers().get(header::LINK).is_some());
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            json!([{"id": 1}])
        );

        // The old code is single-use and already consumed.
        assert!(security
            .take_connection_code(old_code)
            .await
            .unwrap()
            .is_none());
        // The rotated code is valid and points at the connection, which now
        // holds the refreshed credential.
        let (_, plaintext) = take_code_credential(&security, &new_code).await.unwrap();
        let rotated: StoredCredential = serde_json::from_slice(&plaintext).unwrap();
        match rotated {
            StoredCredential::OAuth { access_token, .. } => {
                assert_eq!(access_token, "refreshed-token");
            }
            StoredCredential::ApiKey { .. } => panic!("expected an OAuth credential"),
        }

        server.abort();
    }

    async fn test_security() -> crate::security::Security {
        let db = std::env::var("TEST_DATABASE_URL")
            .expect("set TEST_DATABASE_URL to an isolated test database");
        crate::security::Security::connect(
            &db,
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            vec![],
        )
        .await
        .unwrap()
    }

    /// An upstream that echoes the API key it received, and the catalog for it.
    async fn api_key_upstream() -> (tokio::task::JoinHandle<()>, crate::catalog::Catalog) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new().route(
            "/workspaces",
            axum::routing::any(|headers: HeaderMap| async move {
                Json(json!({
                    "x_api_key": headers.get("x-api-key").and_then(|v| v.to_str().ok()),
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

    fn api_key_credential(user_id: &str) -> Vec<u8> {
        serde_json::to_vec(&StoredCredential::ApiKey {
            provider: "clockify".into(),
            tenant_id: "tenant".into(),
            user_id: user_id.into(),
            key: "clockify-secret".into(),
        })
        .unwrap()
    }

    fn signed(
        agent: &crate::did_auth::test_signer::Agent,
        connection_id: &str,
        method: &str,
        uri: &str,
        body: &'static [u8],
    ) -> axum::http::Request<axum::body::Body> {
        // Distinct per call, so two otherwise identical requests are not
        // mistaken for a replay of each other.
        static OFFSET: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let timestamp =
            now() * 1000 + OFFSET.fetch_add(1, std::sync::atomic::Ordering::SeqCst) % 1000;
        let message = crate::did_auth::request_message(connection_id, method, uri, timestamp, body);
        axum::http::Request::builder()
            .method(method)
            .uri(uri)
            .header("x-connection-id", connection_id)
            .header("x-connection-timestamp", timestamp.to_string())
            .header("x-connection-signature", agent.sign(&message))
            .header(header::CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from(body))
            .unwrap()
    }

    /// The same signed request again, headers and all (bodies here are fixed).
    fn request_clone(
        request: &axum::http::Request<axum::body::Body>,
    ) -> axum::http::Request<axum::body::Body> {
        let mut builder = axum::http::Request::builder()
            .method(request.method().clone())
            .uri(request.uri().clone());
        for (name, value) in request.headers() {
            builder = builder.header(name, value);
        }
        builder.body(axum::body::Body::from(&b"{}"[..])).unwrap()
    }

    fn with_capability(uri: &str, token: &str) -> axum::http::Request<axum::body::Body> {
        axum::http::Request::builder()
            .uri(uri)
            .header(AUTHORIZATION, format!("Capability {token}"))
            .body(axum::body::Body::empty())
            .unwrap()
    }

    async fn body_text(response: Response) -> String {
        String::from_utf8(
            axum::body::to_bytes(response.into_body(), 65_536)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap()
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_signed_requests_reach_a_connection_without_rotating_and_only_once() {
        use crate::did_auth::test_signer::Agent;
        let security = test_security().await;
        let (server, catalog) = api_key_upstream().await;
        let mut state = test_state("server-secret");
        state.catalog = catalog;
        state.security = Some(security.clone());
        let router = crate::router(state);

        let owner = Agent::new(11);
        let id = security
            .create_connection(
                "clockify",
                "tenant",
                &owner.did(),
                &api_key_credential(&owner.did()),
            )
            .await
            .unwrap();

        let request = signed(&owner, &id, "POST", "/proxy/clockify/workspaces", b"{}");
        let replay = request_clone(&request);
        let response = router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["x-connection-id"], id.as_str());
        assert!(response.headers().get("x-connection-code").is_none());
        assert!(body_text(response).await.contains("clockify-secret"));

        // Same message again (same second, same body): a replay.
        let response = router.clone().oneshot(replay).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        // Nothing rotated: the owner can keep signing, concurrently.
        let (a, b) = tokio::join!(
            router.clone().oneshot(signed(
                &owner,
                &id,
                "GET",
                "/proxy/clockify/workspaces",
                b""
            )),
            router.clone().oneshot(signed(
                &owner,
                &id,
                "GET",
                "/proxy/clockify/workspaces",
                b""
            )),
        );
        assert_eq!(a.unwrap().status(), StatusCode::OK);
        assert_eq!(b.unwrap().status(), StatusCode::OK);

        // Another agent's key, or a signature over a different request, fails.
        let intruder = Agent::new(12);
        let response = router
            .clone()
            .oneshot(signed(
                &intruder,
                &id,
                "GET",
                "/proxy/clockify/workspaces?i",
                b"",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let mut moved = signed(&owner, &id, "GET", "/proxy/clockify/workspaces?a", b"");
        *moved.uri_mut() = "/proxy/clockify/workspaces?b".parse().unwrap();
        assert_eq!(
            router.clone().oneshot(moved).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        let unknown = connect_random_id();
        assert_eq!(
            router
                .clone()
                .oneshot(signed(
                    &owner,
                    &unknown,
                    "GET",
                    "/proxy/clockify/workspaces",
                    b""
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        server.abort();
    }

    fn connect_random_id() -> String {
        crate::connect::random()
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_capabilities_are_reusable_until_expiry_and_scoped_to_one_platform() {
        use crate::did_auth::test_signer::Agent;
        let security = test_security().await;
        let (server, catalog) = api_key_upstream().await;
        let mut state = test_state("server-secret");
        state.catalog = catalog;
        state.security = Some(security.clone());
        let router = crate::router(state);

        let owner = Agent::new(21);
        let id = security
            .create_connection(
                "clockify",
                "tenant",
                &owner.did(),
                &api_key_credential(&owner.did()),
            )
            .await
            .unwrap();

        let token = owner.capability(&id, "clockify", now() + 300);
        for _ in 0..2 {
            let response = router
                .clone()
                .oneshot(with_capability("/proxy/clockify/workspaces", &token))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert!(response.headers().get("x-connection-code").is_none());
        }

        let expired = owner.capability(&id, "clockify", now() - 1);
        let response = router
            .clone()
            .oneshot(with_capability("/proxy/clockify/workspaces", &expired))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(body_text(response).await, "capability expired");

        let too_long = owner.capability(&id, "clockify", now() + 3600);
        assert_eq!(
            router
                .clone()
                .oneshot(with_capability("/proxy/clockify/workspaces", &too_long))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );

        let forged = Agent::new(22).capability(&id, "clockify", now() + 300);
        assert_eq!(
            router
                .clone()
                .oneshot(with_capability("/proxy/clockify/workspaces", &forged))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );

        // A capability names its platform; it cannot be spent on another.
        let elsewhere = owner.capability(&id, "clockify", now() + 300);
        assert_eq!(
            router
                .clone()
                .oneshot(with_capability(
                    "/proxy/github-issues/workspaces",
                    &elsewhere
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        server.abort();
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_a_legacy_code_migrates_into_a_connection_its_owner_can_sign_for() {
        use crate::did_auth::test_signer::Agent;
        let security = test_security().await;
        let (server, catalog) = api_key_upstream().await;
        let mut state = test_state("server-secret");
        state.catalog = catalog;
        state.security = Some(security.clone());
        let router = crate::router(state);

        let owner = Agent::new(31);
        let legacy = security
            .seal(&api_key_credential(&owner.did()), CODE_AAD)
            .unwrap();
        let code = crate::connect::random();
        security
            .store_connection_code(&code, &legacy)
            .await
            .unwrap();

        let response = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/proxy/clockify/workspaces")
                    .header(AUTHORIZATION, format!("Bearer {code}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let id = response.headers()["x-connection-id"]
            .to_str()
            .unwrap()
            .to_owned();
        let successor = response.headers()["x-connection-code"]
            .to_str()
            .unwrap()
            .to_owned();

        // The successor is a pointer; the credential lives only in the row.
        let envelope = security
            .take_connection_code(&successor)
            .await
            .unwrap()
            .unwrap();
        let pointer = security.open(&envelope, CODE_AAD).unwrap();
        assert!(!String::from_utf8_lossy(&pointer).contains("clockify-secret"));
        security
            .store_connection_code(&successor, &envelope)
            .await
            .unwrap();

        // The same grant is now reachable by signature, alongside the code.
        let response = router
            .clone()
            .oneshot(signed(
                &owner,
                &id,
                "GET",
                "/proxy/clockify/workspaces",
                b"",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let response = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/proxy/clockify/workspaces")
                    .header(AUTHORIZATION, format!("Bearer {successor}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["x-connection-id"], id.as_str());
        server.abort();
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_a_failed_request_no_longer_costs_the_code_holder_its_connection() {
        let security = test_security().await;
        let (server, catalog) = api_key_upstream().await;
        let mut state = test_state("server-secret");
        state.catalog = catalog;
        state.security = Some(security.clone());
        let router = crate::router(state);

        let id = security
            .create_connection("clockify", "tenant", "user", &api_key_credential("user"))
            .await
            .unwrap();
        let code = mint_code_for_connection(&security, &id).await.unwrap();
        // A path outside the catalog is refused after the code is spent, but
        // the refusal carries a successor.
        let response = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/proxy/clockify/not-in-catalog")
                    .header(AUTHORIZATION, format!("Bearer {code}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let successor = response.headers()["x-connection-code"]
            .to_str()
            .unwrap()
            .to_owned();
        let response = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/proxy/clockify/workspaces")
                    .header(AUTHORIZATION, format!("Bearer {successor}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        server.abort();
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL and fixture OAuth credentials"]
    async fn postgres_concurrent_callers_refresh_a_connection_once() {
        use crate::did_auth::test_signer::Agent;
        use std::sync::atomic::{AtomicUsize, Ordering};

        let token_requests = std::sync::Arc::new(AtomicUsize::new(0));
        let counter = token_requests.clone();
        let upstream = axum::Router::new()
            .route(
                "/token",
                axum::routing::post(move |body: Bytes| {
                    let counter = counter.clone();
                    async move {
                        // A provider that rotates refresh tokens: the old one
                        // is only good once.
                        let n = counter.fetch_add(1, Ordering::SeqCst);
                        assert!(String::from_utf8(body.to_vec())
                            .unwrap()
                            .contains("refresh_token=first-refresh-token"));
                        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                        Json(json!({
                            "access_token": format!("fresh-token-{n}"),
                            "refresh_token": "second-refresh-token",
                            "expires_in": 3600
                        }))
                    }
                }),
            )
            .route(
                "/items",
                axum::routing::get(|headers: HeaderMap| async move {
                    Json(json!({"auth": headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok())}))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });

        let security = test_security().await;
        let mut state = test_state("server-secret");
        state.catalog = crate::catalog::Catalog::from_test_document(
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
        state.security = Some(security.clone());
        state.test_upstream = Some(upstream_url);
        let router = crate::router(state);

        let owner = Agent::new(41);
        let credential = serde_json::to_vec(&StoredCredential::OAuth {
            provider: "github-issues".into(),
            tenant_id: "tenant".into(),
            user_id: owner.did(),
            access_token: "stale-token".into(),
            refresh_token: Some("first-refresh-token".into()),
            expires_at: Some(0),
        })
        .unwrap();
        let id = security
            .create_connection("github-issues", "tenant", &owner.did(), &credential)
            .await
            .unwrap();
        let token = owner.capability(&id, "github-issues", now() + 300);

        let mut calls = tokio::task::JoinSet::new();
        for _ in 0..5 {
            let router = router.clone();
            let token = token.clone();
            calls.spawn(async move {
                let response = router
                    .oneshot(with_capability("/proxy/github-issues/items", &token))
                    .await
                    .unwrap();
                (response.status(), body_text(response).await)
            });
        }
        while let Some(result) = calls.join_next().await {
            let (status, body) = result.unwrap();
            assert_eq!(status, StatusCode::OK, "{body}");
            assert!(body.contains("Bearer fresh-token-0"), "{body}");
        }
        assert_eq!(token_requests.load(Ordering::SeqCst), 1);

        let stored = security.load_connection(&id).await.unwrap().unwrap();
        match serde_json::from_slice::<StoredCredential>(&stored.credential).unwrap() {
            StoredCredential::OAuth { refresh_token, .. } => {
                assert_eq!(refresh_token.as_deref(), Some("second-refresh-token"));
            }
            StoredCredential::ApiKey { .. } => panic!("expected an OAuth credential"),
        }
        server.abort();
    }

    fn logged_in_jar(key: Key) -> (PrivateCookieJar, crate::session::SessionUser) {
        let user = crate::session::SessionUser::new(
            "oidc-sub-123".to_string(),
            "user@example.com".to_string(),
            "Test User".to_string(),
            None,
        );
        let jar = session::set_session(PrivateCookieJar::new(key), &user);
        (jar, user)
    }

    fn connect_params(state: &AppState, redirect_uri: &str) -> ConnectParams {
        let ts = now();
        let nonce = "test-nonce".to_string();
        let challenge = challenge(&state.server_secret, ts, &nonce);
        let tenant_id = "tenant-123".to_string();
        let user_id = "user-123".to_string();
        let secret = tenant_secret::derive(&state.server_secret, &tenant_id);
        ConnectParams {
            redirect_uri: redirect_uri.to_string(),
            ts,
            nonce,
            challenge: challenge.clone(),
            tenant_id,
            user_id: user_id.clone(),
            user_id_sig: tenant_secret::sign(&secret, &user_id),
            response: tenant_secret::sign(&secret, &challenge),
        }
    }

    #[test]
    fn connect_url_encodes_the_redirect_uri() {
        let url = connect_url("https://example.com/cb?x=1&y=2");
        assert_eq!(
            url,
            "/connect?redirect_uri=https%3A%2F%2Fexample.com%2Fcb%3Fx%3D1%26y%3D2"
        );
    }

    #[tokio::test]
    async fn connect_page_rejects_invalid_redirect_uri() {
        let state = test_state("server-secret");
        let jar = PrivateCookieJar::new(Key::generate());
        let err = connect_page(
            State(state),
            Query(connect_params(&test_state("server-secret"), "not a url")),
            jar,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ConnectError::InvalidRedirect));
    }

    #[tokio::test]
    async fn connect_page_sends_signed_out_visitor_to_login() {
        let state = test_state("server-secret");
        let jar = PrivateCookieJar::new(Key::generate());
        let response = connect_page(
            State(state.clone()),
            Query(connect_params(&state, "https://example.com/cb")),
            jar,
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert_eq!(
            response.headers().get(header::LOCATION).unwrap(),
            "/auth/login"
        );
    }

    #[tokio::test]
    async fn connect_page_shows_consent_screen_when_signed_in() {
        let state = test_state("server-secret");
        let (jar, _) = logged_in_jar(Key::generate());
        let response = connect_page(
            State(state.clone()),
            Query(connect_params(&state, "https://example.com/cb")),
            jar,
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn connect_confirm_rejects_an_invalid_tenant_session() {
        let jar = PrivateCookieJar::new(Key::generate());
        let state = test_state("server-secret");
        let err = connect_confirm(
            State(state),
            jar,
            Form(ConnectConfirmForm {
                redirect_uri: "https://example.com/cb".to_string(),
                ts: 0,
                nonce: "x".into(),
                challenge: "x".into(),
                tenant_id: "x".into(),
                user_id: "x".into(),
                user_id_sig: "x".into(),
                response: "x".into(),
            }),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ConnectError::InvalidSession));
    }

    #[tokio::test]
    async fn connect_confirm_redirects_with_the_tenant_secret() {
        let key = Key::generate();
        let (jar, user) = logged_in_jar(key);
        let state = test_state("server-secret");
        let expected_secret = tenant_secret::derive(&state.server_secret, &user.subject);

        let redirect = connect_confirm(
            State(state),
            jar,
            Form(ConnectConfirmForm {
                redirect_uri: "https://example.com/cb?existing=1".to_string(),
                ts: now(),
                nonce: "test-nonce".into(),
                challenge: challenge("server-secret", now(), "test-nonce"),
                tenant_id: "tenant".into(),
                user_id: "user".into(),
                user_id_sig: tenant_secret::sign(
                    &tenant_secret::derive("server-secret", "tenant"),
                    "user",
                ),
                response: tenant_secret::sign(
                    &tenant_secret::derive("server-secret", "tenant"),
                    &challenge("server-secret", now(), "test-nonce"),
                ),
            }),
        )
        .await
        .unwrap();

        let location = redirect
            .into_response()
            .headers()
            .get(header::LOCATION)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        let url = Url::parse(&location).unwrap();
        assert_eq!(url.origin().ascii_serialization(), "https://example.com");
        assert_eq!(url.path(), "/cb");
        let pairs: Vec<_> = url.query_pairs().collect();
        assert!(pairs.iter().any(|(k, v)| k == "existing" && v == "1"));
        assert!(pairs
            .iter()
            .any(|(k, v)| k == "secret" && v == expected_secret.as_str()));
    }

    #[tokio::test]
    async fn proxy_accepts_a_valid_bearer_secret() {
        let state = test_state("server-secret");
        let secret = tenant_secret::derive(&state.server_secret, "oidc-sub-123");

        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {secret}")).unwrap(),
        );

        let response = proxy(State(state), headers).await;
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn proxy_rejects_a_missing_bearer_header() {
        let state = test_state("server-secret");
        let response = proxy(State(state), HeaderMap::new()).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn proxy_rejects_an_invalid_bearer_secret() {
        let state = test_state("server-secret");
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer garbage"));

        let response = proxy(State(state), headers).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn proxy_rejects_a_secret_signed_with_a_different_server_secret() {
        let state = test_state("server-secret");
        let secret = tenant_secret::derive("a-different-secret", "oidc-sub-123");

        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {secret}")).unwrap(),
        );

        let response = proxy(State(state), headers).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}
