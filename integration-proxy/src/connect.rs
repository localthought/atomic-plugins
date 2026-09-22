//! Browser bootstrap: application identity, explicit platform consent, and a PKCE handoff.
use crate::{oauth, providers::Provider, security::Security, session, templates, AppState};
use axum::{
    extract::{Form, OriginalUri, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse, Redirect, Response},
    Json,
};
use axum_extra::extract::{
    cookie::{Cookie, SameSite},
    PrivateCookieJar,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

const CONSENT_COOKIE: &str = "platform_consent";
const PROVIDER_COOKIE: &str = "platform_oauth";
const HANDOFF_AAD: &[u8] = b"platform-handoff-v1";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub enum Credentials {
    #[serde(rename = "connection")]
    Connection,
    #[serde(rename = "connection+tenant_secret")]
    ConnectionAndTenantSecret,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Request {
    pub platform: String,
    pub redirect_uri: String,
    pub user_id: String,
    pub code_challenge: String,
    pub code_challenge_method: String,
    pub credentials: Credentials,
}

#[derive(Clone, Deserialize, Serialize)]
struct Consent {
    request: Request,
    csrf: String,
    expires: u64,
}

#[derive(Deserialize, Serialize)]
pub struct OAuthContext {
    pub request: Request,
    pub binding: String,
    pub mode: BootstrapMode,
}

#[derive(Deserialize, Serialize, Clone, PartialEq, Eq)]
pub enum BootstrapMode {
    Bootstrap,
    ExistingTenant { tenant_id: String },
}

#[derive(Deserialize, Serialize)]
struct Handoff {
    platform: String,
    tenant_id: String,
    user_id: String,
    credential: String,
    include_tenant_secret: bool,
}

pub fn random() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn pkce_challenge(verifier: &str) -> Option<String> {
    if !(43..=128).contains(&verifier.len())
        || !verifier
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
    {
        return None;
    }
    Some(URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())))
}

impl Request {
    fn validate(&self) -> Result<Url, &'static str> {
        let url = Url::parse(&self.redirect_uri).map_err(|_| "Invalid return address")?;
        let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if self.redirect_uri.len() > 1500
            || url.host_str().is_none()
            || !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || url
                .query_pairs()
                .any(|(name, _)| matches!(name.as_ref(), "connection_code" | "error" | "secret"))
        {
            return Err("Invalid return address");
        }
        if self.user_id.is_empty()
            || self.user_id.len() > 512
            || self.code_challenge_method != "S256"
            || self.code_challenge.len() != 43
            || URL_SAFE_NO_PAD
                .decode(&self.code_challenge)
                .map_or(true, |b| b.len() != 32)
            || crate::config::Config::provider_env_prefix(&self.platform).is_err()
        {
            return Err("Invalid connection request");
        }
        Ok(url)
    }

    fn local_url(&self) -> String {
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        query
            .append_pair("platform", &self.platform)
            .append_pair("redirect_uri", &self.redirect_uri)
            .append_pair("user_id", &self.user_id)
            .append_pair("code_challenge", &self.code_challenge)
            .append_pair("code_challenge_method", &self.code_challenge_method)
            .append_pair(
                "credentials",
                match self.credentials {
                    Credentials::Connection => "connection",
                    Credentials::ConnectionAndTenantSecret => "connection+tenant_secret",
                },
            );
        format!("/connect?{}", query.finish())
    }
}

/// Only a previously validated, cookie-stored bootstrap request can redirect a login cancellation.
pub fn cancel_login_target(target: &str) -> Option<String> {
    if !target.starts_with("/connect?") {
        return None;
    }
    let uri: axum::http::Uri = target.parse().ok()?;
    let Query(request) = Query::<Request>::try_from_uri(&uri).ok()?;
    let mut destination = request.validate().ok()?;
    destination
        .query_pairs_mut()
        .append_pair("error", "access_denied");
    Some(destination.into())
}

/// The only return target a standalone API login can inherit is the complete,
/// encrypted browser bootstrap request already validated by this module.
pub(crate) fn validated_login_return(jar: &PrivateCookieJar) -> Option<String> {
    let target = session::read_connect_redirect(jar)?;
    let uri: axum::http::Uri = target.parse().ok()?;
    let Query(request) = Query::<Request>::try_from_uri(&uri).ok()?;
    request.validate().ok()?;
    Some(request.local_url())
}

pub fn clear_consent(jar: PrivateCookieJar) -> PrivateCookieJar {
    jar.remove(Cookie::build(CONSENT_COOKIE).path("/").build())
}

pub(crate) fn protected(response: impl IntoResponse) -> Response {
    let mut response = response.into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("referrer-policy", "no-referrer".parse().unwrap());
    response.headers_mut().insert("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https:; frame-ancestors 'none'; base-uri 'none'".parse().unwrap());
    response
}

fn error(message: &'static str) -> Response {
    protected((StatusCode::BAD_REQUEST, message))
}

