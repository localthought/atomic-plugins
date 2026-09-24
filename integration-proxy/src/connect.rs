//! Connecting a provider (issue #54, section 4).
//!
//! 1. The data browser opens `/connect?platform&redirect_uri&code_challenge&code_challenge_method=S256`.
//!    There is no proxy login and no `user_id`: this page is a consent
//!    screen naming the platform and where the browser will return to.
//! 2. `POST /connect/authorize` sends the browser to the provider's OAuth,
//!    or, for an API-key platform, seals the key pasted on the consent page.
//! 3. The provider callback (`oauth.rs`) sends the browser back to
//!    `redirect_uri?connection_code=<handoff>`; the handoff is single-use,
//!    valid five minutes, and bound to the PKCE challenge.
//! 4. `POST /connect/redeem`, signed with the user's key (Atomic v2), carries
//!    the handoff and the PKCE verifier. The signer becomes the connection's
//!    owner. Only the page that started the flow holds the verifier, so only
//!    it can redeem, and it must also prove possession of the owner's key.
use crate::{
    api_error::ApiError, oauth, providers::Provider, security::Security, templates, AppState,
};
use axum::{
    body::Bytes,
    extract::{Form, OriginalUri, Query, State},
    http::{header, HeaderMap, Method, StatusCode},
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
const HANDOFF_AAD: &[u8] = b"platform-handoff-v2";
pub(crate) const OAUTH_CONTEXT_AAD: &[u8] = b"platform-oauth-v2";

/// A validated `/connect` request.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Request {
    pub platform: String,
    pub redirect_uri: String,
    pub code_challenge: String,
    pub code_challenge_method: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct Consent {
    request: Request,
    csrf: String,
    expires: u64,
}

/// What travels (sealed) through the provider's authorization.
#[derive(Deserialize, Serialize)]
pub struct OAuthContext {
    pub request: Request,
    /// Random value also stored in a cookie, binding the callback to the
    /// browser that approved the consent screen.
    pub binding: String,
}

/// What a handoff code redeems to.
#[derive(Deserialize, Serialize)]
struct Handoff {
    platform: String,
    credential: crate::proxy::StoredCredential,
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

/// The Tauri app's deep-link scheme (decision 4). The OS hands such a URL to
/// the app; the provider itself only ever sees the proxy's `https` callback.
const DEEP_LINK_SCHEME: &str = "atomic";

impl Request {
    fn validate(&self) -> Result<Url, &'static str> {
        let url = Url::parse(&self.redirect_uri).map_err(|_| "Invalid return address")?;
        let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        let scheme_ok = url.scheme() == "https"
            || (url.scheme() == "http" && loopback)
            || url.scheme() == DEEP_LINK_SCHEME;
        if self.redirect_uri.len() > 1500
            || url.host_str().is_none_or(str::is_empty)
            || !scheme_ok
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || url
                .query_pairs()
                .any(|(name, _)| matches!(name.as_ref(), "connection_code" | "error"))
        {
            return Err("Invalid return address");
        }
        if self.code_challenge_method != "S256"
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
}

/// How the consent page names where the browser returns to: the origin for
/// a web address, the scheme and host for the app's deep link.
fn destination_label(url: &Url) -> String {
    if url.scheme() == DEEP_LINK_SCHEME {
        format!(
            "the Atomic app ({}://{})",
            url.scheme(),
            url.host_str().unwrap_or("")
        )
    } else {
        url.origin().ascii_serialization()
    }
}

/// The CSP source that lets the consent form's redirect chain end at `url`.
fn form_action_source(url: &Url) -> String {
    if url.scheme() == DEEP_LINK_SCHEME {
        format!("{DEEP_LINK_SCHEME}:")
    } else {
        url.origin().ascii_serialization()
    }
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

/// `GET /connect`: the consent screen.
pub async fn page(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    jar: PrivateCookieJar,
) -> Response {
    let request = match Query::<Request>::try_from_uri(&uri) {
        Ok(Query(request)) => request,
        Err(_) => return error("Invalid connection request; start again from your hub"),
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
        expires: crate::now_secs() + 600,
    };
    let jar = jar.add(private_cookie(
        CONSENT_COOKIE,
        serde_json::to_string(&consent).unwrap(),
    ));
    let mut response = protected((
        jar,
        Html(templates::render_platform_connect(
            &request.platform,
            &destination_label(&target),
            &consent.csrf,
            matches!(scheme, crate::providers::SecurityScheme::ApiKey(_)),
        )),
    ));
    // Keep the consent form's same-origin POST attributable while sending no
    // referrer to the selected provider.
    response
        .headers_mut()
        .insert(header::REFERRER_POLICY, "same-origin".parse().unwrap());
    // Chrome applies form-action to redirects too, including an
    // already-authorized provider returning straight through its callback to
    // the hub. An apiKey platform never redirects to a third party, so only
    // the caller's own redirect_uri needs allowing.
    let base = response.headers()["content-security-policy"]
        .to_str()
        .unwrap()
        .to_owned();
    let policy = match &scheme {
        crate::providers::SecurityScheme::OAuth(provider) => format!(
            "{base}; form-action 'self' {} {}",
            Url::parse(&provider.authorization_url)
                .unwrap()
                .origin()
                .ascii_serialization(),
            form_action_source(&target)
        ),
        crate::providers::SecurityScheme::ApiKey(_) => {
            format!("{base}; form-action 'self' {}", form_action_source(&target))
        }
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

/// `POST /connect/authorize`: the consent form's submission.
pub async fn authorize(
    State(state): State<AppState>,
    jar: PrivateCookieJar,
    headers: HeaderMap,
    Form(approval): Form<Approval>,
) -> Response {
    // Browser form origin is an extra defense; the encrypted cookie and random CSRF token are required.
    if headers
        .get(header::ORIGIN)
        .is_some_and(|origin| origin.to_str().ok() != Some(state.public_origin.as_str()))
    {
        return error("Invalid connection approval");
    }
    let Some(cookie) = jar.get(CONSENT_COOKIE) else {
        return error("Connection request expired; start again from your hub");
    };
    let Ok(consent) = serde_json::from_str::<Consent>(cookie.value()) else {
        return error("Invalid connection approval");
    };
    if consent.expires <= crate::now_secs()
        || consent.csrf != approval.csrf
        || consent.request.validate().is_err()
    {
        return error("Connection request expired or invalid; start again from your hub");
    }
    let Some(security) = &state.security else {
        return error("Connections are unavailable");
    };
    if !matches!(
        security
            .consume_nonce(&format!("consent:{}", consent.csrf))
            .await,
        Ok(true)
    ) {
        return error("Connection approval expired or already used");
    }
    let jar = jar.remove(Cookie::build(CONSENT_COOKIE).path("/").build());
    // Only an OAuth platform redirects to a third party from here; an apiKey
    // platform already has everything it needs (the submitted key) and
    // completes the handoff directly (decision 11).
    match state.catalog.security_scheme(&consent.request.platform) {
        Ok(crate::providers::SecurityScheme::ApiKey(_)) => {
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
                key: key.to_owned(),
            };
            let code = match handoff(security, &consent.request, credential).await {
                Ok(code) => code,
                Err(()) => return error("Could not complete connection"),
            };
            finish_with_connection_code(jar, &consent.request.redirect_uri, &code)
        }
        Ok(crate::providers::SecurityScheme::OAuth(_)) => {
            let context = OAuthContext {
                request: consent.request.clone(),
                binding: random(),
            };
            let Ok(sealed_context) =
                security.seal(&serde_json::to_vec(&context).unwrap(), OAUTH_CONTEXT_AAD)
            else {
                return error("Could not start connection");
            };
            let url = match oauth::begin(&state, &consent.request.platform, sealed_context).await {
                Ok(url) => url,
                Err(()) => return error("Could not start platform authorization"),
            };
            protected((
                jar.add(private_cookie(PROVIDER_COOKIE, context.binding)),
                Redirect::to(&url),
            ))
        }
        Err(_) => error("This platform is not available for connection"),
    }
}

/// Opens a sealed OAuth context and checks it belongs to this browser.
pub fn oauth_context(
    security: &Security,
    value: &str,
    jar: &PrivateCookieJar,
) -> Option<OAuthContext> {
    let context: OAuthContext =
        serde_json::from_slice(&security.open(value, OAUTH_CONTEXT_AAD)?).ok()?;
    if jar.get(PROVIDER_COOKIE)?.value() != context.binding {
        return None;
    }
    Some(context)
}

pub fn clear_provider_cookie(jar: PrivateCookieJar) -> PrivateCookieJar {
    jar.remove(Cookie::build(PROVIDER_COOKIE).path("/").build())
}

/// Redirects the browser back to `redirect_uri` with the handoff
/// `connection_code` appended. Shared by the OAuth callback and the apiKey
/// branch of `authorize`.
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
    protected((clear_provider_cookie(jar), Redirect::to(redirect.as_str())))
}

/// Seals `credential` into a single-use, five-minute handoff bound to the
/// request's PKCE challenge, and returns its code.
pub(crate) async fn handoff(
    security: &Security,
    request: &Request,
    credential: crate::proxy::StoredCredential,
) -> Result<String, ()> {
    let handoff = Handoff {
        platform: request.platform.clone(),
        credential,
    };
    let envelope = security
        .seal(&serde_json::to_vec(&handoff).map_err(|_| ())?, HANDOFF_AAD)
        .map_err(|_| ())?;
    let code = random();
    security
        .store_handoff(&code, &request.code_challenge, &envelope)
        .await
        .map_err(|_| ())?;
    Ok(code)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Redemption {
    code: String,
    code_verifier: String,
}

/// `POST /connect/redeem`, signed (Atomic v2) by the key that will own the
/// connection. Body `{"code", "code_verifier"}`; answers
/// `{"connection_id", "platform", "owner"}`.
pub async fn redeem(
    State(state): State<AppState>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match redeem_inner(&state, &method, &uri, &headers, &body).await {
        Ok(response) => protected(response),
        Err(error) => error.into_response(),
    }
}

async fn redeem_inner(
    state: &AppState,
    method: &Method,
    uri: &axum::http::Uri,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Json<serde_json::Value>, ApiError> {
    let security = state.security.as_ref().ok_or(ApiError::Unavailable)?;
    let owner = crate::signature::authenticate(state, security, method, uri, headers, body).await?;
    crate::check_access(state, &owner).await?;
    let request: Redemption = serde_json::from_slice(body)
        .map_err(|_| ApiError::BadRequest("body must be {\"code\", \"code_verifier\"}"))?;
    let challenge = pkce_challenge(&request.code_verifier).ok_or(ApiError::InvalidHandoff)?;
    if request.code.len() != 43 {
        return Err(ApiError::InvalidHandoff);
    }
    let envelope = security
        .take_handoff(&request.code, &challenge)
        .await
        .map_err(|_| ApiError::Unavailable)?
        .ok_or(ApiError::InvalidHandoff)?;
    let handoff: Handoff = security
        .open(&envelope, HANDOFF_AAD)
        .and_then(|plaintext| serde_json::from_slice(&plaintext).ok())
        .ok_or(ApiError::InvalidHandoff)?;
    let credential = serde_json::to_vec(&handoff.credential).map_err(|_| ApiError::Internal)?;
    let connection_id = security
        .create_connection(&handoff.platform, owner.as_str(), &credential)
        .await
        .map_err(|_| ApiError::Unavailable)?;
    Ok(Json(serde_json::json!({
        "connection_id": connection_id,
        "platform": handoff.platform,
        "owner": owner.as_str(),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_id::test_signer::Agent;
    use crate::test_support::{body_json, signed_request, state};
    use tower::ServiceExt;

    fn request() -> Request {
        Request {
            platform: "github-issues".into(),
            redirect_uri:
                "https://hub.example/app/integrations?integration_state=state&platform=github-issues"
                    .into(),
            code_challenge: pkce_challenge(&"a".repeat(43)).unwrap(),
            code_challenge_method: "S256".into(),
        }
    }

    fn connect_uri(request: &Request) -> String {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("platform", &request.platform)
            .append_pair("redirect_uri", &request.redirect_uri)
            .append_pair("code_challenge", &request.code_challenge)
            .append_pair("code_challenge_method", &request.code_challenge_method)
            .finish();
        format!("/connect?{query}")
    }

    #[test]
    fn return_address_rejects_insecure_or_ambiguous_targets() {
        for value in [
            "http://hub.example/cb",
            "javascript:alert(1)",
            "https://user:pass@hub.example/cb",
            "https://hub.example/cb#fragment",
            "https://hub.example/cb?connection_code=evil",
            "https://hub.example/cb?error=evil",
            "tauri://localhost/app/integrations",
            "atomic:integrations",
            "atomic://user@integrations/return",
        ] {
            let mut request = request();
            request.redirect_uri = value.into();
            assert!(request.validate().is_err(), "{value}");
        }
        for value in [
            "http://localhost:6747/app/integrations",
            "http://127.0.0.1:9883/app/integrations",
            "atomic://integrations/return",
            "atomic://integrations/return?integration_state=abc",
        ] {
            let mut request = request();
            request.redirect_uri = value.into();
            assert!(request.validate().is_ok(), "{value}");
        }
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

    #[tokio::test]
    async fn the_consent_page_needs_no_login_and_names_the_destination() {
        let mut s = state(None);
        s.catalog = crate::catalog::Catalog::for_test("github-issues");
        let response = crate::router(s)
            .oneshot(
                axum::http::Request::builder()
                    .uri(connect_uri(&request()))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body = String::from_utf8(
            axum::body::to_bytes(response.into_body(), 65_536)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        // The fixture provider is only "configured" when CI's fixture OAuth
        // env vars are present; otherwise the page says so, without asking
        // anyone to log in either way.
        assert!(!body.to_lowercase().contains("log in"), "{body}");
        if status == StatusCode::OK {
            assert!(body.contains("https://hub.example"));
        } else {
            assert!(body.contains("not available"));
        }
    }

    #[tokio::test]
    async fn legacy_connect_parameters_are_refused() {
        let s = state(None);
        for query in [
            // The tenant-secret bootstrap (flag day, decision 6).
            "/connect?redirect_uri=https%3A%2F%2Fhub.example%2Fcb&ts=1&nonce=n&challenge=c&tenant_id=t&user_id=u&user_id_sig=s&response=r",
            // No platform.
            "/connect?redirect_uri=https%3A%2F%2Fhub.example%2Fcb",
        ] {
            let response = crate::router(s.clone())
                .oneshot(
                    axum::http::Request::builder()
                        .uri(query)
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{query}");
        }
    }

    #[tokio::test]
    async fn removed_tenant_routes_are_gone() {
        let s = state(None);
        for (method, path) in [
            ("GET", "/session"),
            ("GET", "/auth/login"),
            ("GET", "/auth/callback"),
            ("POST", "/auth/logout"),
            ("GET", "/auth/login/github-issues"),
            ("POST", "/connect"),
            ("GET", "/proxy"),
            ("GET", "/oauth/github-issues/start"),
        ] {
            let response = crate::router(s.clone())
                .oneshot(
                    axum::http::Request::builder()
                        .method(method)
                        .uri(path)
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert!(
                matches!(
                    response.status(),
                    StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED
                ),
                "{method} {path}: {}",
                response.status()
            );
        }
    }

    #[tokio::test]
    async fn consent_rejects_a_missing_cookie_or_wrong_csrf() {
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
            expires: crate::now_secs() + 600,
        };
        let jar = jar.add(private_cookie(
            CONSENT_COOKIE,
            serde_json::to_string(&consent).unwrap(),
        ));
        for (csrf, origin) in [
            ("wrong", None),
            ("valid", Some("https://foreign.example")),
            ("valid", Some("null")),
        ] {
            let mut headers = HeaderMap::new();
            if let Some(origin) = origin {
                headers.insert(header::ORIGIN, origin.parse().unwrap());
            }
            let result = authorize(
                State(s.clone()),
                jar.clone(),
                headers,
                Form(Approval {
                    csrf: csrf.into(),
                    api_key: None,
                }),
            )
            .await;
            assert_eq!(
                result.status(),
                StatusCode::BAD_REQUEST,
                "{csrf} {origin:?}"
            );
        }
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
            code_challenge: pkce_challenge(&"a".repeat(43)).unwrap(),
            code_challenge_method: "S256".into(),
        }
    }

    async fn redeem_as(
        s: &AppState,
        agent: &Agent,
        code: &str,
        verifier: &str,
    ) -> axum::response::Response {
        let body = serde_json::json!({"code": code, "code_verifier": verifier}).to_string();
        crate::router(s.clone())
            .oneshot(signed_request(
                s,
                agent,
                "POST",
                "/connect/redeem",
                body.into_bytes(),
            ))
            .await
            .unwrap()
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_api_key_connect_makes_the_redeem_signer_the_owner() {
        let security = crate::test_support::security().await;
        let mut s = state(Some(security.clone()));
        s.catalog = api_key_catalog();
        let consent = Consent {
            request: api_key_request(),
            csrf: random(),
            expires: crate::now_secs() + 600,
        };
        let jar = PrivateCookieJar::new(s.key.clone()).add(private_cookie(
            CONSENT_COOKIE,
            serde_json::to_string(&consent).unwrap(),
        ));
        // A blank key is refused (and burns this consent).
        let blank = authorize(
            State(s.clone()),
            jar.clone(),
            HeaderMap::new(),
            Form(Approval {
                csrf: consent.csrf.clone(),
                api_key: Some("  ".into()),
            }),
        )
        .await;
        assert_eq!(blank.status(), StatusCode::BAD_REQUEST);
        let consent = Consent {
            request: api_key_request(),
            csrf: random(),
            expires: crate::now_secs() + 600,
        };
        let jar = PrivateCookieJar::new(s.key.clone()).add(private_cookie(
            CONSENT_COOKIE,
            serde_json::to_string(&consent).unwrap(),
        ));
        let response = authorize(
            State(s.clone()),
            jar.clone(),
            HeaderMap::new(),
            Form(Approval {
                csrf: consent.csrf.clone(),
                api_key: Some("clockify-secret".into()),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        let location = Url::parse(response.headers()[header::LOCATION].to_str().unwrap()).unwrap();
        assert_eq!(
            location.origin().ascii_serialization(),
            "https://hub.example"
        );
        let code = location
            .query_pairs()
            .find(|(k, _)| k == "connection_code")
            .unwrap()
            .1
            .into_owned();
        // The consent cannot be approved twice.
        let again = authorize(
            State(s.clone()),
            jar,
            HeaderMap::new(),
            Form(Approval {
                csrf: consent.csrf.clone(),
                api_key: Some("clockify-secret".into()),
            }),
        )
        .await;
        assert_eq!(again.status(), StatusCode::BAD_REQUEST);

        let owner = Agent::new(21);
        // Wrong verifier: refused, and the handoff survives.
        let wrong = redeem_as(&s, &owner, &code, &"b".repeat(43)).await;
        assert_eq!(wrong.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body_json(wrong).await["error"], "invalid_handoff");
        let ok = redeem_as(&s, &owner, &code, &"a".repeat(43)).await;
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(ok.headers()[header::CACHE_CONTROL], "no-store");
        let body = body_json(ok).await;
        assert_eq!(body["platform"], "clockify");
        assert_eq!(body["owner"], owner.id());
        assert!(!body.to_string().contains("clockify-secret"));
        let connection_id = body["connection_id"].as_str().unwrap();
        let record = security
            .load_connection(connection_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(record.owner, owner.id());
        let credential: crate::proxy::StoredCredential =
            serde_json::from_slice(&record.credential).unwrap();
        assert!(matches!(
            credential,
            crate::proxy::StoredCredential::ApiKey { ref key, .. } if key == "clockify-secret"
        ));
        // Single use.
        let reused = redeem_as(&s, &owner, &code, &"a".repeat(43)).await;
        assert_eq!(reused.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_redeem_canonicalizes_a_legacy_signer_and_refuses_unsigned_or_denied() {
        let security = crate::test_support::security().await;
        let s = state(Some(security.clone()));
        let credential = crate::proxy::StoredCredential::ApiKey {
            provider: "github-issues".into(),
            key: "k".into(),
        };
        let owner = Agent::new(22);

        // Unsigned.
        let code = handoff(&security, &request(), credential.clone())
            .await
            .unwrap();
        let unsigned = crate::router(s.clone())
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/connect/redeem")
                    .body(axum::body::Body::from(
                        serde_json::json!({"code": code, "code_verifier": "a".repeat(43)})
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unsigned.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(body_json(unsigned).await["error"], "missing_signature");

        // Signed with the legacy did:ad:agent spelling: owner is canonical.
        let body = serde_json::json!({"code": code, "code_verifier": "a".repeat(43)}).to_string();
        let mut legacy = signed_request(&s, &owner, "POST", "/connect/redeem", body.into_bytes());
        legacy.headers_mut().insert(
            crate::signature::AGENT_HEADER,
            owner.legacy_id().parse().unwrap(),
        );
        let response = crate::router(s.clone()).oneshot(legacy).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body_json(response).await["owner"], owner.id());

        // The access policy refuses a denied owner before the handoff is spent.
        let mut denied = state(Some(security.clone()));
        denied.access =
            std::sync::Arc::new(crate::access::EnvAccessPolicy::new(None, vec![owner.id()]));
        let code = handoff(&security, &request(), credential.clone())
            .await
            .unwrap();
        let response = redeem_as(&denied, &owner, &code, &"a".repeat(43)).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(body_json(response).await["error"], "access_denied");
        let response = redeem_as(&s, &owner, &code, &"a".repeat(43)).await;
        assert_eq!(response.status(), StatusCode::OK);

        // An expired handoff.
        let code = handoff(&security, &request(), credential).await.unwrap();
        crate::security::tests::admin()
            .await
            .execute(
                "UPDATE connection_handoffs SET expires_at = NOW() - INTERVAL '1 second' WHERE code = $1",
                &[&code],
            )
            .await
            .unwrap();
        let response = redeem_as(&s, &owner, &code, &"a".repeat(43)).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn postgres_two_simultaneous_redemptions_create_one_connection() {
        let security = crate::test_support::security().await;
        let s = state(Some(security.clone()));
        let code = handoff(
            &security,
            &request(),
            crate::proxy::StoredCredential::ApiKey {
                provider: "github-issues".into(),
                key: "k".into(),
            },
        )
        .await
        .unwrap();
        let (a, b) = (Agent::new(23), Agent::new(24));
        let verifier = "a".repeat(43);
        let (first, second) = tokio::join!(
            redeem_as(&s, &a, &code, &verifier),
            redeem_as(&s, &b, &code, &verifier)
        );
        let statuses = [first.status(), second.status()];
        assert!(statuses.contains(&StatusCode::OK));
        assert!(statuses.contains(&StatusCode::BAD_REQUEST));
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL and fixture OAuth credentials; CI runs it"]
    async fn postgres_oauth_consent_is_bound_to_the_browser_and_cancellation_returns_home() {
        let security = crate::test_support::security().await;
        let s = state(Some(security.clone()));
        let consent = Consent {
            request: request(),
            csrf: random(),
            expires: crate::now_secs() + 600,
        };
        let jar = PrivateCookieJar::new(s.key.clone()).add(private_cookie(
            CONSENT_COOKIE,
            serde_json::to_string(&consent).unwrap(),
        ));
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
        let binding_cookie = response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|v| v.to_str().unwrap().split(';').next().unwrap().to_string())
            .find(|v| v.starts_with("platform_oauth="))
            .unwrap();
        // Another browser (no binding cookie) cannot complete the callback.
        let foreign = crate::router(s.clone())
            .oneshot(
                axum::http::Request::builder()
                    .uri(format!(
                        "/oauth/github-issues/callback?state={provider_state}&error=access_denied"
                    ))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(foreign.status(), StatusCode::BAD_REQUEST);
        // The state was spent by that attempt; start again for the real browser.
        let consent = Consent {
            request: request(),
            csrf: random(),
            expires: crate::now_secs() + 600,
        };
        let jar = PrivateCookieJar::new(s.key.clone()).add(private_cookie(
            CONSENT_COOKIE,
            serde_json::to_string(&consent).unwrap(),
        ));
        let response = authorize(
            State(s.clone()),
            jar,
            HeaderMap::new(),
            Form(Approval {
                csrf: consent.csrf.clone(),
                api_key: None,
            }),
        )
        .await;
        let destination =
            Url::parse(response.headers()[header::LOCATION].to_str().unwrap()).unwrap();
        let provider_state = destination
            .query_pairs()
            .find(|(k, _)| k == "state")
            .unwrap()
            .1
            .into_owned();
        let binding_cookie_2 = response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|v| v.to_str().unwrap().split(';').next().unwrap().to_string())
            .find(|v| v.starts_with("platform_oauth="))
            .unwrap();
        assert_ne!(binding_cookie, binding_cookie_2);
        let cancelled = crate::router(s.clone())
            .oneshot(
                axum::http::Request::builder()
                    .uri(format!(
                        "/oauth/github-issues/callback?state={provider_state}&error=access_denied"
                    ))
                    .header(header::COOKIE, binding_cookie_2)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(cancelled.status(), StatusCode::SEE_OTHER);
        let target = Url::parse(cancelled.headers()[header::LOCATION].to_str().unwrap()).unwrap();
        assert_eq!(target.origin().ascii_serialization(), "https://hub.example");
        assert!(target
            .query_pairs()
            .any(|(k, v)| k == "error" && v == "access_denied"));
        assert!(!target.query_pairs().any(|(k, _)| k == "connection_code"));
        assert_eq!(cancelled.headers()[header::CACHE_CONTROL], "no-store");
    }

    /// The whole flow a data browser runs, against a mocked provider:
    /// consent, provider authorization, callback, signed redeem, a
    /// delegation, and proxied calls by the owner and the delegated app.
    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL and fixture OAuth credentials; CI runs it"]
    async fn postgres_oauth_connect_redeem_delegate_and_proxy_end_to_end() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let tokens = Arc::new(AtomicUsize::new(0));
        let token_counter = tokens.clone();
        let upstream = axum::Router::new()
            .route(
                "/token",
                axum::routing::post(move |body: Bytes| {
                    let token_counter = token_counter.clone();
                    async move {
                        token_counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        let body = String::from_utf8(body.to_vec()).unwrap();
                        assert!(body.contains("grant_type=authorization_code"));
                        assert!(body.contains("code=provider-code"));
                        assert!(body.contains(
                            "redirect_uri=https%3A%2F%2Fproxy.example%2Foauth%2Fgithub-issues%2Fcallback"
                        ));
                        Json(serde_json::json!({"access_token": "provider-token", "refresh_token": "r", "expires_in": 3600}))
                    }
                }),
            )
            .route(
                "/records",
                axum::routing::get(|headers: HeaderMap| async move {
                    Json(serde_json::json!({
                        "authorization": headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()),
                    }))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });

        let security = crate::test_support::security().await;
        let mut s = state(Some(security.clone()));
        s.catalog = crate::catalog::Catalog::from_test_document(
            "github-issues",
            serde_json::json!({
                "servers": [{"url": upstream_url}],
                "components": {"securitySchemes": {"oauth": {"type": "oauth2", "flows": {
                    "authorizationCode": {
                        "authorizationUrl": "https://auth.example/authorize",
                        "tokenUrl": "https://auth.example/token",
                        "scopes": {"read": "Read records"}
                    }
                }}}},
                "security": [{"oauth": ["read"]}],
                "paths": {"/records": {"get": {}}}
            }),
            serde_json::json!({}),
        );
        s.test_upstream = Some(upstream_url);

        // 1. The consent page, with no login, then approval.
        let page = crate::router(s.clone())
            .oneshot(
                axum::http::Request::builder()
                    .uri(connect_uri(&request()))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(page.status(), StatusCode::OK);
        let consent_cookie = page
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|v| v.to_str().unwrap().split(';').next().unwrap().to_string())
            .find(|v| v.starts_with("platform_consent="))
            .unwrap();
        let html = String::from_utf8(
            axum::body::to_bytes(page.into_body(), 65_536)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        let csrf = html
            .split("name=\"csrf\" value=\"")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap()
            .to_owned();
        let approval = crate::router(s.clone())
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/connect/authorize")
                    .header(header::COOKIE, &consent_cookie)
                    .header(header::ORIGIN, crate::test_support::PUBLIC_ORIGIN)
                    .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                    .body(axum::body::Body::from(format!("csrf={csrf}")))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(approval.status(), StatusCode::SEE_OTHER);
        let provider = Url::parse(approval.headers()[header::LOCATION].to_str().unwrap()).unwrap();
        assert_eq!(provider.host_str(), Some("auth.example"));
        let provider_state = provider
            .query_pairs()
            .find(|(k, _)| k == "state")
            .unwrap()
            .1
            .into_owned();
        let binding = approval
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|v| v.to_str().unwrap().split(';').next().unwrap().to_string())
            .find(|v| v.starts_with("platform_oauth="))
            .unwrap();

        // 2. The provider calls back; the browser returns home with a handoff.
        let callback = crate::router(s.clone())
            .oneshot(
                axum::http::Request::builder()
                    .uri(format!(
                        "/oauth/github-issues/callback?state={provider_state}&code=provider-code"
                    ))
                    .header(header::COOKIE, binding)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(callback.status(), StatusCode::SEE_OTHER);
        assert_eq!(tokens.load(Ordering::SeqCst), 1);
        let home = Url::parse(callback.headers()[header::LOCATION].to_str().unwrap()).unwrap();
        assert_eq!(home.origin().ascii_serialization(), "https://hub.example");
        assert!(home
            .query_pairs()
            .any(|(k, v)| k == "integration_state" && v == "state"));
        let handoff = home
            .query_pairs()
            .find(|(k, _)| k == "connection_code")
            .unwrap()
            .1
            .into_owned();
        assert!(!home.as_str().contains("provider-token"));

        // 3. The page redeems, signed with the user's key: the owner.
        let owner = Agent::new(61);
        let redeemed = redeem_as(&s, &owner, &handoff, &"a".repeat(43)).await;
        assert_eq!(redeemed.status(), StatusCode::OK);
        let redeemed = body_json(redeemed).await;
        let connection_id = redeemed["connection_id"].as_str().unwrap().to_owned();
        assert_eq!(redeemed["owner"], owner.id());

        // 4. The owner calls the provider through the proxy.
        let path = format!("/proxy/{connection_id}/github-issues/records");
        let call = crate::router(s.clone())
            .oneshot(signed_request(&s, &owner, "GET", &path, vec![]))
            .await
            .unwrap();
        assert_eq!(call.status(), StatusCode::OK);
        assert_eq!(
            body_json(call).await["authorization"],
            "Bearer provider-token"
        );

        // 5. The owner delegates to an app agent, which may then call too.
        let app = Agent::new(62);
        let delegation = crate::router(s.clone())
            .oneshot(signed_request(
                &s,
                &owner,
                "POST",
                &format!("/connections/{connection_id}/agents"),
                serde_json::json!({"agent": app.id(), "label": "Issue tracker"})
                    .to_string()
                    .into_bytes(),
            ))
            .await
            .unwrap();
        assert_eq!(delegation.status(), StatusCode::OK);
        let call = crate::router(s.clone())
            .oneshot(signed_request(&s, &app, "GET", &path, vec![]))
            .await
            .unwrap();
        assert_eq!(call.status(), StatusCode::OK);
        server.abort();
    }
}