fn private_cookie(name: &'static str, value: String) -> Cookie<'static> {
    Cookie::build((name, value))
        .path("/")
        .secure(true)
        .http_only(true)
        .same_site(SameSite::Lax)
        .max_age(time::Duration::minutes(10))
        .build()
}

pub async fn page(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    jar: PrivateCookieJar,
) -> Response {
    let is_browser =
        url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes()).any(|(key, _)| {
            matches!(
                key.as_ref(),
                "code_challenge" | "code_challenge_method" | "credentials"
            )
        });
    let request = if is_browser {
        match Query::<Request>::try_from_uri(&uri) {
            Ok(Query(request)) => request,
            Err(_) => return error("Invalid connection request"),
        }
    } else {
        let params = match Query::<crate::proxy::ConnectParams>::try_from_uri(&uri) {
            Ok(params) => params,
            Err(_) => return error("Invalid connection request; start again from your hub"),
        };
        return match crate::proxy::connect_page(State(state), params, jar).await {
            Ok(response) => protected(response),
            Err(err) => protected(err),
        };
    };
    let target = match request.validate() {
        Ok(target) => target,
        Err(message) => return error(message),
    };
    if !state.catalog.names().contains(&request.platform) {
        return error("This platform is not available for connection");
    }
    let scheme = match state.catalog.security_scheme(&request.platform) {
        Ok(scheme) => scheme,
        Err(_) => return error("This platform is not available for connection"),
    };
    if matches!(scheme, crate::providers::SecurityScheme::OAuth(_))
        && Provider::configured(&state.catalog, &request.platform).is_err()
    {
        return error("This platform is not available for connection");
    }
    let consent = Consent {
        request: request.clone(),
        csrf: random(),
        expires: crate::proxy::now_unix() + 600,
    };
    let user = session::read_session(&jar);
    let bootstrap_identity =
        user.is_none() && state.catalog.tenant_identity(&request.platform).is_ok();
    let api_login_platforms = state
        .catalog
        .names()
        .into_iter()
        .filter(|platform| state.catalog.tenant_identity(platform).is_ok())
        .collect::<Vec<_>>();
    let jar = jar.add(private_cookie(
        CONSENT_COOKIE,
        serde_json::to_string(&consent).unwrap(),
    ));
    // Preserve the entire selected-platform request through application authentication.
    let jar = if user.is_none() {
        session::set_connect_redirect(jar, &request.local_url())
    } else {
        jar
    };
    let mut response = protected((
        jar,
        Html(templates::render_platform_connect(
            user.as_ref(),
            &request.platform,
            &target.origin().ascii_serialization(),
            &consent.csrf,
            request.credentials == Credentials::ConnectionAndTenantSecret,
            user.as_ref()
                .and_then(|user| user.identity_label.as_deref())
                .unwrap_or(&state.app_auth_label),
            bootstrap_identity,
            &api_login_platforms,
            matches!(scheme, crate::providers::SecurityScheme::ApiKey(_)),
        )),
    ));
    // Keep the consent form's same-origin POST attributable while sending no
    // referrer to the configured identity provider or selected provider.
    response
        .headers_mut()
        .insert(header::REFERRER_POLICY, "same-origin".parse().unwrap());
    // Chrome applies form-action to redirects too, including an already-authorized
    // provider returning straight through its callback to the hub. An apiKey
    // platform never redirects to a third party, so only the caller's own
    // redirect_uri origin needs allowing.
    let policy = match &scheme {
        crate::providers::SecurityScheme::OAuth(provider) => {
            let provider_origin = Url::parse(&provider.authorization_url)
                .unwrap()
                .origin()
                .ascii_serialization();
            format!(
                "{}; form-action 'self' {} {}",
                response.headers()["content-security-policy"]
                    .to_str()
                    .unwrap(),
                provider_origin,
                target.origin().ascii_serialization()
            )
        }
        crate::providers::SecurityScheme::ApiKey(_) => format!(
            "{}; form-action 'self' {}",
            response.headers()["content-security-policy"]
                .to_str()
                .unwrap(),
            target.origin().ascii_serialization()
        ),
    };
    response
        .headers_mut()
        .insert("content-security-policy", policy.parse().unwrap());
    response
}

#[derive(Deserialize)]
pub struct Approval {
    csrf: String,
    #[serde(default)]
    api_key: Option<String>,
}

pub async fn authorize(
    State(state): State<AppState>,
    jar: PrivateCookieJar,
    headers: HeaderMap,
    Form(approval): Form<Approval>,
) -> Response {
    // Browser form origin is an extra defense; the encrypted cookie and random CSRF token are required.
    if headers
        .get(header::ORIGIN)
        .is_some_and(|origin| origin.to_str().ok() != Some(state.base_url.trim_end_matches('/')))
    {
        return error("Invalid connection approval");
    }
    let Some(cookie) = jar.get(CONSENT_COOKIE) else {
        return error("Connection request expired; start again from your hub");
    };
    let Ok(consent) = serde_json::from_str::<Consent>(cookie.value()) else {
        return error("Invalid connection approval");
    };
    if consent.expires <= crate::proxy::now_unix()
        || consent.csrf != approval.csrf
        || consent.request.validate().is_err()
    {
        return error("Connection request expired or invalid; start again from your hub");
    }
    let user = session::read_session(&jar);
    if user.is_none()
        && state
            .catalog
            .tenant_identity(&consent.request.platform)
            .is_err()
    {
        return error("This platform cannot establish a tenant identity; log in before connecting");
    }
    let Some(security) = &state.security else {
        return error("Connections are unavailable");
    };
    if user
        .as_ref()
        .is_some_and(|user| security.is_revoked(&user.subject, &consent.request.user_id))
        || !matches!(
            security
                .consume_nonce(&format!("consent:{}", consent.csrf))
                .await,
            Ok(true)
        )
    {
        return error("Connection approval expired or already used");
    }
    // Only an OAuth platform redirects to a third party from here; an apiKey
    // platform already has everything it needs (the submitted key) and
    // completes the handoff directly, generically, without ever involving
    // `oauth::begin`/`oauth::callback`.
    match state.catalog.security_scheme(&consent.request.platform) {
        Ok(crate::providers::SecurityScheme::ApiKey(_)) => {
            let Some(tenant_id) = user.as_ref().map(|user| user.subject.clone()) else {
                return error(
                    "This platform cannot establish a tenant identity; log in before connecting",
                );
            };
            let Some(key) = approval
                .api_key
                .as_deref()
                .map(str::trim)
                .filter(|key| (4..=512).contains(&key.len()))
            else {
                return error("Enter a valid API key");
            };
            let credential = crate::proxy::StoredCredential::ApiKey {
                provider: consent.request.platform.clone(),
                tenant_id: tenant_id.clone(),
                user_id: consent.request.user_id.clone(),
                key: key.to_owned(),
            };
            let Ok(envelope) = security.seal(
                &serde_json::to_vec(&credential).unwrap(),
                b"connection-credential-v1",
            ) else {
                return error("Could not complete connection");
            };
            let context = OAuthContext {
                request: consent.request.clone(),
                binding: random(),
                mode: BootstrapMode::ExistingTenant {
                    tenant_id: tenant_id.clone(),
                },
            };
            let redirect_uri = context.request.redirect_uri.clone();
            let code = match handoff(security, &context, &tenant_id, &envelope).await {
                Ok(code) => code,
                Err(()) => return error("Could not complete connection"),
            };
            return finish_with_connection_code(clear_consent(jar), &redirect_uri, &code);
        }
        Ok(crate::providers::SecurityScheme::OAuth(_)) => {}
        Err(_) => return error("This platform is not available for connection"),
    }
    let context = OAuthContext {
        request: consent.request.clone(),
        binding: random(),
        mode: match user {
            Some(user) => BootstrapMode::ExistingTenant {
                tenant_id: user.subject,
            },
            None => BootstrapMode::Bootstrap,
        },
    };
    let Ok(sealed_context) =
        security.seal(&serde_json::to_vec(&context).unwrap(), b"platform-oauth-v1")
    else {
        return error("Could not start connection");
    };
    let binding = context.binding;
    let request = consent.request;
    let result = oauth::begin(
        &state,
        &request.platform,
        &request.redirect_uri,
        match &context.mode {
            BootstrapMode::ExistingTenant { tenant_id } => tenant_id,
            BootstrapMode::Bootstrap => "",
        },
        &request.user_id,
        Some(sealed_context),
    )
    .await;
    let url = match result {
        Ok(url) => url,
        Err(()) => return error("Could not start platform authorization"),
    };
    let jar = jar
        .remove(Cookie::build(CONSENT_COOKIE).path("/").build())
        .add(private_cookie(PROVIDER_COOKIE, binding));
    protected((jar, Redirect::to(&url)))
}

pub fn oauth_context(
    security: &Security,
    value: &str,
    jar: &PrivateCookieJar,
) -> Option<OAuthContext> {
    let context: OAuthContext =
        serde_json::from_slice(&security.open(value, b"platform-oauth-v1")?).ok()?;
    if jar.get(PROVIDER_COOKIE)?.value() != context.binding {
        return None;
    }
    Some(context)
}

pub fn clear_provider_cookie(jar: PrivateCookieJar) -> PrivateCookieJar {
    jar.remove(Cookie::build(PROVIDER_COOKIE).path("/").build())
}

/// Redirects the browser back to `redirect_uri` with a rotating handoff
/// `connection_code` appended. Shared by the OAuth callback and the apiKey
/// `authorize` branch below; clearing the OAuth provider-binding cookie is a
/// no-op for a flow (like apiKey) that never set it.
pub(crate) fn finish_with_connection_code(
    jar: PrivateCookieJar,
    redirect_uri: &str,
    code: &str,
) -> Response {
    let Ok(mut redirect) = Url::parse(redirect_uri) else {
        return error("Could not complete connection");
    };
    redirect
        .query_pairs_mut()
        .append_pair("connection_code", code);
    (clear_provider_cookie(jar), Redirect::to(redirect.as_str())).into_response()
}

pub async fn handoff(
    security: &Security,
    context: &OAuthContext,
    tenant_id: &str,
    credential: &str,
) -> Result<String, ()> {
    let handoff = Handoff {
        platform: context.request.platform.clone(),
        tenant_id: tenant_id.into(),
        user_id: context.request.user_id.clone(),
        credential: credential.into(),
        include_tenant_secret: context.request.credentials
            == Credentials::ConnectionAndTenantSecret,
    };
    let envelope = security
        .seal(&serde_json::to_vec(&handoff).map_err(|_| ())?, HANDOFF_AAD)
        .map_err(|_| ())?;
    let code = random();
    security
        .store_handoff(&code, &context.request.code_challenge, &envelope)
        .await
        .map_err(|_| ())?;
    Ok(code)
}

#[derive(Deserialize)]
pub struct Redemption {
    code: String,
    code_verifier: String,
}

pub async fn redeem(State(state): State<AppState>, Json(request): Json<Redemption>) -> Response {
    let Some(challenge) = pkce_challenge(&request.code_verifier) else {
        return error("Invalid or expired connection code");
    };
    if request.code.len() != 43 {
        return error("Invalid or expired connection code");
    }
    let Some(security) = &state.security else {
        return error("Connections are unavailable");
    };
    let Ok(Some(envelope)) = security.take_handoff(&request.code, &challenge).await else {
        return error("Invalid or expired connection code");
    };
    let Some(plaintext) = security.open(&envelope, HANDOFF_AAD) else {
        return error("Invalid connection code");
    };
    let Ok(handoff) = serde_json::from_slice::<Handoff>(&plaintext) else {
        return error("Invalid connection code");
    };
    if security.is_revoked(&handoff.tenant_id, &handoff.user_id) {
        return error("Connection is revoked");
    }
    let code = random();
    if security
        .store_connection_code(&code, &handoff.credential)
        .await
        .is_err()
    {
        return error("Could not finish connecting; reconnect from your hub");
    }
    let mut body = serde_json::json!({"connection_code": code, "platform": handoff.platform});
    if handoff.include_tenant_secret {
        body["tenant_secret"] =
            crate::tenant_secret::derive(&state.server_secret, &handoff.tenant_id).into();
    }
    protected(Json(body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    fn request() -> Request {
        Request { platform: "github-issues".into(), redirect_uri: "https://hub.example/app/integrations?integration_state=state&platform=github-issues".into(), user_id: "did:ad:agent:test".into(), code_challenge: pkce_challenge(&"a".repeat(43)).unwrap(), code_challenge_method: "S256".into(), credentials: Credentials::Connection }
    }
    #[test]
    fn bootstrap_requires_no_tenant_proof_and_preserves_all_login_context() {
        let request = request();
        assert!(request.validate().is_ok());
        let query = request.local_url();
        let parsed: std::collections::HashMap<_, _> =
            Url::parse(&format!("https://localthought.io{query}"))
                .unwrap()
                .query_pairs()
                .into_owned()
                .collect();
        assert_eq!(parsed["platform"], "github-issues");
        assert_eq!(parsed["redirect_uri"], request.redirect_uri);
        assert_eq!(parsed["code_challenge"], request.code_challenge);
        assert_eq!(parsed["credentials"], "connection");
        assert!(!parsed.contains_key("tenant_id"));
    }
    #[test]
    fn return_address_rejects_insecure_or_ambiguous_credentials() {
        for value in [
            "http://hub.example/cb",
            "javascript:alert(1)",
            "https://user:pass@hub.example/cb",
            "https://hub.example/cb#fragment",
            "https://hub.example/cb?connection_code=evil",
            "https://hub.example/cb?secret=evil",
        ] {
            let mut request = request();
            request.redirect_uri = value.into();
            assert!(request.validate().is_err(), "{value}");
        }
        let mut request = request();
        request.redirect_uri = "http://localhost:6747/app/integrations".into();
        assert!(request.validate().is_ok());
    }
    #[test]
    fn pkce_uses_rfc7636_s256_and_rejects_weak_input() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk").unwrap(),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        assert!(pkce_challenge("short").is_none());
        assert!(pkce_challenge(&"!".repeat(43)).is_none());
        let mut request = request();
        request.code_challenge_method = "plain".into();
        assert!(request.validate().is_err());
    }
    fn state(security: Option<Security>) -> AppState {
        AppState {
            oauth_client: oauth2::basic::BasicClient::new(
                oauth2::ClientId::new("fixture-google".into()),
                None,
                oauth2::AuthUrl::new("https://accounts.google.com/o/oauth2/v2/auth".into())
                    .unwrap(),
                None,
            ),
            app_auth_userinfo_url: "https://accounts.example/userinfo".into(),
            app_auth_label: "OIDC".into(),
            app_auth_identity_namespace: None,
            http_client: crate::build_http_client(),
            identity_http_client: crate::build_identity_http_client(),
            key: axum_extra::extract::cookie::Key::generate(),
            server_secret: "fixture-server-secret".into(),
            base_url: "https://localthought.io".into(),
            catalog: crate::catalog::Catalog::for_test("github-issues"),
            security,
            test_upstream: None,
        }
    }

    fn identity_catalog() -> crate::catalog::Catalog {
        crate::catalog::Catalog::from_test_document(
            "github-issues",
            serde_json::json!({
                "servers": [{"url": "https://api.example/v1"}],
                "components": {"securitySchemes": {"auth": {"type":"oauth2", "flows":{"authorizationCode":{"authorizationUrl":"https://auth.example/authorize","tokenUrl":"https://auth.example/token","scopes":{"read":"Read"}}}}}},
                "paths": {"/me":{"get":{"operationId":"me","security":[{"auth":[]}],"x-authenticated-principal":{"kind":"user","namespace":"https://github.example","subject":"$response.body#/id","identifier":{"scope":"provider","stable":true,"reassigned":false}}}}}
            }),
            serde_json::json!({"oauthSecurityScheme":"auth","tenantIdentity":{"operationId":"me","namespace":"https://github.example"}}),
        )
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL and fixture OAuth credentials"]
    async fn postgres_anonymous_callback_resolves_identity_once_and_mints_bound_handoff() {
        use axum::{routing::post, Json};
        use tower::ServiceExt;
        let token_hits = Arc::new(AtomicUsize::new(0));
        let identity_hits = Arc::new(AtomicUsize::new(0));
        let token_counter = token_hits.clone();
        let identity_counter = identity_hits.clone();
        let upstream = axum::Router::new()
            .route(
                "/token",
                post(move || {
                    let token_counter = token_counter.clone();
                    async move {
                        token_counter.fetch_add(1, Ordering::SeqCst);
                        Json(serde_json::json!({"access_token":"provider-token"}))
                    }
                }),
            )
            .route(
                "/identity",
                axum::routing::get(move |headers: HeaderMap| {
                    let identity_counter = identity_counter.clone();
                    async move {
                        assert_eq!(
                            headers.get(header::AUTHORIZATION).unwrap(),
                            "Bearer provider-token"
                        );
                        identity_counter.fetch_add(1, Ordering::SeqCst);
                        Json(serde_json::json!({"id":42,"email":"display@example.test"}))
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(listener, upstream).await.unwrap();
        });
        let db = std::env::var("TEST_DATABASE_URL").unwrap();
        let security =
            Security::connect(&db, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", vec![])
                .await
                .unwrap();
        let mut s = state(Some(security.clone()));
        s.catalog = identity_catalog();
        s.test_upstream = Some(upstream_url);
        let consent = Consent {
            request: request(),
            csrf: random(),
            expires: crate::proxy::now_unix() + 600,
        };
        let jar = PrivateCookieJar::new(s.key.clone()).add(private_cookie(
            CONSENT_COOKIE,
            serde_json::to_string(&consent).unwrap(),
        ));
        let authorization = authorize(
            State(s.clone()),
            jar.clone(),
            HeaderMap::new(),
            Form(Approval {
                csrf: consent.csrf.clone(),
                api_key: None,
            }),
        )
        .await;
        assert_eq!(authorization.status(), StatusCode::SEE_OTHER);
        let state_value = Url::parse(authorization.headers()[header::LOCATION].to_str().unwrap())
            .unwrap()
            .query_pairs()
            .find(|(key, _)| key == "state")
            .unwrap()
            .1
            .into_owned();
        let mut cookies = jar
            .into_response()
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|value| {
                value
                    .to_str()
                    .unwrap()
                    .split(';')
                    .next()
                    .unwrap()
                    .to_owned()
            })
            .collect::<Vec<_>>();
        cookies.extend(
            authorization
                .headers()
                .get_all(header::SET_COOKIE)
                .iter()
                .map(|value| {
                    value
                        .to_str()
                        .unwrap()
                        .split(';')
                        .next()
                        .unwrap()
                        .to_owned()
                }),
        );
        let callback = crate::router(s.clone())
            .oneshot(
                axum::http::Request::builder()
                    .uri(format!(
                        "/oauth/github-issues/callback?state={state_value}&code=code"
                    ))
                    .header(header::COOKIE, cookies.join("; "))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(callback.status(), StatusCode::SEE_OTHER);
        assert_eq!(token_hits.load(Ordering::SeqCst), 1);
        assert_eq!(identity_hits.load(Ordering::SeqCst), 1);
        let handoff = Url::parse(callback.headers()[header::LOCATION].to_str().unwrap())
            .unwrap()
            .query_pairs()
            .find(|(key, _)| key == "connection_code")
            .unwrap()
            .1
            .into_owned();
        let redemption = redeem(
            State(s.clone()),
            Json(Redemption {
                code: handoff,
                code_verifier: "a".repeat(43),
            }),
        )
        .await;
        assert_eq!(redemption.status(), StatusCode::OK);
        let body = axum::body::to_bytes(redemption.into_body(), 16_384)
            .await
            .unwrap();
        let redeemed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let connection_code = redeemed["connection_code"].as_str().unwrap().to_owned();
        let credential_envelope = security
            .take_connection_code(&connection_code)
            .await
            .unwrap()
            .unwrap();
        let plain = security
            .open(&credential_envelope, b"connection-credential-v1")
            .unwrap();
        let credential: serde_json::Value = serde_json::from_slice(&plain).unwrap();
        let mut session_headers = HeaderMap::new();
        let session_cookie = callback
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .find(|value| value.to_str().unwrap().starts_with("session="))
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        session_headers.insert(header::COOKIE, session_cookie.parse().unwrap());
        let session = session::read_session(&PrivateCookieJar::from_headers(
            &session_headers,
            s.key.clone(),
        ))
        .unwrap();
        assert_eq!(session.subject, "tenant:v1:{\"client\":null,\"namespace\":\"https://github.example\",\"scope\":\"provider\",\"subject\":42}");
        assert_eq!(credential["tenant_id"], session.subject);
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL"]
    async fn postgres_callback_rejects_session_appearing_during_bootstrap_before_exchange() {
        use tower::ServiceExt;
        let exchanges = Arc::new(AtomicUsize::new(0));
        let counter = exchanges.clone();
        let upstream = axum::Router::new().route(
            "/token",
            axum::routing::post(move || {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    Json(serde_json::json!({"access_token":"unexpected"}))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let db = std::env::var("TEST_DATABASE_URL").unwrap();
        let security =
            Security::connect(&db, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", vec![])
                .await
                .unwrap();
        let mut s = state(Some(security.clone()));
        s.catalog = identity_catalog();
        s.test_upstream = Some(upstream_url);
        let context = OAuthContext {
            request: request(),
            binding: random(),
            mode: BootstrapMode::Bootstrap,
        };
        let envelope = security
            .seal(&serde_json::to_vec(&context).unwrap(), b"platform-oauth-v1")
            .unwrap();
        let state_value = random();
        security
            .store_oauth_state(
                &state_value,
                &crate::security::OAuthState {
                    provider: "github-issues".into(),
                    redirect_uri: context.request.redirect_uri.clone(),
                    tenant_id: "".into(),
                    user_id: context.request.user_id.clone(),
                    verifier: random(),
                    context: Some(envelope),
                },
            )
            .await
            .unwrap();
        let session_user =
            session::SessionUser::new("other-tenant".into(), "".into(), "Other".into(), None);
        let jar = session::set_session(PrivateCookieJar::new(s.key.clone()), &session_user)
            .add(private_cookie(PROVIDER_COOKIE, context.binding));
        let cookies = jar
            .into_response()
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|value| {
                value
                    .to_str()
                    .unwrap()
                    .split(';')
                    .next()
                    .unwrap()
                    .to_owned()
            })
            .collect::<Vec<_>>();
        let response = crate::router(s)
            .oneshot(
                axum::http::Request::builder()
                    .uri(format!(
                        "/oauth/github-issues/callback?state={state_value}&code=code"
                    ))
                    .header(header::COOKIE, cookies.join("; "))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(exchanges.load(Ordering::SeqCst), 0);
        assert!(security
            .take_oauth_state(&state_value)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL and fixture OAuth credentials"]
    async fn postgres_existing_tenant_callback_never_rebinds_or_resolves_provider_identity() {
        use tower::ServiceExt;
        let tokens = Arc::new(AtomicUsize::new(0));
        let identities = Arc::new(AtomicUsize::new(0));
        let token_counter = tokens.clone();
        let identity_counter = identities.clone();
        let upstream = axum::Router::new()
            .route(
                "/token",
                axum::routing::post(move || {
                    let token_counter = token_counter.clone();
                    async move {
                        token_counter.fetch_add(1, Ordering::SeqCst);
                        Json(serde_json::json!({"access_token":"token"}))
                    }
                }),
            )
            .route(
                "/identity",
                axum::routing::get(move || {
                    let identity_counter = identity_counter.clone();
                    async move {
                        identity_counter.fetch_add(1, Ordering::SeqCst);
                        Json(serde_json::json!({"id":999}))
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let db = std::env::var("TEST_DATABASE_URL").unwrap();
        let security =
            Security::connect(&db, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", vec![])
                .await
                .unwrap();
        let mut s = state(Some(security.clone()));
        s.catalog = identity_catalog();
        s.test_upstream = Some(upstream_url);
        let tenant = "existing-tenant".to_owned();
        let context = OAuthContext {
            request: request(),
            binding: random(),
            mode: BootstrapMode::ExistingTenant {
                tenant_id: tenant.clone(),
            },
        };
        let envelope = security
            .seal(&serde_json::to_vec(&context).unwrap(), b"platform-oauth-v1")
            .unwrap();
        let state_value = random();
        security
            .store_oauth_state(
                &state_value,
                &crate::security::OAuthState {
                    provider: "github-issues".into(),
                    redirect_uri: context.request.redirect_uri.clone(),
                    tenant_id: tenant.clone(),
                    user_id: context.request.user_id.clone(),
                    verifier: random(),
                    context: Some(envelope),
                },
            )
            .await
            .unwrap();
        let user = session::SessionUser::new(tenant.clone(), "".into(), "Existing".into(), None);
        let jar = session::set_session(PrivateCookieJar::new(s.key.clone()), &user)
            .add(private_cookie(PROVIDER_COOKIE, context.binding));
        let cookies = jar
            .into_response()
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|value| {
                value
                    .to_str()
                    .unwrap()
                    .split(';')
                    .next()
                    .unwrap()
                    .to_owned()
            })
            .collect::<Vec<_>>();
        let callback = crate::router(s.clone())
            .oneshot(
                axum::http::Request::builder()
                    .uri(format!(
                        "/oauth/github-issues/callback?state={state_value}&code=code"
                    ))
                    .header(header::COOKIE, cookies.join("; "))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(callback.status(), StatusCode::SEE_OTHER);
        assert_eq!(tokens.load(Ordering::SeqCst), 1);
        assert_eq!(identities.load(Ordering::SeqCst), 0);
        let handoff = Url::parse(callback.headers()[header::LOCATION].to_str().unwrap())
            .unwrap()
            .query_pairs()
            .find(|(key, _)| key == "connection_code")
            .unwrap()
            .1
            .into_owned();
        let handoff = security
            .take_handoff(&handoff, &context.request.code_challenge)
            .await
            .unwrap()
            .unwrap();
        let handoff: Handoff =
            serde_json::from_slice(&security.open(&handoff, HANDOFF_AAD).unwrap()).unwrap();
        assert_eq!(handoff.tenant_id, tenant);
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL and fixture OAuth credentials"]
    async fn postgres_bootstrap_rejects_revoked_resolved_identity_before_session_or_handoff() {
        use tower::ServiceExt;
        let tokens = Arc::new(AtomicUsize::new(0));
        let identities = Arc::new(AtomicUsize::new(0));
        let token_counter = tokens.clone();
        let identity_counter = identities.clone();
        let upstream = axum::Router::new()
            .route(
                "/token",
                axum::routing::post(move || {
                    let token_counter = token_counter.clone();
                    async move {
                        token_counter.fetch_add(1, Ordering::SeqCst);
                        Json(serde_json::json!({"access_token":"token"}))
                    }
                }),
            )
            .route(
                "/identity",
                axum::routing::get(move || {
                    let identity_counter = identity_counter.clone();
                    async move {
                        identity_counter.fetch_add(1, Ordering::SeqCst);
                        Json(serde_json::json!({"id":42}))
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let revoked = "tenant:v1:{\"client\":null,\"namespace\":\"https://github.example\",\"scope\":\"provider\",\"subject\":42}".to_owned();
        let db = std::env::var("TEST_DATABASE_URL").unwrap();
        let security = Security::connect(
            &db,
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            vec![revoked],
        )
        .await
        .unwrap();
        let mut s = state(Some(security.clone()));
        s.catalog = identity_catalog();
        s.test_upstream = Some(upstream_url);
        let context = OAuthContext {
            request: request(),
            binding: random(),
            mode: BootstrapMode::Bootstrap,
        };
        let sealed = security
            .seal(&serde_json::to_vec(&context).unwrap(), b"platform-oauth-v1")
            .unwrap();
        let state_value = random();
        security
            .store_oauth_state(
                &state_value,
                &crate::security::OAuthState {
                    provider: "github-issues".into(),
                    redirect_uri: context.request.redirect_uri.clone(),
                    tenant_id: "".into(),
                    user_id: context.request.user_id.clone(),
                    verifier: random(),
                    context: Some(sealed),
                },
            )
            .await
            .unwrap();
        let jar = PrivateCookieJar::new(s.key.clone())
            .add(private_cookie(PROVIDER_COOKIE, context.binding));
        let cookies = jar
            .into_response()
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|value| {
                value
                    .to_str()
                    .unwrap()
                    .split(';')
                    .next()
                    .unwrap()
                    .to_owned()
            })
            .collect::<Vec<_>>();
        let callback = crate::router(s)
            .oneshot(
                axum::http::Request::builder()
                    .uri(format!(
                        "/oauth/github-issues/callback?state={state_value}&code=code"
                    ))
                    .header(header::COOKIE, cookies.join("; "))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(callback.status(), StatusCode::BAD_REQUEST);
        assert_eq!(tokens.load(Ordering::SeqCst), 1);
        assert_eq!(identities.load(Ordering::SeqCst), 1);
        assert!(!callback
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .any(|value| value.to_str().unwrap().starts_with("session=")));
        assert!(security
            .take_handoff("missing", &context.request.code_challenge)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn router_accepts_bootstrap_without_tenant_fields() {
        use tower::ServiceExt;
        // An unconfigured provider is a product error, not a missing-tenant query rejection.
        let app = crate::router(state(None));
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri(request().local_url())
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        if status == StatusCode::OK {
            let policy = response.headers()["content-security-policy"]
                .to_str()
                .unwrap();
            assert!(policy.contains("form-action 'self' https://auth.example https://hub.example"));
            assert!(!policy.contains("spotify"));
            assert_eq!(response.headers()[header::REFERRER_POLICY], "same-origin");
        }
        let body = axum::body::to_bytes(response.into_body(), 16384)
            .await
            .unwrap();
        assert!(!String::from_utf8_lossy(&body).contains("deserialize"));
        assert!(
            status == StatusCode::OK || String::from_utf8_lossy(&body).contains("not available")
        );
    }

    #[tokio::test]
    async fn consent_rejects_missing_cookie_and_google_session() {
        let s = state(None);
        let jar = PrivateCookieJar::new(s.key.clone());
        let result = authorize(
            State(s.clone()),
            jar.clone(),
            HeaderMap::new(),
            Form(Approval {
                csrf: "wrong".into(),
                api_key: None,
            }),
        )
        .await;
        assert_eq!(result.status(), StatusCode::BAD_REQUEST);
        let consent = Consent {
            request: request(),
            csrf: "valid".into(),
            expires: crate::proxy::now_unix() + 600,
        };
        let jar = jar.add(private_cookie(
            CONSENT_COOKIE,
            serde_json::to_string(&consent).unwrap(),
        ));
        let result = authorize(
            State(s),
            jar,
            HeaderMap::new(),
            Form(Approval {
                csrf: "valid".into(),
                api_key: None,
            }),
        )
        .await;
        let body = axum::body::to_bytes(result.into_body(), 16384)
            .await
            .unwrap();
        assert!(String::from_utf8_lossy(&body).contains("cannot establish a tenant identity"));
    }

    fn api_key_catalog() -> crate::catalog::Catalog {
        crate::catalog::Catalog::from_test_document(
            "clockify",
            serde_json::json!({
                "servers": [{"url": "https://api.clockify.me/v1"}],
                "components": {"securitySchemes": {"clockifyApiKey": {
                    "type": "apiKey", "in": "header", "name": "X-Api-Key"
                }}},
                "security": [{"clockifyApiKey": []}],
                "paths": {"/workspaces": {"get": {}}}
            }),
            serde_json::json!({}),
        )
    }

    fn api_key_request() -> Request {
        Request {
            platform: "clockify".into(),
            redirect_uri:
                "https://hub.example/app/integrations?integration_state=state&platform=clockify"
                    .into(),
            user_id: "did:ad:agent:test".into(),
            code_challenge: pkce_challenge(&"a".repeat(43)).unwrap(),
            code_challenge_method: "S256".into(),
            credentials: Credentials::Connection,
        }
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_api_key_authorize_seals_the_submitted_key_without_a_provider_redirect() {
        let db = std::env::var("TEST_DATABASE_URL")
            .expect("set TEST_DATABASE_URL to an isolated test database");
        let security =
            Security::connect(&db, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", vec![])
                .await
                .unwrap();
        let mut s = state(Some(security.clone()));
        s.catalog = api_key_catalog();
        let user = session::SessionUser::new(
            "fixture-clockify-tenant".into(),
            "fixture@example.com".into(),
            "Fixture".into(),
            None,
        );
        let session_jar = session::set_session(PrivateCookieJar::new(s.key.clone()), &user);

        // A wrong CSRF is rejected before the nonce (and thus the key) is ever consulted.
        let consent_a = Consent {
            request: api_key_request(),
            csrf: random(),
            expires: crate::proxy::now_unix() + 600,
        };
        let jar_a = session_jar.clone().add(private_cookie(
            CONSENT_COOKIE,
            serde_json::to_string(&consent_a).unwrap(),
        ));
        assert_eq!(
            authorize(
                State(s.clone()),
                jar_a.clone(),
                HeaderMap::new(),
                Form(Approval {
                    csrf: "wrong".into(),
                    api_key: Some("clockify-secret".into()),
                })
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );

        // A correct CSRF with a blank key is rejected (and burns that consent's nonce).
        let blank_key_result = authorize(
            State(s.clone()),
            jar_a.clone(),
            HeaderMap::new(),
            Form(Approval {
                csrf: consent_a.csrf.clone(),
                api_key: Some("   ".into()),
            }),
        )
        .await;
        assert_eq!(blank_key_result.status(), StatusCode::BAD_REQUEST);
        let body = axum::body::to_bytes(blank_key_result.into_body(), 16384)
            .await
            .unwrap();
        assert!(String::from_utf8_lossy(&body).contains("valid API key"));

        // A fresh consent, correct CSRF and a real key completes without ever
        // touching `oauth::begin`/`oauth::callback` or a provider redirect.
        let consent_b = Consent {
            request: api_key_request(),
            csrf: random(),
            expires: crate::proxy::now_unix() + 600,
        };
        let jar_b = session_jar.add(private_cookie(
            CONSENT_COOKIE,
            serde_json::to_string(&consent_b).unwrap(),
        ));
        let response = authorize(
            State(s.clone()),
            jar_b,
            HeaderMap::new(),
            Form(Approval {
                csrf: consent_b.csrf.clone(),
                api_key: Some("clockify-secret".into()),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        let location = response.headers()[header::LOCATION].to_str().unwrap();
        assert!(location.starts_with(
            "https://hub.example/app/integrations?integration_state=state&platform=clockify"
        ));
        let redirect = Url::parse(location).unwrap();
        let handoff_code = redirect
            .query_pairs()
            .find(|(name, _)| name == "connection_code")
            .map(|(_, value)| value.into_owned())
            .unwrap();

        let redeemed = redeem(
            State(s.clone()),
            Json(Redemption {
                code: handoff_code,
                code_verifier: "a".repeat(43),
            }),
        )
        .await;
        assert_eq!(redeemed.status(), StatusCode::OK);
        let body = axum::body::to_bytes(redeemed.into_body(), 16384)
            .await
            .unwrap();
        assert!(!String::from_utf8_lossy(&body).contains("clockify-secret"));
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["platform"], "clockify");
        let connection_code = body["connection_code"].as_str().unwrap();
        let envelope = security
            .take_connection_code(connection_code)
            .await
            .unwrap()
            .unwrap();
        let plaintext = security
            .open(&envelope, b"connection-credential-v1")
            .unwrap();
        let credential: crate::proxy::StoredCredential =
            serde_json::from_slice(&plaintext).unwrap();
        match credential {
            crate::proxy::StoredCredential::ApiKey {
                provider,
                tenant_id,
                user_id,
                key,
            } => {
                assert_eq!(provider, "clockify");
                assert_eq!(tenant_id, "fixture-clockify-tenant");
                assert_eq!(user_id, "did:ad:agent:test");
                assert_eq!(key, "clockify-secret");
            }
            crate::proxy::StoredCredential::OAuth { .. } => {
                panic!("expected an apiKey credential")
            }
        }
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_handoff_is_pkce_bound_single_use_expiring_and_grant_scoped() {
        let db = std::env::var("TEST_DATABASE_URL")
            .expect("set TEST_DATABASE_URL to an isolated test database");
        let security =
            Security::connect(&db, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", vec![])
                .await
                .unwrap();
        let s = state(Some(security.clone()));
        let verifier = "a".repeat(43);
        let mut context = OAuthContext {
            request: request(),
            binding: random(),
            mode: BootstrapMode::ExistingTenant {
                tenant_id: "tenant".into(),
            },
        };
        let credential = security.seal(br#"{"provider":"github-issues","tenant_id":"tenant","user_id":"did:ad:agent:test","access_token":"fixture-token","refresh_token":null,"expires_at":null}"#, b"connection-credential-v1").unwrap();
        let handoff_code = handoff(&security, &context, "tenant", &credential)
            .await
            .unwrap();
        let wrong = redeem(
            State(s.clone()),
            Json(Redemption {
                code: handoff_code.clone(),
                code_verifier: "b".repeat(43),
            }),
        )
        .await;
        assert_eq!(wrong.status(), StatusCode::BAD_REQUEST);
        let response = redeem(
            State(s.clone()),
            Json(Redemption {
                code: handoff_code.clone(),
                code_verifier: verifier.clone(),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let body = axum::body::to_bytes(response.into_body(), 16384)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["platform"], "github-issues");
        assert!(body.get("tenant_secret").is_none());
        assert!(!body.to_string().contains("fixture-token"));
        let rotating = body["connection_code"].as_str().unwrap();
        assert_eq!(
            security.take_connection_code(rotating).await.unwrap(),
            Some(credential.clone())
        );
        assert!(security
            .take_connection_code(rotating)
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            redeem(
                State(s.clone()),
                Json(Redemption {
                    code: handoff_code,
                    code_verifier: verifier.clone()
                })
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );

        context.request.credentials = Credentials::ConnectionAndTenantSecret;
        let code = handoff(&security, &context, "tenant", &credential)
            .await
            .unwrap();
        let response = redeem(
            State(s.clone()),
            Json(Redemption {
                code,
                code_verifier: verifier.clone(),
            }),
        )
        .await;
        let bytes = axum::body::to_bytes(response.into_body(), 16384)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            body["tenant_secret"],
            crate::tenant_secret::derive(&s.server_secret, "tenant")
        );

        // Two simultaneous valid exchanges cannot mint two rotating credentials.
        let code = handoff(&security, &context, "tenant", &credential)
            .await
            .unwrap();
        let challenge = pkce_challenge(&verifier).unwrap();
        let (first, second) = tokio::join!(
            security.take_handoff(&code, &challenge),
            security.take_handoff(&code, &challenge)
        );
        assert_ne!(first.unwrap().is_some(), second.unwrap().is_some());

        let code = handoff(&security, &context, "tenant", &credential)
            .await
            .unwrap();
        let (client, connection) = tokio_postgres::connect(&db, tokio_postgres::NoTls)
            .await
            .unwrap();
        tokio::spawn(async move {
            connection.await.unwrap();
        });
        client.execute("UPDATE connection_handoffs SET expires_at = NOW() - INTERVAL '1 second' WHERE code = $1", &[&code]).await.unwrap();
        assert!(security
            .take_handoff(&code, &challenge)
            .await
            .unwrap()
            .is_none());

        let user = session::SessionUser::new(
            "tenant".into(),
            "fixture@example.com".into(),
            "Fixture".into(),
            None,
        );
        let jar = session::set_session(PrivateCookieJar::new(s.key.clone()), &user)
            .add(private_cookie(PROVIDER_COOKIE, context.binding.clone()));
        let envelope = security
            .seal(&serde_json::to_vec(&context).unwrap(), b"platform-oauth-v1")
            .unwrap();
        assert!(oauth_context(&security, &envelope, &jar).is_some());
        assert!(
            oauth_context(&security, &envelope, &PrivateCookieJar::new(s.key.clone())).is_none()
        );

        let code = handoff(&security, &context, "tenant", &credential)
            .await
            .unwrap();
        let revoked = Security::connect(
            &db,
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            vec!["tenant".into()],
        )
        .await
        .unwrap();
        assert_eq!(
            redeem(
                State(state(Some(revoked))),
                Json(Redemption {
                    code,
                    code_verifier: verifier
                })
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
    }
    #[tokio::test]
    async fn router_preserves_legacy_numeric_query_parsing() {
        use tower::ServiceExt;
        let s = state(None);
        let ts = crate::proxy::now_unix();
        let nonce = random();
        let challenge = crate::tenant_secret::sign(&s.server_secret, &format!("{ts}.{nonce}"));
        let secret = crate::tenant_secret::derive(&s.server_secret, "tenant");
        let mut query = Url::parse("https://localthought.io/connect").unwrap();
        query
            .query_pairs_mut()
            .append_pair("redirect_uri", "https://hub.example/cb")
            .append_pair("ts", &ts.to_string())
            .append_pair("nonce", &nonce)
            .append_pair("challenge", &challenge)
            .append_pair("tenant_id", "tenant")
            .append_pair("user_id", "actor")
            .append_pair("user_id_sig", &crate::tenant_secret::sign(&secret, "actor"))
            .append_pair("response", &crate::tenant_secret::sign(&secret, &challenge));
        let response = crate::router(s)
            .oneshot(
                axum::http::Request::builder()
                    .uri(format!("/connect?{}", query.query().unwrap()))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
    }
    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL and fixture OAuth configuration; CI runs it"]
    async fn postgres_consent_binds_google_identity_and_provider_callback_to_browser() {
        use tower::ServiceExt;
        let db = std::env::var("TEST_DATABASE_URL").unwrap();
        let security =
            Security::connect(&db, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", vec![])
                .await
                .unwrap();
        let s = state(Some(security.clone()));
        let user = session::SessionUser::new(
            "fixture-google-tenant".into(),
            "fixture@example.com".into(),
            "Fixture".into(),
            None,
        );
        let mut consent = Consent {
            request: request(),
            csrf: random(),
            expires: crate::proxy::now_unix() + 600,
        };
        let jar = session::set_session(PrivateCookieJar::new(s.key.clone()), &user).add(
            private_cookie(CONSENT_COOKIE, serde_json::to_string(&consent).unwrap()),
        );
        assert_eq!(
            authorize(
                State(s.clone()),
                jar.clone(),
                HeaderMap::new(),
                Form(Approval {
                    csrf: "wrong".into(),
                    api_key: None,
                })
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
        let mut foreign = HeaderMap::new();
        foreign.insert(header::ORIGIN, "https://foreign.example".parse().unwrap());
        assert_eq!(
            authorize(
                State(s.clone()),
                jar.clone(),
                foreign,
                Form(Approval {
                    csrf: consent.csrf.clone(),
                    api_key: None,
                })
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
        let mut opaque = HeaderMap::new();
        opaque.insert(header::ORIGIN, "null".parse().unwrap());
        assert_eq!(
            authorize(
                State(s.clone()),
                jar.clone(),
                opaque,
                Form(Approval {
                    csrf: consent.csrf.clone(),
                    api_key: None,
                })
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
        let response = authorize(
            State(s.clone()),
            jar.clone(),
            HeaderMap::new(),
            Form(Approval {
                csrf: consent.csrf.clone(),
                api_key: None,
            }),
        )
        .await;
        assert_eq!(
            response.status(),
            StatusCode::SEE_OTHER,
            "configure fixture OAUTH_GITHUB_ISSUES_CLIENT_ID and CLIENT_SECRET"
        );
        let destination =
            Url::parse(response.headers()[header::LOCATION].to_str().unwrap()).unwrap();
        assert_eq!(destination.host_str(), Some("auth.example"));
        let provider_state = destination
            .query_pairs()
            .find(|(k, _)| k == "state")
            .unwrap()
            .1
            .into_owned();
        let stored = security
            .take_oauth_state(&provider_state)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.tenant_id, user.subject);
        assert_eq!(stored.user_id, consent.request.user_id);
        assert_eq!(stored.provider, "github-issues");
        assert_eq!(stored.redirect_uri, consent.request.redirect_uri);
        assert!(security
            .take_oauth_state(&provider_state)
            .await
            .unwrap()
            .is_none());
        security
            .store_oauth_state(&provider_state, &stored)
            .await
            .unwrap();
        // Keep both the authenticated Google session and the newly set provider binding cookie.
        let original_cookies = jar
            .into_response()
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|v| v.to_str().unwrap().split(';').next().unwrap().to_string())
            .collect::<Vec<_>>();
        let mut cookies = original_cookies;
        cookies.extend(
            response
                .headers()
                .get_all(header::SET_COOKIE)
                .iter()
                .filter_map(|v| {
                    let value = v.to_str().unwrap();
                    value
                        .starts_with("platform_oauth=")
                        .then(|| value.split(';').next().unwrap().to_string())
                }),
        );
        let response = crate::router(s.clone())
            .oneshot(
                axum::http::Request::builder()
                    .uri(format!(
                        "/oauth/github-issues/callback?state={provider_state}&error=access_denied"
                    ))
                    .header(header::COOKIE, cookies.join("; "))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        let target = Url::parse(response.headers()[header::LOCATION].to_str().unwrap()).unwrap();
        assert_eq!(target.origin().ascii_serialization(), "https://hub.example");
        assert!(target
            .query_pairs()
            .any(|(k, v)| k == "integration_state" && v == "state"));
        assert!(target
            .query_pairs()
            .any(|(k, v)| k == "error" && v == "access_denied"));
        assert!(!target.query_pairs().any(|(k, _)| k == "connection_code"));
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert!(security
            .take_oauth_state(&provider_state)
            .await
            .unwrap()
            .is_none());
        // Approval cannot be replayed even if a browser retains its original consent cookie.
        let jar = session::set_session(PrivateCookieJar::new(s.key.clone()), &user).add(
            private_cookie(CONSENT_COOKIE, serde_json::to_string(&consent).unwrap()),
        );
        assert_eq!(
            authorize(
                State(s.clone()),
                jar,
                HeaderMap::new(),
                Form(Approval {
                    csrf: consent.csrf.clone(),
                    api_key: None,
                })
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
        consent.csrf = random();
        consent.expires = 0;
        let jar = session::set_session(PrivateCookieJar::new(s.key.clone()), &user).add(
            private_cookie(CONSENT_COOKIE, serde_json::to_string(&consent).unwrap()),
        );
        assert_eq!(
            authorize(
                State(s),
                jar,
                HeaderMap::new(),
                Form(Approval {
                    csrf: consent.csrf,
                    api_key: None
                })
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
    }
}
